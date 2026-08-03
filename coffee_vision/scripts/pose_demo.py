"""Step-3 smoke test: overlay MediaPipe Pose keypoints on a video.

    python -m scripts.pose_demo --source data/sample.mp4 --out out_pose.mp4

Prints how many frames had a pose / at least one wrist detected.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.pose import PoseEstimator  # noqa: E402
from src.video_source import VideoSource  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="data/sample.mp4")
    ap.add_argument("--out", default="out_pose.mp4")
    args = ap.parse_args()

    src = int(args.source) if str(args.source).isdigit() else args.source
    pose = PoseEstimator()

    with VideoSource(src) as vs:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(args.out, fourcc, vs.fps, vs.frame_size)
        frames = with_pose = with_wrist = 0
        for idx, ts, frame in vs.frames():
            res = pose.process(frame)
            pose.draw(frame, res)
            if res.raw_landmarks is not None:
                with_pose += 1
            if res.any_wrist is not None:
                with_wrist += 1
                wx, wy = res.any_wrist
                cv2.circle(frame, (int(wx), int(wy)), 8, (0, 0, 255), -1)
            writer.write(frame)
            frames += 1
        writer.release()
    pose.close()
    print(f"Frames: {frames} | with pose: {with_pose} | with wrist: {with_wrist} | wrote {args.out}")


if __name__ == "__main__":
    main()
