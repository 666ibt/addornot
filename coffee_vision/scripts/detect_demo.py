"""Step-2 smoke test: run YOLO-World on a video, draw boxes, save annotated mp4.

    python -m scripts.detect_demo --source data/sample.mp4 --out out_detect.mp4

Prints how many detections were produced so you can confirm boxes actually
appear (non-empty result).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.detector import ProductDetector  # noqa: E402
from src.video_source import VideoSource  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="data/sample.mp4")
    ap.add_argument("--out", default="out_detect.mp4")
    ap.add_argument("--max-frames", type=int, default=0, help="0 = all")
    args = ap.parse_args()

    src = int(args.source) if str(args.source).isdigit() else args.source
    det = ProductDetector()

    with VideoSource(src) as vs:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(args.out, fourcc, vs.fps, vs.frame_size)
        total = 0
        frames = 0
        for idx, ts, frame in vs.frames():
            dets = det.track(frame)
            total += len(dets)
            for d in dets:
                x1, y1, x2, y2 = d.box
                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 200, 0), 2)
                cv2.putText(frame, f"{d.label} {d.confidence:.2f}",
                            (x1, max(y1 - 6, 12)), cv2.FONT_HERSHEY_SIMPLEX,
                            0.5, (0, 200, 0), 1, cv2.LINE_AA)
            writer.write(frame)
            frames += 1
            if args.max_frames and frames >= args.max_frames:
                break
        writer.release()

    print(f"Frames: {frames} | total detections: {total} | "
          f"avg/frame: {total / max(frames,1):.2f} | wrote {args.out}")


if __name__ == "__main__":
    main()
