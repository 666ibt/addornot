"""Calibrate work zones by clicking 4 corners of each zone on the first frame.

Run:  python -m scripts.calibrate_zones --source data/sample.mp4
      python -m scripts.calibrate_zones --source 0        # webcam

For each zone (grinder, group_head, steam_wand, counter) click 4 points in
order. Press:
    u  — undo last point
    n  — skip current zone (leave it undefined)
    r  — restart current zone
    q  — quit without saving remaining zones
Result is written to config/zones.json.

Headless fallback: if no display is available (e.g. a server/CI), pass
--auto to write evenly-tiled default zones so the rest of the pipeline can run.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.zones import DEFAULT_ZONE_NAMES, Zones  # noqa: E402


def _grab_first_frame(source):
    src = int(source) if str(source).isdigit() else source
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open source {source!r}")
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError("Could not read a frame from the source")
    return frame


def _auto_zones(w, h):
    """Four quadrant zones — a sane default when clicking isn't possible."""
    mx, my = w // 2, h // 2
    quad = lambda x0, y0, x1, y1: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return {
        "grinder": quad(0, 0, mx, my),
        "group_head": quad(mx, 0, w, my),
        "steam_wand": quad(0, my, mx, h),
        "counter": quad(mx, my, w, h),
    }


def calibrate_interactive(frame):
    h, w = frame.shape[:2]
    polygons = {}
    win = "Calibrate zones — click 4 corners per zone"
    cv2.namedWindow(win)

    for name in DEFAULT_ZONE_NAMES:
        pts = []

        def on_mouse(event, x, y, flags, param):
            if event == cv2.EVENT_LBUTTONDOWN and len(pts) < 4:
                pts.append((x, y))

        cv2.setMouseCallback(win, on_mouse)
        while True:
            disp = frame.copy()
            cv2.putText(disp, f"Zone: {name}  ({len(pts)}/4)  [u]ndo [r]estart [n]ext [q]uit",
                        (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            for i, p in enumerate(pts):
                cv2.circle(disp, p, 5, (0, 0, 255), -1)
                if i > 0:
                    cv2.line(disp, pts[i - 1], p, (0, 0, 255), 2)
            if len(pts) == 4:
                cv2.line(disp, pts[3], pts[0], (0, 0, 255), 2)
            cv2.imshow(win, disp)
            key = cv2.waitKey(20) & 0xFF
            if key == ord("u") and pts:
                pts.pop()
            elif key == ord("r"):
                pts = []
            elif key == ord("n"):
                break
            elif key == ord("q"):
                cv2.destroyAllWindows()
                return polygons, (w, h)
            if len(pts) == 4:
                polygons[name] = [list(p) for p in pts]
                break
    cv2.destroyAllWindows()
    return polygons, (w, h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="data/sample.mp4")
    ap.add_argument("--out", default="config/zones.json")
    ap.add_argument("--auto", action="store_true",
                    help="write evenly-tiled default zones without a GUI")
    args = ap.parse_args()

    frame = _grab_first_frame(args.source)
    h, w = frame.shape[:2]

    if args.auto:
        polygons = _auto_zones(w, h)
        frame_size = (w, h)
    else:
        try:
            polygons, frame_size = calibrate_interactive(frame)
        except cv2.error:
            print("No display available — falling back to --auto tiled zones.")
            polygons, frame_size = _auto_zones(w, h), (w, h)

    if not polygons:
        print("No zones defined; nothing saved.")
        return

    zones = Zones(
        frame_size=frame_size,
        polygons={k: np.asarray(v, dtype=np.float32) for k, v in polygons.items()},
    )
    zones.save(args.out)
    print(f"Saved {len(polygons)} zone(s) to {args.out}: {list(polygons)}")


if __name__ == "__main__":
    main()
