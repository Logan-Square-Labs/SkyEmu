// Per-session recorder worker.
//
// Lifecycle:
//   1. Main thread spawns `new Worker('recorder-worker.js')`.
//   2. Worker probes WebCodecs support, then awaits the first message:
//      a session-config object {romName, sessionUuid, width, height, fps, uploadUrl}.
//   3. Once configured, the worker posts {type:'recording_started'} and enters a
//      linear while loop pulling frame+action events off a tiny async queue.
//   4. Each event is {frameData: Uint8Array (RGBA), actionMask: uint8}.
//   5. On the null sentinel the loop exits; the final segment is flushed and
//      uploaded, then the worker calls self.close().
//
// Frame indices are segment-local (0-based inside each part). JSONL action
// lines carry `frame_index` (segment-local) and `timestamp_us` (exactly the
// VideoFrame.timestamp value used for that frame), so consumers can join the
// JSONL to the webm by either index or timestamp.

importScripts('webm-muxer.js');

const SOFT_BACKPRESSURE = 8;
const SEGMENT_FRAMES = 18000;

// Tiny async queue: push fills a pending pop or buffers; pop awaits a push.
const queue = (() => {
  const buf = [];
  let waiter = null;
  return {
    push(x) {
      if (waiter) { const w = waiter; waiter = null; w(x); }
      else buf.push(x);
    },
    pop() {
      return buf.length
        ? Promise.resolve(buf.shift())
        : new Promise((resolve) => { waiter = resolve; });
    },
  };
})();

self.onmessage = (e) => queue.push(e.data);

function actionStateFromMask(m) {
  return {
    a:      m & (1 << 0) ? 1 : 0,
    b:      m & (1 << 1) ? 1 : 0,
    up:     m & (1 << 2) ? 1 : 0,
    down:   m & (1 << 3) ? 1 : 0,
    left:   m & (1 << 4) ? 1 : 0,
    right:  m & (1 << 5) ? 1 : 0,
    start:  m & (1 << 6) ? 1 : 0,
    select: m & (1 << 7) ? 1 : 0,
  };
}

function postStatus(message) {
  self.postMessage({ type: 'status', message });
}

function getProbeCandidates(width, height, fps) {
  return [
    {
      config: {
        codec: 'vp8',
        width, height,
        bitrate: 1250000,
        bitrateMode: 'constant',
        framerate: fps,
        latencyMode: 'quality',
      },
      muxerCodec: 'V_VP8',
    },
    {
      config: {
        codec: 'vp09.00.10.08',
        width, height,
        bitrate: 1500000,
        bitrateMode: 'constant',
        framerate: fps,
        latencyMode: 'quality',
      },
      muxerCodec: 'V_VP9',
    },
  ];
}

async function probeEncoder() {
  if (typeof WebMMuxer === 'undefined') return null;
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;

  const candidates = getProbeCandidates(160, 144, 60);
  for (const candidate of candidates) {
    try {
      if (typeof VideoEncoder.isConfigSupported === 'function') {
        const support = await VideoEncoder.isConfigSupported(candidate.config);
        if (support && support.supported) return candidate;
        continue;
      }
      const probe = new VideoEncoder({ output() {}, error() {} });
      probe.configure(candidate.config);
      probe.close();
      return candidate;
    } catch (_) {
      // try next candidate
    }
  }
  return null;
}

function buildEncoderConfig(session) {
  return {
    codec: session.probe.config.codec,
    width: session.width,
    height: session.height,
    bitrate: session.probe.config.bitrate,
    bitrateMode: session.probe.config.bitrateMode,
    framerate: session.fps,
    latencyMode: 'quality',
  };
}

function getPartBaseName(session, partNumber) {
  return session.romName + '.' + session.sessionUuid + '.' + String(partNumber).padStart(4, '0');
}

function appendSegmentMeta(session) {
  session.actions.push(JSON.stringify({
    type: 'meta',
    rom: session.romName,
    session_uuid: session.sessionUuid,
    part_number: session.partNumber,
    fps: session.fps,
    width: session.width,
    height: session.height,
  }));
}

function createMuxerForPart(session) {
  session.muxerTarget = new WebMMuxer.ArrayBufferTarget();
  session.muxer = new WebMMuxer.Muxer({
    target: session.muxerTarget,
    firstTimestampBehavior: 'offset',
    video: {
      codec: session.probe.muxerCodec,
      width: session.width,
      height: session.height,
      frameRate: session.fps,
    },
  });
}

function startEncoderForPart(session) {
  createMuxerForPart(session);

  const muxer = session.muxer;
  const outputState = { acceptingOutput: true };
  session.outputState = outputState;
  session.firstChunkTs = null;

  session.encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!outputState.acceptingOutput) return;
      if (session.firstChunkTs === null) session.firstChunkTs = chunk.timestamp;
      muxer.addVideoChunk(chunk, meta, chunk.timestamp - session.firstChunkTs);
    },
    error: (error) => {
      if (!outputState.acceptingOutput) return;
      throw error;
    },
  });
  session.encoder.configure(buildEncoderConfig(session));
}

function prepareSegmentBuffers(session) {
  session.segmentFrameCount = 0;
  session.lastActionMask = -1;
  session.actions = [];
  session.muxer = null;
  session.muxerTarget = null;
  session.encoder = null;
  session.outputState = null;
  session.firstChunkTs = null;
  appendSegmentMeta(session);
}

function initSession(cfg, probe) {
  const session = {
    romName:    cfg.romName || 'gameboy',
    sessionUuid: cfg.sessionUuid,
    uploadUrl:  cfg.uploadUrl,
    width:      cfg.width,
    height:     cfg.height,
    fps:        cfg.fps || 60,
    probe,
    keyFrameInterval: Math.max(1, Math.round((cfg.fps || 60) * 5)),
    partNumber: 0,
    segmentFrameCount: 0,
    lastActionMask: -1,
    actions: [],
    muxer: null,
    muxerTarget: null,
    encoder: null,
    outputState: null,
    firstChunkTs: null,
  };
  prepareSegmentBuffers(session);
  startEncoderForPart(session);
  return session;
}

async function handleFrame(session, { frameData, actionMask }) {
  // Soft backpressure: let the encoder drain if it's falling behind.
  // Combined with latencyMode:'quality', the encoder never drops frames;
  // it queues internally and we yield so it can catch up.
  while (session.encoder.encodeQueueSize >= SOFT_BACKPRESSURE) {
    await new Promise((r) => setTimeout(r, 0));
  }

  const relIdx = session.segmentFrameCount;
  const tsUs  = Math.round(relIdx       * 1e6 / session.fps);
  const durUs = Math.round((relIdx + 1) * 1e6 / session.fps) - tsUs;

  const frame = new VideoFrame(frameData, {
    format: 'RGBA',
    codedWidth:  session.width,
    codedHeight: session.height,
    timestamp: tsUs,
    duration:  durUs,
  });
  try {
    session.encoder.encode(frame, {
      keyFrame: relIdx === 0 || (relIdx % session.keyFrameInterval) === 0,
    });
  } finally {
    frame.close();
  }

  if (actionMask !== session.lastActionMask) {
    session.actions.push(JSON.stringify({
      type: 'action_state',
      frame_index: relIdx,
      timestamp_us: tsUs,
      action_state: actionStateFromMask(actionMask),
    }));
    session.lastActionMask = actionMask;
  }

  session.segmentFrameCount += 1;
  if (session.segmentFrameCount === SEGMENT_FRAMES) {
    await rotateSegment(session);
  }
}

function buildPartData(session) {
  const partBaseName   = getPartBaseName(session, session.partNumber);
  const videoBlob      = new Blob([session.muxerTarget.buffer], { type: 'video/webm' });
  const jsonlText      = session.actions.length ? (session.actions.join('\n') + '\n') : '';
  const jsonlBlob      = new Blob([jsonlText], { type: 'application/x-ndjson' });
  return {
    videoBlob,
    jsonlBlob,
    videoFilename: partBaseName + '.webm',
    jsonlFilename: partBaseName + '.actions.jsonl',
  };
}

async function uploadPart(session, partData) {
  const formData = new FormData();
  formData.append('rom',          session.romName);
  formData.append('session_uuid', session.sessionUuid);
  formData.append('part_number',  String(session.partNumber));
  formData.append('start_frame',  '0'); // segment-local; kept for wire compatibility
  formData.append('fps',          String(session.fps));
  formData.append('video',   partData.videoBlob, partData.videoFilename);
  formData.append('actions', partData.jsonlBlob, partData.jsonlFilename);

  const response = await fetch(session.uploadUrl, {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  });
  if (!response.ok) {
    let bodyText = '';
    try { bodyText = await response.text(); } catch (_) {}
    throw new Error('Upload failed with status ' + response.status + (bodyText ? (': ' + bodyText) : ''));
  }
}

async function finishSegmentAndUpload(session) {
  // Flush delivers every submitted frame to the output callback before
  // resolving, so every chunk is handed to the muxer before finalize().
  await session.encoder.flush();
  session.muxer.finalize();
  if (session.outputState) session.outputState.acceptingOutput = false;
  try {
    if (session.encoder.state !== 'closed') session.encoder.close();
  } catch (_) { /* ignore */ }

  if (!session.muxerTarget.buffer) {
    throw new Error('Recorder muxer did not produce a segment buffer.');
  }

  const partData = buildPartData(session);
  try {
    await uploadPart(session, partData);
  } catch (error) {
    self.postMessage({
      type: 'download_fallback',
      videoBlob:     partData.videoBlob,
      videoFilename: partData.videoFilename,
      jsonlBlob:     partData.jsonlBlob,
      jsonlFilename: partData.jsonlFilename,
    });
    postStatus('Upload failed for part ' + String(session.partNumber).padStart(4, '0') + '; downloaded locally as fallback.');
  }

  session.encoder = null;
  session.muxer = null;
  session.muxerTarget = null;
  session.outputState = null;
}

async function rotateSegment(session) {
  await finishSegmentAndUpload(session);
  session.partNumber += 1;
  prepareSegmentBuffers(session);
  startEncoderForPart(session);
  postStatus('Recording part ' + String(session.partNumber).padStart(4, '0') + '...');
}

(async () => {
  try {
    const probe = await probeEncoder();
    if (!probe) {
      self.postMessage({ type: 'error', message: 'No supported WebCodecs WebM codec.' });
      self.close();
      return;
    }

    const cfg = await queue.pop();
    if (cfg === null) { self.close(); return; }

    const session = initSession(cfg, probe);
    self.postMessage({ type: 'recording_started' });
    postStatus('Recording part 0000...');

    while (true) {
      const ev = await queue.pop();
      if (ev === null) break;
      await handleFrame(session, ev);
    }

    await finishSegmentAndUpload(session);
    self.postMessage({ type: 'recording_stopped', message: 'Recording uploaded.' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  } finally {
    self.close();
  }
})();
