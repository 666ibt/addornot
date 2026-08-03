"""Generate a SYNTHETIC test fixture — NOT real coffee-shop footage.

This exists only so the pipeline can be smoke-tested (does it run end-to-end and
emit events?) when no real/licensed video is available. It draws moving shapes
that loosely stand in for "a hand" and "an object" on a table. Do NOT treat any
accuracy numbers from this clip as meaningful.

Usage:  python -m scripts.make_synthetic --out data/synthetic_test.mp4
"""

from __future__ import annotations

import argparse
import math

import cv2
import numpy as np


def make(out_path: str, seconds: int = 15, fps: int = 25, w: int = 960, h: int = 540):
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (w, h))
    n = seconds * fps
    for i in range(n):
        t = i / fps
        frame = np.full((h, w), 40, np.uint8)
        frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)

        # "counter" surface
        cv2.rectangle(frame, (0, int(h * 0.6)), (w, h), (60, 55, 50), -1)

        # A moving "object" (cup-ish rectangle) drifting across the counter.
        ox = int(w * 0.2 + (w * 0.5) * (0.5 + 0.5 * math.sin(t * 0.6)))
        oy = int(h * 0.62)
        cv2.rectangle(frame, (ox - 25, oy - 60), (ox + 25, oy), (230, 230, 235), -1)
        cv2.ellipse(frame, (ox, oy - 60), (25, 8), 0, 0, 360, (200, 200, 205), -1)

        # A "hand" (skin circle) that shakes rapidly during two windows to
        # simulate vigorous, repetitive motion (should trigger a motion action).
        shake = 18 * math.sin(t * 30) if (3 < t < 6 or 9 < t < 12) else 0
        hx = int(ox + shake)
        hy = int(oy - 80 + 6 * math.sin(t * 4))
        cv2.circle(frame, (hx, hy), 34, (150, 190, 240), -1)  # palm
        for a in range(5):  # crude fingers
            fa = -1.2 + a * 0.6
            fx = int(hx + 44 * math.cos(fa))
            fy = int(hy + 44 * math.sin(fa))
            cv2.circle(frame, (fx, fy), 10, (150, 190, 240), -1)

        cv2.putText(
            frame, "SYNTHETIC TEST FIXTURE - not real footage",
            (12, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2, cv2.LINE_AA,
        )
        writer.write(frame)
    writer.release()
    print(f"Wrote {out_path} ({n} frames, {seconds}s @ {fps}fps)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/synthetic_test.mp4")
    ap.add_argument("--seconds", type=int, default=15)
    ap.add_argument("--fps", type=int, default=25)
    make(ap.parse_args().out, ap.parse_args().seconds, ap.parse_args().fps)
