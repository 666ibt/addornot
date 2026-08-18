"""Run the full pipeline on an arbitrary video and report results.

    python -m scripts.run_on_video --source incoming/clip.mp4

Outputs an annotated mp4 to outputs/, prints per-label object+action counts,
and dumps a few sample frames. Uses config/zones.json if present, else auto
quadrant zones so action rules still fire.
"""
from __future__ import annotations
import argparse, os, sys, time
from pathlib import Path
import cv2, numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.detector import ProductDetector
from src.pose import PoseEstimator
from src.action_recognizer import RuleBasedActionRecognizer
from src.events import EventStore
from src.pipeline import Pipeline
from src.video_source import VideoSource
from src.zones import Zones

def auto_zones(w, h):
    mx, my = w // 2, h // 2
    q = lambda a,b,c,d: np.array([[a,b],[c,b],[c,d],[a,d]], np.float32)
    return Zones((w, h), {"grinder":q(0,0,mx,my),"group_head":q(mx,0,w,my),
                          "steam_wand":q(0,my,mx,h),"counter":q(mx,my,w,h)})

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--max-seconds", type=float, default=0)
    ap.add_argument("--frames-dir", default="outputs/frames")
    a = ap.parse_args()

    stem = Path(a.source).stem
    out = a.out or f"outputs/{stem}_annotated.mp4"
    Path("outputs").mkdir(exist_ok=True); Path(a.frames_dir).mkdir(parents=True, exist_ok=True)

    vs = VideoSource(a.source)
    zp = Path("config/zones.json")
    zones = Zones.load(zp) if zp.exists() else auto_zones(*vs.frame_size)
    store = EventStore("outputs/run_events.db", session_id=stem)
    store.clear_session()
    det = ProductDetector()
    print("DETECTOR MODE:", det.mode)
    pipe = Pipeline(detector=det, pose=PoseEstimator(),
                    recognizer=RuleBasedActionRecognizer(fps=vs.fps),
                    zones=zones, store=store, fps=vs.fps)
    writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), vs.fps, vs.frame_size)
    maxf = int(a.max_seconds * vs.fps) if a.max_seconds else 10**9
    t0 = time.time(); n = 0; saved = []
    for idx, ts, frame in vs.frames():
        ann, res = pipe.process(idx, ts, frame)
        writer.write(ann); n += 1
        if idx in (0, maxf//4, maxf//2) or (n % max(int(vs.fps*3),1) == 0 and len(saved) < 4):
            fp = f"{a.frames_dir}/{stem}_{idx:05d}.png"; cv2.imwrite(fp, ann); saved.append(fp)
        if n >= maxf: break
    writer.release(); vs.release(); pipe.close()
    dt = time.time() - t0
    print(f"processed {n} frames in {dt:.1f}s ({n/max(dt,1e-6):.1f} fps) | video {vs.frame_size} @ {vs.fps:.0f}fps")
    print("OBJECT counts:", store.counts("object"))
    print("ACTION counts:", store.counts("action"))
    print("annotated ->", out)
    print("sample frames ->", saved)

if __name__ == "__main__":
    main()
