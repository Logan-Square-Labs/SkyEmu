#!/usr/bin/env bash
set -e

SESSION="skyemu"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RECORDINGS_DIR="${1:-$SCRIPT_DIR/recordings}"
RECORDINGS_DIR="${RECORDINGS_DIR/#\~/$HOME}"

mkdir -p "$RECORDINGS_DIR"

if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session '$SESSION' already exists. Attaching..."
    tmux attach-session -t "$SESSION"
    exit 0
fi

DOCKER_CMD="docker run --rm -p 8080:8080 -v \"$RECORDINGS_DIR:/skyemu-data/sessions\" -e RECORDINGS_DIR=/skyemu-data/sessions"
if [[ -n "$TOKEN" ]]; then
    DOCKER_CMD="$DOCKER_CMD -e TOKEN=$TOKEN"
fi
DOCKER_CMD="$DOCKER_CMD skyemu-web"

tmux new-session -d -s "$SESSION"

# Top pane: build (with cache), then run server
tmux send-keys -t "$SESSION:0.0" "docker build -t skyemu-web \"$SCRIPT_DIR\" && $DOCKER_CMD" Enter

# Bottom pane: Cloudflare tunnel
tmux split-window -t "$SESSION:0.0" -v
tmux send-keys -t "$SESSION:0.1" "cloudflared tunnel run skyemu" Enter

tmux attach-session -t "$SESSION"
