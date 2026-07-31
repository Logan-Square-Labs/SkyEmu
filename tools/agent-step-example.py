#!/usr/bin/env python3
"""Minimal example of the low-latency /agent_step HTTP Control Server loop.

Launch SkyEmu in headless HTTP mode first, for example:

  ./SkyEmu http_server 8080 /path/to/game.gb

Then run this script. Each /agent_step call applies an 8-bit GB action mask,
steps the emulator, and returns a 5760-byte packed 2-bit LCD frame.
"""

import urllib.request

hcs_url = "http://localhost:8080/"

# Bit order (LSB→MSB): A, B, Up, Down, Left, Right, Start, Select
ACTION_A = 1 << 0
ACTION_NONE = 0
BYTES_PER_FRAME = 5760


def agent_step(action=ACTION_NONE, frames=1):
  url = f"{hcs_url}agent_step?action={action}&frames={frames}"
  data = urllib.request.urlopen(url).read()
  if len(data) != BYTES_PER_FRAME:
    raise RuntimeError(f"unexpected frame size: {len(data)} (expected {BYTES_PER_FRAME})")
  return data


# Warm up a few frames with no input, then tap A every other step.
agent_step(ACTION_NONE, frames=60)
for i in range(10):
  action = ACTION_A if (i % 2) == 0 else ACTION_NONE
  frame = agent_step(action, frames=1)
  # frame[0] contains shades for the first four pixels (2 bits each, LSB-first).
  print(f"step={i} action={action} first_byte=0x{frame[0]:02x} bytes={len(frame)}")
