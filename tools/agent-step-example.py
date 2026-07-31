#!/usr/bin/env python3
"""Minimal Game Boy agent loop using the /agent_step HTTP Control Server endpoint.

SkyEmu only loads ROMs from a local path. If the ROM lives in object storage
(e.g. an R2 `roms` bucket), download it first, then launch headless SkyEmu:

  ./SkyEmu http_server 8080 /path/to/game.gb

Then run this script against that server. Each /agent_step call applies an
8-bit GB action mask, steps the emulator, and returns a 5760-byte packed
2-bit LCD frame (gb_2bit_packed; see docs/SESSION_RECORDING.md).
"""

import json
import os
import urllib.request

hcs_url = os.environ.get("SKYEMU_HCS_URL", "http://localhost:8080").rstrip("/") + "/"

# Bit order (LSB→MSB): A, B, Up, Down, Left, Right, Start, Select
ACTION_A = 1 << 0
ACTION_B = 1 << 1
ACTION_UP = 1 << 2
ACTION_DOWN = 1 << 3
ACTION_LEFT = 1 << 4
ACTION_RIGHT = 1 << 5
ACTION_START = 1 << 6
ACTION_SELECT = 1 << 7
ACTION_NONE = 0
BYTES_PER_FRAME = 5760


def hcs_get(cmd):
  with urllib.request.urlopen(hcs_url + cmd, timeout=30) as resp:
    return resp.read(), resp.headers.get_content_type()


def agent_step(action=ACTION_NONE, frames=1):
  data, ctype = hcs_get(f"agent_step?action={action}&frames={frames}")
  if ctype != "application/octet-stream":
    raise RuntimeError(f"unexpected content-type {ctype!r}: {data[:200]!r}")
  if len(data) != BYTES_PER_FRAME:
    raise RuntimeError(f"unexpected frame size: {len(data)} (expected {BYTES_PER_FRAME})")
  return data


def shade_histogram(frame):
  hist = [0, 0, 0, 0]
  for byte in frame:
    for shift in (0, 2, 4, 6):
      hist[(byte >> shift) & 3] += 1
  return hist


pong, _ = hcs_get("ping")
# Text HCS responses are C strings and may include a trailing NUL byte.
if pong.split(b"\x00", 1)[0] != b"pong":
  raise RuntimeError(f"ping failed: {pong!r}")

status = json.loads(hcs_get("status")[0].split(b"\x00", 1)[0])
if not status.get("rom-loaded"):
  raise RuntimeError("no ROM loaded; start SkyEmu with http_server <port> <rom.gb>")
print(f"rom={status.get('rom-path')} mode={status.get('run-mode')}")

# Warm up, press Start briefly (menus / title), then walk right while sampling frames.
agent_step(ACTION_NONE, frames=60)
agent_step(ACTION_START, frames=2)
agent_step(ACTION_NONE, frames=60)

for i in range(5):
  frame = agent_step(ACTION_RIGHT, frames=30)
  hist = shade_histogram(frame)
  print(f"step={i} action={ACTION_RIGHT} bytes={len(frame)} shades={hist}")

agent_step(ACTION_NONE, frames=1)
print("done")
