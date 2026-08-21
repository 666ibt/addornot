"""Check an IP camera before wiring it into the system.

    python -m scripts.test_camera --host 192.168.0.135 --password SECRET
    python -m scripts.test_camera --url "rtsp://admin:pass@192.168.0.135:554/..."
    python -m scripts.test_camera --host 192.168.0.135 --password SECRET --vendor dahua --main

Reports resolution/FPS, measures how many frames actually arrive, and saves a
snapshot to outputs/camera_test.jpg so you can confirm the view and pick where
the dispensing line should go.

Passwords are never printed back — only a masked URL.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from src.video_source import VideoSource, mask_url, rtsp_url  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="full RTSP URL (overrides the parts below)")
    ap.add_argument("--host", help="camera IP, e.g. 192.168.0.135")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="")
    ap.add_argument("--port", type=int, default=554)
    ap.add_argument("--vendor", default="hikvision", choices=["hikvision", "dahua"])
    ap.add_argument("--main", action="store_true",
                    help="use the main stream (default: substream, lighter)")
    ap.add_argument("--seconds", type=float, default=5.0)
    a = ap.parse_args()

    if a.url:
        url = a.url
    elif a.host:
        url = rtsp_url(a.host, a.password, a.user, a.port, a.vendor, substream=not a.main)
    else:
        ap.error("give --url or --host")

    print("connecting to:", mask_url(url))
    try:
        vs = VideoSource(url, reconnect=False)
    except RuntimeError as e:
        print("\n❌ FAILED to open the stream.")
        print("   ", e)
        print("\nChecklist:")
        print("  • camera reachable?  ping", a.host or "<ip>")
        print("  • user/password correct (Hikvision locks out after failed tries)")
        print("  • RTSP enabled on the camera, port 554 open")
        print("  • try the other stream: add --main (or drop it)")
        print("  • Dahua camera? add --vendor dahua")
        return 1

    print(f"✅ connected — {vs.width}x{vs.height} @ {vs.fps:.0f} fps reported")
    n = 0
    t0 = time.time()
    last = None
    while time.time() - t0 < a.seconds:
        ok, frame = vs.read()
        if not ok:
            break
        last = frame
        n += 1
    dt = time.time() - t0
    vs.release()

    if not n:
        print("❌ connected but no frames arrived — try the substream, or check bandwidth.")
        return 1
    print(f"✅ received {n} frames in {dt:.1f}s ({n/dt:.1f} fps actual)")
    out = ROOT / "outputs" / "camera_test.jpg"
    out.parent.mkdir(exist_ok=True)
    cv2.imwrite(str(out), last)
    print(f"✅ snapshot saved -> {out}")
    print("\nNext: set the dispensing line with")
    print("   python -m scripts.setup_line --url \"<your rtsp url>\"")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
