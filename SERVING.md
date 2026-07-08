# Serving SkyEmu Web Build

Build and serve SkyEmu locally so others can run it in their browser.

## Docker (recommended)

Only requires Docker — no Emscripten or Python install needed.

```bash
# Build the image (compiles the WASM binary inside the container)
docker build -t skyemu-web .

# Run it
docker run -p 8080:8080 skyemu-web

# Custom port
docker run -p 3000:8080 skyemu-web

# Fixed token (default is random each run)
docker run -p 8080:8080 -e TOKEN=mysecret skyemu-web
```

On startup, the container prints a URL with the access token:

```
Serving SkyEmu at:

  https://0.0.0.0:8080/?token=<random-token>

Share this URL. The token is required for access.
```

Replace `0.0.0.0` with your machine's IP when sharing (e.g., `https://192.168.1.42:8080/?token=...`).

## Without Docker

### Prerequisites

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) (`emcmake` on PATH)
- Python 3
- OpenSSL (for self-signed certificate generation)

### Usage

```bash
# Build and serve on https://0.0.0.0:8080
./serve.sh

# Custom host/port
./serve.sh --host 127.0.0.1 --port 3000

# Skip the build (serve a previous build)
./serve.sh --no-build

# Use a specific token instead of a random one
TOKEN=mysecret ./serve.sh
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `0.0.0.0` | Address to bind to. `0.0.0.0` exposes to the network. |
| `--port` | `8080` | Port to serve on. |
| `--no-build` | — | Skip the build step and serve the existing `build/bin/` output. |

| Env var | Default | Description |
|---------|---------|-------------|
| `TOKEN` | Random (generated each run) | Access token required in the URL query string. |

## Security

- **Token auth**: Every request must include `?token=<token>` in the URL. Requests without a valid token get a `403 Forbidden` response.
- **HTTPS**: The server uses a self-signed TLS certificate (auto-generated at startup). Browsers will show a certificate warning on first visit — this is expected for self-signed certs.
- **Log safety**: Tokens are redacted from server logs.

## Quick Start (tmux)

`./run.sh` opens a tmux session named `skyemu` with two panes:

- **Top**: Docker server on port 8080, with `./recordings/` mounted into the container so uploaded recordings persist on the host
- **Bottom**: Cloudflare tunnel (`cloudflared tunnel run skyemu`)

```bash
# Build the image first (if not already done)
docker build -t skyemu-web .

# Start both panes
./run.sh

# With a fixed token
TOKEN=mysecret ./run.sh
```

If a `skyemu` tmux session already exists, the script attaches to it instead of creating a new one.

## Cloudflare Tunnel

**tunnel command:** ```bash cloudflared tunnel run skyemu```