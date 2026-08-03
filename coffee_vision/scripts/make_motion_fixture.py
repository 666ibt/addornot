"""Build a MOTION TEST FIXTURE that actually exercises the real pipeline.

The pure-shapes clip from ``make_synthetic.py`` proves the pipeline doesn't
crash, but real detectors (YOLO / MediaPipe Pose) see nothing in it, so it emits
no events. This script instead takes a **real public test image of a person**
and animates it (gentle pan + a waving arm crop) so that:

  * the object detector fires on "person" -> object events, and
  * MediaPipe Pose locks on and the wrist moves frame-to-frame -> motion ->
    non-idle action events.

It is still a **fixture**, NOT real coffee-shop footage — the person is a
generic public test image and the "coffee actions" are only inferred by the
zone/motion rules. The disclaimer is burned into every frame.

Source image: Ultralytics' bundled ``zidane.jpg`` test asset, fetched from
GitHub (an allowed host) and cached. Any other clear single/near person image
works too via --image.

    python -m scripts.make_motion_fixture --out data/motion_fixture.mp4
"""

from __future__ import annotations

import argparse
import math
import os
import urllib.request
from pathlib import Path

import cv2
import numpy as np

# A clear, real test image with people; used only as demo input, animated below.
DEFAULT_IMAGE_URL = (
    "https://raw.githubusercontent.com/ultralytics/ultralytics/main/"
    "ultralytics/assets/zidane.jpg"
)
CACHE = Path.home() / ".cache" / "coffee_vision"


def _fetch_image(url: str) -> np.ndarray:
    CACHE.mkdir(parents=True, exist_ok=True)
    dst = CACHE / Path(url).name
    if not dst.exists():
        print(f"downloading test image: {url}")
        urllib.request.urlretrieve(url, dst)  # goes through HTTPS_PROXY
    img = cv2.imread(str(dst))
    if img is None:
        raise RuntimeError(f"could not read image {dst}")
    return img


def make(out_path: str, image: str | None, seconds: int = 15, fps: int = 25):
    base = cv2.imread(image) if image else _fetch_image(DEFAULT_IMAGE_URL)
    if base is None:
        raise RuntimeError(f"could not read --image {image!r}")

    H, W = 540, 960
    # Fit the person into the frame (a bit smaller than full, leaving room to
    # translate them across all four zones without going fully off-screen).
    bh, bw = base.shape[:2]
    scale = min(H / bh, W / bw) * 0.8
    person = cv2.resize(base, (int(bw * scale), int(bh * scale)))
    ph, pw = person.shape[:2]

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (W, H))
    n = seconds * fps
    for i in range(n):
        t = i / fps
        # Large Lissajous translation so the person (and thus the wrist) sweeps
        # through every quadrant zone over the clip -> multiple zone-based action
        # types fire (grinder/group_head/steam_wand/counter), not just idle.
        cx = int((W - pw) / 2 + 0.42 * W * math.sin(2 * math.pi * t / 8.0))
        cy = int((H - ph) / 2 + 0.42 * H * math.sin(2 * math.pi * t / 5.0))
        # Extra fast shake during two windows to spike wrist-motion variance.
        if 3 < t < 6 or 9 < t < 12:
            cx += int(22 * math.sin(t * 30))
            cy += int(10 * math.cos(t * 30))

        frame = np.full((H, W, 3), 35, np.uint8)
        x0 = max(0, cx); y0 = max(0, cy)
        x1 = min(W, cx + pw); y1 = min(H, cy + ph)
        sx0 = x0 - cx; sy0 = y0 - cy
        if x1 > x0 and y1 > y0:  # paste the visible portion of the person
            frame[y0:y1, x0:x1] = person[sy0:sy0 + (y1 - y0), sx0:sx0 + (x1 - x0)]

        cv2.rectangle(frame, (0, H - 26), (W, H), (0, 0, 0), -1)
        cv2.putText(
            frame,
            "MOTION TEST FIXTURE - public test image, not real coffee footage",
            (8, H - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1, cv2.LINE_AA,
        )
        writer.write(frame)
    writer.release()
    print(f"Wrote {out_path} ({n} frames, {seconds}s @ {fps}fps)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/motion_fixture.mp4")
    ap.add_argument("--image", default=None, help="use a local image instead of the default")
    ap.add_argument("--seconds", type=int, default=15)
    ap.add_argument("--fps", type=int, default=25)
    a = ap.parse_args()
    make(a.out, a.image, a.seconds, a.fps)
