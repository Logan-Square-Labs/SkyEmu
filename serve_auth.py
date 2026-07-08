#!/usr/bin/env python3
"""Authenticated HTTP static file server for SkyEmu web builds."""

import http.server
import http.cookies
import cgi
import json
import os
import secrets
from urllib.parse import urlparse, parse_qs


class TokenAuthHandler(http.server.SimpleHTTPRequestHandler):
    token = None
    base_path = "/"
    session_secret = secrets.token_urlsafe(32)
    recordings_dir = "."

    def _get_session_cookie(self):
        cookie_header = self.headers.get("Cookie", "")
        cookies = http.cookies.SimpleCookie(cookie_header)
        morsel = cookies.get("session")
        return morsel.value if morsel else None

    def _set_session_cookie(self):
        self.send_header("Set-Cookie", f"session={self.session_secret}; Path=/; HttpOnly; SameSite=Lax")

    def _authenticate_request(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        provided = params.get("token", [None])[0]
        from_token = provided == self.token
        is_authorized = from_token or self._get_session_cookie() == self.session_secret
        return parsed, is_authorized, from_token

    def _send_json(self, status, payload, from_token=False):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        if from_token:
            self._set_session_cookie()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sanitize_name(self, value, fallback):
        text = (value or fallback).strip()
        sanitized = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in text).strip("_")
        return sanitized or fallback

    def _write_uploaded_file(self, field, destination_path):
        fileobj = getattr(field, "file", None)
        if fileobj is None:
            raise ValueError("upload field missing file object")
        with open(destination_path, "wb") as output_file:
            while True:
                chunk = fileobj.read(1024 * 1024)
                if not chunk:
                    break
                output_file.write(chunk)

    def do_GET(self):
        parsed, is_authorized, from_token = self._authenticate_request()

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

        if from_token:
            self.send_response(302)
            self._set_session_cookie()
            self.send_header("Location", self.base_path)
            self.end_headers()
        elif is_authorized:
            self.path = file_path
            super().do_GET()
        else:
            self.send_response(403)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"403 Forbidden: invalid or missing token")

    def do_POST(self):
        parsed, is_authorized, from_token = self._authenticate_request()
        path = parsed.path
        if not path.startswith(self.base_path):
            self._send_json(404, {"ok": False, "error": "Not found"}, from_token=from_token)
            return

        stripped = path[len(self.base_path):] or ""
        if stripped != "upload-recording":
            self._send_json(404, {"ok": False, "error": "Not found"}, from_token=from_token)
            return

        if not is_authorized:
            self._send_json(403, {"ok": False, "error": "Forbidden: invalid or missing token"})
            return

        try:
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                },
            )
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": "Invalid multipart form data", "detail": str(exc)}, from_token=from_token)
            return

        required_fields = ["rom", "session_uuid", "part_number", "start_frame", "fps"]
        missing_fields = [field for field in required_fields if field not in form or not form.getvalue(field)]
        if missing_fields:
            self._send_json(400, {"ok": False, "error": "Missing required fields", "missing": missing_fields}, from_token=from_token)
            return

        if "frames" not in form or "actions" not in form:
            self._send_json(400, {"ok": False, "error": "Missing required file fields: frames and actions"}, from_token=from_token)
            return

        try:
            part_number_int = int(str(form.getvalue("part_number")))
        except (TypeError, ValueError):
            self._send_json(400, {"ok": False, "error": "part_number must be an integer"}, from_token=from_token)
            return

        rom = self._sanitize_name(form.getvalue("rom"), "gameboy")
        session_uuid = self._sanitize_name(form.getvalue("session_uuid"), "session")
        part_number = f"{part_number_int:04d}"
        base_name = f"{rom}.{session_uuid}.{part_number}"
        frames_field = form["frames"]
        frames_filename = getattr(frames_field, "filename", None) or (base_name + ".frames.bin.gz")
        if frames_filename.endswith(".gz"):
            frames_path = os.path.join(self.recordings_dir, base_name + ".frames.bin.gz")
        else:
            frames_path = os.path.join(self.recordings_dir, base_name + ".frames.bin")
        actions_path = os.path.join(self.recordings_dir, base_name + ".actions.jsonl")

        try:
            self._write_uploaded_file(frames_field, frames_path)
            self._write_uploaded_file(form["actions"], actions_path)
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": "Failed to store upload", "detail": str(exc)}, from_token=from_token)
            return

        self._send_json(200, {
            "ok": True,
            "stored": [
                os.path.basename(frames_path),
                os.path.basename(actions_path),
            ],
        }, from_token=from_token)

    def log_message(self, format, *args):
        sanitized = [str(a).replace(self.token, "<token>") if self.token else str(a) for a in args]
        super().log_message(format, *sanitized)


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    token = os.environ.get("TOKEN", secrets.token_urlsafe(32))
    base_path = os.environ.get("BASE_PATH", "/").rstrip("/") + "/"
    serve_dir = os.environ.get("SERVE_DIR", ".")
    recordings_dir = os.path.abspath(os.environ.get("RECORDINGS_DIR", os.path.join(serve_dir, "recordings")))

    os.chdir(serve_dir)
    os.makedirs(recordings_dir, exist_ok=True)

    TokenAuthHandler.token = token
    TokenAuthHandler.base_path = base_path
    TokenAuthHandler.recordings_dir = recordings_dir

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
