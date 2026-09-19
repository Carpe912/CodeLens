"""本地预览 CodeLens 前端构建产物的静态服务器（仅供验证 UI，不参与部署）。

为什么需要它：
- vite.config.ts 的 `base: '/code/'`，main.tsx 的路由 basename 也是 `/code`（PROD 时），
  所以必须按 /code/ 前缀提供文件；
- BrowserRouter 需要 SPA 兜底 —— `/code/repo/29` 这种路径必须回 index.html，
  `python3 -m http.server` 默认做不到。

用法：
  python3 scripts/preview/serve.py \
      [--root ../../dist-preview] [--port 4173]
  然后访问 http://127.0.0.1:4173/code/repo/29

⚠️ 只服务「预览产物」（dist-preview），永远不要把它指向要上线的 dist/，
   以免混淆「哪个目录是生产构建」。
"""
import argparse
import http.server
import os
import socketserver
import urllib.parse

p = argparse.ArgumentParser()
p.add_argument('--root', default=os.path.join(os.path.dirname(__file__), '..', '..', 'dist-preview'))
p.add_argument('--port', type=int, default=4173)
p.add_argument('--prefix', default='/code')
args = p.parse_args()

ROOT = os.path.abspath(args.root)
PREFIX = args.prefix


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def translate_path(self, path):
        path = urllib.parse.urlparse(path).path
        if path.startswith(PREFIX):
            path = path[len(PREFIX):] or '/'
        return super().translate_path(path)

    def send_head(self):
        fs_path = self.translate_path(self.path)
        ok = os.path.isfile(fs_path) or os.path.isfile(os.path.join(fs_path, 'index.html'))
        if not ok:
            self.path = PREFIX + '/index.html'   # SPA 兜底
        return super().send_head()

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
print(f'serving {ROOT} at http://127.0.0.1:{args.port}{PREFIX}/')
with socketserver.TCPServer(('127.0.0.1', args.port), Handler) as httpd:
    httpd.serve_forever()
