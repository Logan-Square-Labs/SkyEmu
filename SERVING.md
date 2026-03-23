# Serving SkyEmu Web Build

Build and serve SkyEmu locally so others can run it in their browser.

## Prerequisites

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) (`emcmake` on PATH)
- Python 3
- OpenSSL (for self-signed certificate generation)

## Usage

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

On startup, the server prints a URL with an embedded access token:

```
Serving SkyEmu at:

  https://0.0.0.0:8080/?token=<random-token>

Share this URL. The token is required for access.
```

## Options

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
- **HTTPS**: The server uses a self-signed TLS certificate (auto-generated in `build/`). Browsers will show a certificate warning on first visit — this is expected for self-signed certs.
- **Log safety**: Tokens are redacted from server logs.

## Sharing

Share the full URL (including the token) with anyone you want to grant access. The default host `0.0.0.0` makes the server accessible to other devices on your network — replace it with your machine's IP in the URL you share (e.g., `https://192.168.1.42:8080/?token=...`).
