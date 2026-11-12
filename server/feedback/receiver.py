#!/usr/bin/env python3
"""Flash feedback receiver. Stdlib only.

POST /flash-feedback  JSON {"message": str, "version": str, "os": str}
Each accepted message is written as one markdown file in INBOX_DIR.
Guards: 4 KB body cap, 2000 char message cap, per-IP and global rate limits.
Nothing from the client is trusted: fields are length-capped and stripped of
control characters, and file names are generated server-side.
"""
import json
import os
import re
import time
from collections import defaultdict, deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

INBOX_DIR = os.environ.get("INBOX_DIR", "/data/inbox")
PORT = int(os.environ.get("PORT", "8796"))
MAX_BODY = 4096
MAX_MESSAGE = 2000
PER_IP_PER_HOUR = 5
GLOBAL_PER_HOUR = 100
PATH = "/flash-feedback"

hits_by_ip = defaultdict(deque)
hits_all = deque()
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean(value, limit):
    if not isinstance(value, str):
        return ""
    return CTRL.sub("", value).strip()[:limit]


def allowed(ip):
    now = time.time()
    for q in (hits_by_ip[ip], hits_all):
        while q and now - q[0] > 3600:
            q.popleft()
    if len(hits_by_ip[ip]) >= PER_IP_PER_HOUR or len(hits_all) >= GLOBAL_PER_HOUR:
        return False
    hits_by_ip[ip].append(now)
    hits_all.append(now)
    return True


class Handler(BaseHTTPRequestHandler):
    server_version = "flash-feedback"

    def log_message(self, fmt, *args):
        pass

    def reply(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self):
        if self.path != PATH:
            return self.reply(404)
        ip = self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400)
        if length <= 0 or length > MAX_BODY:
            return self.reply(413)
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw)
        except ValueError:
            return self.reply(400)
        if not isinstance(data, dict):
            return self.reply(400)
        message = clean(data.get("message"), MAX_MESSAGE)
        if len(message) < 3:
            return self.reply(400)
        if not allowed(ip):
            return self.reply(429)
        version = clean(data.get("version"), 32)
        osname = clean(data.get("os"), 64)
        now = datetime.now()
        name = "%s_%s.md" % (now.strftime("%Y-%m-%d_%H-%M-%S"), os.urandom(3).hex())
        os.makedirs(INBOX_DIR, exist_ok=True)
        body = "---\nreceived: %s\nversion: %s\nos: %s\n---\n\n%s\n" % (
            now.isoformat(timespec="seconds"), version, osname, message)
        tmp = os.path.join(INBOX_DIR, "." + name)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body)
        os.replace(tmp, os.path.join(INBOX_DIR, name))
        self.reply(204)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
