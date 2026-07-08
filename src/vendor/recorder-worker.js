// Per-session recorder worker.
//
// Lifecycle:
//   1. Main thread spawns `new Worker('recorder-worker.js')`.
//   2. Worker awaits the first message: a session-config object
//      {romName, sessionUuid, width, height, fps, uploadUrl}.
//   3. Once configured, the worker posts {type:'recording_started'} and enters a
//      linear while loop pulling frame+action events off a tiny async queue.
//   4. Each event is {frameData: Uint8Array (packed 2-bit), actionMask: uint8}.
//   5. On the null sentinel the loop exits; the final segment is gzipped,
//      uploaded, then the worker calls self.close().
//
// Frame indices are segment-local (0-based inside each part). JSONL action
// lines carry `frame_index` (segment-local) and `timestamp_us`, so consumers
// can join the JSONL to the frame binary by either index or timestamp.

const SEGMENT_FRAMES = 18000;
const BYTES_PER_FRAME = (160 * 144 + 3) >> 2; // 5760

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

function getPartBaseName(session, partNumber) {
  return session.romName + '.' + session.sessionUuid + '.' + String(partNumber).padStart(4, '0');
}

function compressionSupported() {
  return typeof CompressionStream !== 'undefined';
}

async function gzipBytes(rawU8) {
  const stream = new Blob([rawU8]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function concatFrameChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
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
    pixel_format: 'gb_2bit_packed',
    bits_per_pixel: 2,
    bytes_per_frame: BYTES_PER_FRAME,
    packing: '4_pixels_per_uint8_msb_first_row_major',
    compression: session.compression,
  }));
}

function prepareSegmentBuffers(session) {
  session.segmentFrameCount = 0;
  session.lastActionMask = -1;
  session.actions = [];
  session.frameChunks = [];
  appendSegmentMeta(session);
}

function initSession(cfg) {
  const session = {
    romName:     cfg.romName || 'gameboy',
    sessionUuid: cfg.sessionUuid,
    uploadUrl:   cfg.uploadUrl,
    width:       cfg.width,
    height:      cfg.height,
    fps:         cfg.fps || 60,
    compression: compressionSupported() ? 'gzip' : 'none',
    partNumber:  0,
    segmentFrameCount: 0,
    lastActionMask: -1,
    actions: [],
    frameChunks: [],
  };
  prepareSegmentBuffers(session);
  return session;
}

function handleFrame(session, { frameData, actionMask }) {
  if (frameData.length !== BYTES_PER_FRAME) {
    throw new Error('Unexpected frame size: ' + frameData.length + ' (expected ' + BYTES_PER_FRAME + ')');
  }

  session.frameChunks.push(new Uint8Array(frameData));

  const relIdx = session.segmentFrameCount;
  const tsUs = Math.round(relIdx * 1e6 / session.fps);

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
    return rotateSegment(session);
  }
  return Promise.resolve();
}

async function buildPartData(session) {
  const partBaseName = getPartBaseName(session, session.partNumber);
  const rawBytes = concatFrameChunks(session.frameChunks);
  let framesBlob;
  let framesFilename;

  if (session.compression === 'gzip') {
    const gzipped = await gzipBytes(rawBytes);
    framesBlob = new Blob([gzipped], { type: 'application/gzip' });
    framesFilename = partBaseName + '.frames.bin.gz';
  } else {
    framesBlob = new Blob([rawBytes], { type: 'application/octet-stream' });
    framesFilename = partBaseName + '.frames.bin';
  }

  const jsonlText = session.actions.length ? (session.actions.join('\n') + '\n') : '';
  const jsonlBlob = new Blob([jsonlText], { type: 'application/x-ndjson' });
  return {
    framesBlob,
    jsonlBlob,
    framesFilename,
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
  formData.append('frames', partData.framesBlob, partData.framesFilename);
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
  if (session.segmentFrameCount === 0) return;

  const partData = await buildPartData(session);
  try {
    await uploadPart(session, partData);
  } catch (error) {
    self.postMessage({
      type: 'download_fallback',
      framesBlob:     partData.framesBlob,
      framesFilename: partData.framesFilename,
      jsonlBlob:      partData.jsonlBlob,
      jsonlFilename:  partData.jsonlFilename,
    });
    postStatus('Upload failed for part ' + String(session.partNumber).padStart(4, '0') + '; downloaded locally as fallback.');
  }

  session.frameChunks = [];
}

async function rotateSegment(session) {
  await finishSegmentAndUpload(session);
  session.partNumber += 1;
  prepareSegmentBuffers(session);
  postStatus('Recording part ' + String(session.partNumber).padStart(4, '0') + '...');
}

(async () => {
  try {
    const cfg = await queue.pop();
    if (cfg === null) { self.close(); return; }

    const session = initSession(cfg);
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
