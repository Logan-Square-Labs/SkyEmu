# Session Recording (Draft Outline)

> Ideation draft for how GB web session recording works today, and what a
> durable design doc should cover. Not yet a consumer-facing playback guide.

## 1. Purpose

Document the end-to-end path from a rendered Game Boy LCD frame to files on
disk under `recordings/`, so contributors can:

- understand capture, packaging, upload, and storage
- extend or debug the recorder without rediscovering wire formats
- plan playback / tooling against a stable contract

**Audience:** engineers working on the Emscripten build, serve stack, or
downstream consumers of recording artifacts.

**Out of scope (for now):** GBA/NDS recording, native desktop capture, TAS
replay via HCS (`tools/tas-example.py` is a separate control path).

---

## 2. One-paragraph summary

On the web build, Start Recording spawns a per-session Web Worker. Every
rendered GB frame is packed in the PPU as 2-bit LCD shades (before screen
ghosting), copied across WASM→JS, and transferred into the worker with the
current button mask. The worker accumulates ~18 000 frames per segment,
gzip-compresses the packed frame binary, writes a JSONL action log, and
POSTs both to `upload-recording`. The auth server stores
`{rom}.{session_uuid}.{part}.frames.bin.gz` and
`{rom}.{session_uuid}.{part}.actions.jsonl` under `RECORDINGS_DIR`.

---

## 3. Architecture

```text
┌──────────────────┐   render_frame    ┌─────────────────────┐
│  GB PPU (gb.h)   │ ────────────────► │ scratch.record_buffer│
│  sb_draw_pixel   │  2-bit packed     │ 5760 bytes / frame  │
└──────────────────┘                   └──────────┬──────────┘
                                                  │
                     EM_JS push_frame             ▼
┌──────────────────┐   HEAPU8.slice    ┌─────────────────────┐
│  main.c tick     │ ────────────────► │ shell.html          │
│  action mask     │                   │ skyemuRecorder      │
└──────────────────┘                   └──────────┬──────────┘
                                                  │ postMessage
                                                  │ (transferable)
                                                  ▼
                                       ┌─────────────────────┐
                                       │ recorder-worker.js  │
                                       │ segment · gzip · POST│
                                       └──────────┬──────────┘
                                                  │ multipart
                                                  ▼
                                       ┌─────────────────────┐
                                       │ serve_auth.py       │
                                       │ /upload-recording   │
                                       │ → RECORDINGS_DIR    │
                                       └─────────────────────┘
```

### Key files

| Layer | File | Role |
|-------|------|------|
| Capture | `src/gb.h` | `sb_record_pixel_2bit`, `record_buffer`, shade before ghosting |
| Bridge | `src/main.c` | `se_js_recorder_push_frame`, action mask, ROM name |
| UI / facade | `src/shell.html` | Start/Stop UI, worker lifecycle, upload URL, download fallback |
| Encode / upload | `src/vendor/recorder-worker.js` | Segment rotation, gzip, FormData POST |
| Storage | `serve_auth.py` | Auth’d `upload-recording`, writes under `RECORDINGS_DIR` |
| Ops | `SERVING.md`, `run.sh` | Docker mount of `./recordings/` |

---

## 4. Lifecycle

1. **Idle** — WASM runtime not ready → buttons disabled; status “Recorder loading…”.
2. **Start** — UI calls `skyemuRecorder.start()` → `new Worker('recorder-worker.js')` → first message is session config (`romName`, `sessionUuid`, `160×144`, `fps=60`, `uploadUrl`).
3. **Armed** — worker replies `recording_started`; facade sets `recording=true`.
4. **Capturing** — each `se_emulate_single_frame()` with `render_frame` pushes packed bytes + action mask (transferable `ArrayBuffer`).
5. **Segment rotate** — every `SEGMENT_FRAMES` (18000 ≈ 5 min @ 60 fps) the worker gzip+uploads part *N*, increments `partNumber`, resets buffers.
6. **Stop** — UI posts `null` sentinel → worker flushes final partial segment → `recording_stopped` → `self.close()`.
7. **Failure** — upload error → worker posts `download_fallback` with both blobs for local download; status notes the failure.

Open design question: should a failed mid-session upload abort recording, retry, or keep falling back to download for every subsequent part?

---

## 5. Frame capture details

### What is recorded

- **Resolution:** 160×144 (DMG/CGB LCD).
- **Pixel meaning:** post-palette **shade index** `0..3`, not RGB.
- **Timing in the pipeline:** written in `sb_draw_pixel` **after** palette lookup and **before** screen ghosting is applied to the RGBA framebuffer.
- **Packing:** 4 pixels per `uint8`, MSB-first, row-major.
  - Byte size: `(160*144 + 3) >> 2` = **5760**.
  - Pixel `i` → byte `i>>2`, shift `6 - ((i&3)<<1)`.
- **When pushed:** only when `emu_state.render_frame` is true (skipped frames are not recorded — intentional for “frame-exact” rendered output, not every emulated tick when frames are dropped for perf).

### Action mask

Bit order (LSB→MSB): `A, B, Up, Down, Left, Right, Start, Select`.

Sampled from `emu_state.joy.inputs[...]` at push time (`> 0.5f`).

### Action JSONL policy

Only **state changes** are logged (`action_state` lines). Unchanged masks produce no line. Each segment’s JSONL starts with a `meta` object describing format and packing.

---

## 6. On-disk / wire contract

### Filenames

```text
{rom}.{session_uuid}.{part:04d}.frames.bin.gz   # or .frames.bin if no CompressionStream
{rom}.{session_uuid}.{part:04d}.actions.jsonl
```

`rom` and `session_uuid` are sanitized to `[a-zA-Z0-9._-]`.

### Multipart fields (`POST …/upload-recording`)

| Field | Type | Notes |
|-------|------|--------|
| `rom` | text | sanitized basename |
| `session_uuid` | text | UUID (or fallback id) |
| `part_number` | text | integer; stored zero-padded |
| `start_frame` | text | currently always `"0"` (segment-local; wire compatibility) |
| `fps` | text | currently `60` |
| `frames` | file | gzip or raw packed frames |
| `actions` | file | NDJSON / JSONL |

Auth: same-origin cookie/`?token=` as the rest of `serve_auth.py`.

### JSONL shapes

**Meta (first line of each part):**

```json
{
  "type": "meta",
  "rom": "…",
  "session_uuid": "…",
  "part_number": 0,
  "fps": 60,
  "width": 160,
  "height": 144,
  "pixel_format": "gb_2bit_packed",
  "bits_per_pixel": 2,
  "bytes_per_frame": 5760,
  "packing": "4_pixels_per_uint8_msb_first_row_major",
  "compression": "gzip"
}
```

**Action change:**

```json
{
  "type": "action_state",
  "frame_index": 42,
  "timestamp_us": 700000,
  "action_state": {
    "a": 1, "b": 0, "up": 0, "down": 0,
    "left": 0, "right": 0, "start": 0, "select": 0
  }
}
```

`frame_index` and `timestamp_us` are **segment-local** (`timestamp_us = round(frame_index * 1e6 / fps)`).

### Joining frames ↔ actions

Consumers should:

1. gunzip (if `.gz`)
2. split into 5760-byte frames
3. join actions by `frame_index` (or by `timestamp_us` if preferred)

Global session timeline = concatenate parts in `part_number` order; add
`part_number * SEGMENT_FRAMES` to get a session-global index if needed.

---

## 7. Constants worth calling out

| Constant | Value | Where |
|----------|-------|--------|
| `SEGMENT_FRAMES` | 18000 | `recorder-worker.js` |
| `BYTES_PER_FRAME` | 5760 | worker + `(SB_LCD_W*SB_LCD_H+3)/4` in C |
| FPS (config) | 60 | shell + worker (not exact GB ~59.727) |
| GB only | — | `SYSTEM_GB` path in `se_emulate_single_frame` |

Open question: lock FPS to true GB rate for wall-clock sync, or keep 60 and
document the drift?

---

## 8. Ops / serving notes

- `RECORDINGS_DIR` defaults to `$SERVE_DIR/recordings`.
- `./run.sh` mounts host `./recordings/` into the Docker container so uploads persist.
- Upload failures do not block the session forever; they trigger browser downloads of that part.

---

## 9. Known limitations (candidates for “Caveats” section)

- **GB web only** — GBA/NDS frames are not captured.
- **Rendered frames only** — if the emulator skips `render_frame`, those ticks are absent from the recording.
- **No audio** in this format (WebM path removed).
- **No in-browser playback UI** yet — artifacts are for offline/tooling consumption.
- **CGB shades** — GBC path records `color_id & 0x3` style shade, not full RGB15; document intentional lossiness for size.
- **Ghosting not in recording** — by design; recorded shades are “clean” LCD indices.
- Historical note: older commits mention encoder queue / WebM frame drops; current path is lossless packed binary + gzip, so those encoder issues no longer apply — but upload/network failure still matters.

---

## 10. Proposed final doc shape

Suggested section order once this graduates from ideation:

1. **Overview** — one paragraph + when to use recordings
2. **Quick start** — Start/Stop in UI; where files land; env vars
3. **Architecture** — diagram + key files
4. **Capture pipeline** — PPU → WASM → JS → worker
5. **Binary format** — packing, sizes, gzip
6. **Actions JSONL** — schema, segment-local indices
7. **Upload API** — multipart contract + auth
8. **Segment lifecycle** — rotation, naming, fallback download
9. **Consuming recordings** — decode recipe / pseudocode
10. **Caveats & non-goals**
11. **Changelog / format version** — consider adding `format_version` to `meta`

Optional companion: a small Python decoder sketch under `tools/` (unpack
frames → PNG sequence; merge actions onto a timeline).

---

## 11. Open questions for the team

1. **Primary consumer?** Offline ML/dataset, human review, TAS reconstruction, or all three? That drives whether we need a player, RGB reconstruction rules, and audio later.
2. **Format versioning** — add `format_version` / `schema_version` to `meta` now before more consumers land?
3. **FPS contract** — keep `60` vs authentic GB refresh; document as authoritative for `timestamp_us`.
4. **Partial-frame / pause behavior** — should pause stop pushing, insert a marker, or record frozen frames?
5. **Retry policy** for failed uploads (see §4).
6. **CGB color fidelity** — is 2-bit shade enough forever, or do we need a parallel RGB/indexed mode for color titles?
7. **Where should this doc live long-term?** `docs/SESSION_RECORDING.md` (here) vs a short pointer from `SERVING.md` / README.

---

## 12. Suggested next edits

- [ ] Decide answers to §11 and fold into the narrative (remove “open questions” once settled).
- [ ] Add a minimal decode example (Python) proving the packing description.
- [ ] Cross-link from `SERVING.md` (“Uploaded recordings”).
- [ ] Optionally rename UI copy / status strings if “session recording” becomes the product term (today: “Start Recording”).
