#!/usr/bin/env python3
"""Authenticated HTTP static file server for SkyEmu web builds."""

import http.server
import http.cookies
import os
import secrets
from urllib.parse import urlparse, parse_qs


class TokenAuthHandler(http.server.SimpleHTTPRequestHandler):
    token = None
    base_path = "/"
    session_secret = secrets.token_urlsafe(32)

    def _get_session_cookie(self):
        cookie_header = self.headers.get("Cookie", "")
        cookies = http.cookies.SimpleCookie(cookie_header)
        morsel = cookies.get("session")
        return morsel.value if morsel else None

    def _set_session_cookie(self):
        self.send_header("Set-Cookie", f"session={self.session_secret}; Path=/; HttpOnly; SameSite=Lax")

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        provided = params.get("token", [None])[0]

        # Strip base path prefix to map to filesystem
        path = parsed.path
        if not path.startswith(self.base_path):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"404 Not Found")
            return

        # Remove prefix so file serving maps to the serve directory root
        stripped = path[len(self.base_path):] or ""
        file_path = "/" + stripped

        if provided == self.token:
            self.send_response(302)
            self._set_session_cookie()
            self.send_header("Location", self.base_path)
            self.end_headers()
        elif self._get_session_cookie() == self.session_secret:
            self.path = file_path
            super().do_GET()
        else:
            self.send_response(403)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"403 Forbidden: invalid or missing token")

    def log_message(self, format, *args):
        sanitized = [str(a).replace(self.token, "<token>") if self.token else str(a) for a in args]
        super().log_message(format, *sanitized)


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    token = os.environ.get("TOKEN", secrets.token_urlsafe(32))
    base_path = os.environ.get("BASE_PATH", "/").rstrip("/") + "/"
    serve_dir = os.environ.get("SERVE_DIR", ".")

    os.chdir(serve_dir)

    TokenAuthHandler.token = token
    TokenAuthHandler.base_path = base_path

    server = http.server.HTTPServer((host, port), TokenAuthHandler)

    url = f"http://{host}:{port}{base_path}?token={token}"
    print(f"\nServing SkyEmu at:\n\n  {url}\n")
    print("Share this URL. The token is required for access.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
