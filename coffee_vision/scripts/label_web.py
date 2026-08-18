"""Browser-based box labeler (no extra dependencies — stdlib http.server only).

    python -m scripts.label_web         # then open http://localhost:8000

Serves the extracted frames from training/dataset and lets you draw/adjust/delete
boxes in the browser; labels are written straight back to
training/dataset/labels/<split>/<img>.txt in YOLO format. Works in any modern
browser (Chrome/Firefox/Safari/Edge). Ctrl-C to stop.

Why a server (not a static file): a plain HTML page can't reliably read a folder
of images and write label files back. This local server does that file IO for the
page over http://localhost, which every browser trusts.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from training.classes import CLASSES  # noqa: E402

DS = ROOT / "training/dataset"
HTML = (ROOT / "training/labeler.html")
_NAME_RE = re.compile(r"^[\w.\-]+\.jpg$")


def _list_images():
    out = []
    for split in ("train", "val"):
        d = DS / "images" / split
        if d.is_dir():
            for p in sorted(d.glob("*.jpg")):
                lab = DS / "labels" / split / f"{p.stem}.txt"
                labeled = lab.exists() and lab.stat().st_size > 0
                out.append({"split": split, "name": p.name, "labeled": labeled})
    return out


def _safe(split: str, name: str):
    if split not in ("train", "val") or not _NAME_RE.match(name or ""):
        return None
    return split, name


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        if u.path in ("/", "/index.html"):
            return self._send(200, HTML.read_bytes(), "text/html; charset=utf-8")
        if u.path == "/api/config":
            return self._send(200, json.dumps(
                {"classes": CLASSES, "images": _list_images()}).encode())
        if len(parts) == 3 and parts[0] == "img":
            sp = _safe(parts[1], parts[2])
            if sp:
                f = DS / "images" / sp[0] / sp[1]
                if f.exists():
                    return self._send(200, f.read_bytes(), "image/jpeg")
            return self._send(404, b"{}")
        if len(parts) == 3 and parts[0] == "label":
            sp = _safe(parts[1], parts[2].replace(".txt", ".jpg"))
            if sp:
                lab = DS / "labels" / sp[0] / f"{Path(sp[1]).stem}.txt"
                txt = lab.read_text() if lab.exists() else ""
                return self._send(200, txt.encode(), "text/plain")
        return self._send(404, b"{}")

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) == 3 and parts[0] == "label":
            sp = _safe(parts[1], parts[2].replace(".txt", ".jpg"))
            if sp:
                n = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(n).decode()
                lab = DS / "labels" / sp[0] / f"{Path(sp[1]).stem}.txt"
                lab.parent.mkdir(parents=True, exist_ok=True)
                lab.write_text(body)
                return self._send(200, b'{"ok":true}')
        return self._send(404, b"{}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    if not (DS / "images/train").exists() or not any((DS / "images/train").glob("*.jpg")):
        print("No images found. Run:  python -m scripts.extract_frames --source incoming/")
        return
    if not HTML.exists():
        print("Missing", HTML); return
    n = len(_list_images())
    print(f"Labeler serving {n} images at  http://localhost:{a.port}")
    print("Open that URL in your browser. Ctrl-C to stop.")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
