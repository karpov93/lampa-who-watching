#!/usr/bin/env python3
"""Локальный стенд для разработки.

    python tools/serve.py [порт]

Отдаёт файлы репозитория и перенаправляет `/` на `dev/preview.html`, чтобы
не приходилось помнить длинный путь. Плагин при этом доступен по адресу
`http://127.0.0.1:<порт>/who-watching.js` — его и добавляют в «Расширения»
Lampa при проверке на живом приложении.
"""

import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            self.send_response(302)
            self.send_header('Location', '/dev/preview.html')
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    with socketserver.TCPServer(('0.0.0.0', PORT), Handler) as httpd:
        print('стенд:  http://127.0.0.1:%d/dev/preview.html' % PORT)
        print('плагин: http://127.0.0.1:%d/who-watching.js' % PORT)
        httpd.serve_forever()
