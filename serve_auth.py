#!/usr/bin/env python3
"""Authenticated HTTPS static file server for SkyEmu web builds."""

import http.server
import ssl
import os
import secrets
import subprocess
import sys
import tempfile
from urllib.parse import urlparse, parse_qs


def generate_self_signed_cert(cert_dir):
    cert_file = os.path.join(cert_dir, "cert.pem")
    key_file = os.path.join(cert_dir, "key.pem")
    if not os.path.exists(cert_file) or not os.path.exists(key_file):
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048",
                "-keyout", key_file, "-out", cert_file,
                "-days", "365", "-nodes",
                "-subj", "/CN=localhost",
            ],
            check=True,
            capture_output=True,
        )
    return cert_file, key_file


class TokenAuthHandler(http.server.SimpleHTTPRequestHandler):
    token = None

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        provided = params.get("token", [None])[0]

        if provided != self.token:
            self.send_response(403)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"403 Forbidden: invalid or missing token")
            return

        # Strip token from path so file serving works normally
        self.path = parsed.path
        super().do_GET()

    def log_message(self, format, *args):
        # Suppress token from logs
        sanitized = [str(a).replace(self.token, "<token>") if self.token else str(a) for a in args]
        super().log_message(format, *sanitized)


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    token = os.environ.get("TOKEN", secrets.token_urlsafe(32))
    serve_dir = os.environ.get("SERVE_DIR", ".")

    os.chdir(serve_dir)

    # Generate self-signed cert in a temp directory (or reuse from build dir)
    cert_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build")
    os.makedirs(cert_dir, exist_ok=True)
    cert_file, key_file = generate_self_signed_cert(cert_dir)

    TokenAuthHandler.token = token

    server = http.server.HTTPServer((host, port), TokenAuthHandler)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert_file, key_file)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)

    url = f"https://{host}:{port}/?token={token}"
    print(f"\nServing SkyEmu at:\n\n  {url}\n")
    print("Share this URL. The token is required for access.")
    print("(Your browser will warn about the self-signed certificate — this is expected.)\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
