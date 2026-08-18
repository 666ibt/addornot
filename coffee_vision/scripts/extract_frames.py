"""Step 1 of training: pull frames out of your videos into the dataset.

    python -m scripts.extract_frames --source incoming/IMG_6936.mp4 --every 1.0
    python -m scripts.extract_frames --source incoming/ --every 2.0 --val-split 0.15

Frames are written to training/dataset/images/{train,val}. Extract broadly (a
frame every 1-2 s) so you get variety; you'll label them next. More frames with
phones/eating = better; if your phone incidents are rare, extract densely around
those timestamps with --start/--end.
"""
from __future__ import annotations
import argparse, random
from pathlib import Path
import cv2

ROOT = Path(__file__).resolve().parent.parent
IMG_TRAIN = ROOT / "training/dataset/images/train"
IMG_VAL = ROOT / "training/dataset/images/val"


def iter_videos(source: str):
    p = Path(source)
    if p.is_dir():
        for f in sorted(p.iterdir()):
            if f.suffix.lower() in {".mp4", ".mov", ".avi", ".mkv"}:
                yield f
    else:
        yield p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="video file or a directory of videos")
    ap.add_argument("--every", type=float, default=1.0, help="seconds between frames")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=0.0, help="0 = to end")
    ap.add_argument("--val-split", type=float, default=0.15)
    ap.add_argument("--max-frames", type=int, default=0, help="0 = no cap")
    args = ap.parse_args()

    IMG_TRAIN.mkdir(parents=True, exist_ok=True)
    IMG_VAL.mkdir(parents=True, exist_ok=True)
    random.seed(0)
    total = 0
    for vid in iter_videos(args.source):
        cap = cv2.VideoCapture(str(vid))
        if not cap.isOpened():
            print("skip (cannot open):", vid); continue
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        step = max(int(fps * args.every), 1)
        start_f = int(args.start * fps)
        end_f = int(args.end * fps) if args.end else 10**12
        idx = 0; saved = 0
        while True:
            ok, frame = cap.read()
            if not ok or idx > end_f:
                break
            if idx >= start_f and idx % step == 0:
                dst = IMG_VAL if random.random() < args.val_split else IMG_TRAIN
                name = f"{vid.stem}_{idx:06d}.jpg"
                cv2.imwrite(str(dst / name), frame)
                saved += 1; total += 1
                if args.max_frames and total >= args.max_frames:
                    break
            idx += 1
        cap.release()
        print(f"{vid.name}: saved {saved} frames")
    print(f"TOTAL frames: {total} (train={len(list(IMG_TRAIN.glob('*.jpg')))}, "
          f"val={len(list(IMG_VAL.glob('*.jpg')))})")


if __name__ == "__main__":
    main()
