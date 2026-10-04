#!/usr/bin/env python3
"""Dev server for the sim: same as `python3 -m http.server`, but forces
no-cache headers so edited .js/.css files always show up on a normal
refresh instead of getting stuck on a stale cached ES module.

Also exposes a tiny bridge API for ../agent/roach_tip_agent.py (a separate
Python process -- it has no other way to reach the browser-only sim):

  POST /api/report  {x, z, name, zh}  -- stash a tip the agent parsed
  GET  /api/poll                      -- sim/js/main.js polls this; returns
                                         the pending tip once and clears it,
                                         or {} if there isn't one

Single pending tip, no auth, no persistence -- this is a local hackathon
demo bridge, not a real API.
"""
import http.server
import json
import sys

_pending_tip = None  # module-level: http.server.test() runs single-threaded, so no locking needed


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/poll':
            global _pending_tip
            tip, _pending_tip = _pending_tip, None
            self._send_json(200, tip or {})
            return
        super().do_GET()

    def do_POST(self):
        if self.path == '/api/report':
            global _pending_tip
            try:
                length = int(self.headers.get('Content-Length', 0))
                tip = json.loads(self.rfile.read(length))
                assert 'x' in tip and 'z' in tip
            except Exception as e:
                self._send_json(400, {'error': str(e)})
                return
            _pending_tip = tip
            self._send_json(200, {'ok': True})
            return
        self._send_json(404, {'error': 'not found'})


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    http.server.test(HandlerClass=NoCacheHandler, port=port)
