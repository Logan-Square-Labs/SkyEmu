#!/usr/bin/env bash
set -e

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8080}"
BUILD=true

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --host) HOST="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --no-build) BUILD=false; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if $BUILD; then
  mkdir -p build && cd build
  emcmake cmake .. -DPLATFORM=Web
  cmake --build .
  cp bin/SkyEmu.html bin/index.html
  cd bin
else
  cd build/bin
fi

# Serve
SERVE_DIR="$(pwd)" HOST="$HOST" PORT="$PORT" python3 "$(dirname "$0")/serve_auth.py"
