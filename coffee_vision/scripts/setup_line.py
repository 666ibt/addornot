"""Place the virtual dispensing line for your camera.

    python -m scripts.setup_line --source incoming_clean/clip.mp4     # click 2 points
    python -m scripts.setup_line --url "rtsp://..."                   # live camera
    python -m scripts.setup_line --source clip.mp4 --coords 0,0.55,1,0.55   # no GUI

Click the two ends of the pickup edge (where a finished drink leaves the bar).
Saved to config/line.json and picked up automatically by the app and the service.

Keys: click twice to set · r reset · d cycle direction · s save · q quit
Coordinates are stored normalised (0..1), so the line still fits if you switch
between the main stream and the substream.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from src.line_counter import LineCounter  # noqa: E402
from src.video_source import VideoSource, mask_url  # noqa: E402

CONFIG = ROOT / "config" / "line.json"
DIRECTIONS = ["both", "positive", "negative"]


def first_frame(src):
    vs = VideoSource(src, reconnect=False)
    ok, frame = vs.read()
    vs.release()
    if not ok:
        raise RuntimeError(f"no frame from {mask_url(src)}")
    return frame


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", help="video file or webcam index")
    ap.add_argument("--url", help="RTSP URL")
    ap.add_argument("--coords", help="x1,y1,x2,y2 normalised 0..1 — skips the GUI")
    ap.add_argument("--direction", default="both", choices=DIRECTIONS)
    a = ap.parse_args()

    if a.coords:
        try:
            x1, y1, x2, y2 = [float(v) for v in a.coords.split(",")]
        except ValueError:
            ap.error("--coords needs 4 numbers, e.g. 0,0.55,1,0.55")
        lc = LineCounter(p1=(x1, y1), p2=(x2, y2), direction=a.direction)
        lc.save(CONFIG)
        print(f"saved line {lc.p1} -> {lc.p2} (direction={lc.direction}) to {CONFIG}")
        return 0

    src = a.url or a.source
    if src is None:
        ap.error("give --source, --url, or --coords")
    if isinstance(src, str) and src.isdigit():
        src = int(src)
    frame = first_frame(src)
    h, w = frame.shape[:2]
    pts, direction = [], a.direction

    def on_mouse(ev, x, y, flags, param):
        if ev == cv2.EVENT_LBUTTONDOWN:
            if len(pts) >= 2:
                pts.clear()
            pts.append((x, y))

    win = "Dispensing line — click 2 points | r reset  d direction  s save  q quit"
    try:
        cv2.namedWindow(win)
        cv2.setMouseCallback(win, on_mouse)
    except cv2.error:
        print("No display available. Use --coords, e.g.:")
        print("   python -m scripts.setup_line --source clip.mp4 --coords 0,0.55,1,0.55")
        return 1

    while True:
        disp = frame.copy()
        for p in pts:
            cv2.circle(disp, p, 6, (0, 0, 255), -1)
        if len(pts) == 2:
            cv2.line(disp, pts[0], pts[1], (0, 255, 255), 2)
        cv2.rectangle(disp, (0, 0), (disp.shape[1], 26), (0, 0, 0), -1)
        cv2.putText(disp, f"points {len(pts)}/2   direction={direction}   s=save q=quit",
                    (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 1)
        cv2.imshow(win, disp)
        k = cv2.waitKey(20) & 0xFF
        if k == ord("r"):
            pts.clear()
        elif k == ord("d"):
            direction = DIRECTIONS[(DIRECTIONS.index(direction) + 1) % len(DIRECTIONS)]
        elif k == ord("q"):
            cv2.destroyAllWindows()
            print("quit without saving")
            return 0
        elif k == ord("s"):
            if len(pts) != 2:
                print("need 2 points first")
                continue
            lc = LineCounter(p1=(pts[0][0] / w, pts[0][1] / h),
                             p2=(pts[1][0] / w, pts[1][1] / h), direction=direction)
            lc.save(CONFIG)
            cv2.destroyAllWindows()
            print(f"saved line to {CONFIG} (direction={direction})")
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
