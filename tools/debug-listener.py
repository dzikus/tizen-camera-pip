#!/usr/bin/env python3
"""
Tiny HTTP sink for the app's diagnostics.

Samsung closes `sdb shell` on some TV models in ordinary developer mode, which
leaves no `dlog` and no Web Inspector. The app POSTs its state here instead. Set
`debugUrl` in app/config.yaml to http://<this-host>:8099/log and run this while
testing.

    python3 tools/debug-listener.py [port]
"""

import json
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        stamp = datetime.now().strftime("%H:%M:%S")
        try:
            print(f"\n=== {stamp} ===")
            print(json.dumps(json.loads(raw), indent=2, ensure_ascii=False))
        except ValueError:
            print(f"\n=== {stamp} === (raw)\n{raw}")
        sys.stdout.flush()
        self.send_response(204)
        self._cors()
        self.end_headers()

    do_GET = do_POST

    def log_message(self, *args):
        pass  # keep the output to just the payloads


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    print(f"listening on 0.0.0.0:{port} - point debugUrl in config.yaml here")
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()
