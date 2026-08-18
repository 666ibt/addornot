"""Run the worker-activity pipeline on a video and report results.

    python -m scripts.run_on_video --source incoming/clip.mp4 [--max-seconds N]

Outputs an annotated mp4 to outputs/, prints object / activity / alert summaries,
and dumps a few sample frames.
"""
from __future__ import annotations
import argparse, sys, time
from pathlib import Path
import cv2
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.detector import ProductDetector
from src.activity import RuleBasedActivityRecognizer
from src.events import EventStore
from src.pipeline import Pipeline
from src.video_source import VideoSource


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--max-seconds", type=float, default=0)
    ap.add_argument("--start-seconds", type=float, default=0)
    ap.add_argument("--conf", type=float, default=0.2)
    ap.add_argument("--phone-alert-seconds", type=float, default=45.0)
    ap.add_argument("--frames-dir", default="outputs/frames")
    a = ap.parse_args()

    stem = Path(a.source).stem
    out = a.out or f"outputs/{stem}_activity.mp4"
    Path("outputs").mkdir(exist_ok=True)
    Path(a.frames_dir).mkdir(parents=True, exist_ok=True)

    vs = VideoSource(a.source)
    if a.start_seconds:
        vs.cap.set(cv2.CAP_PROP_POS_FRAMES, int(a.start_seconds * vs.fps))
    store = EventStore("outputs/run_events.db", session_id=stem)
    store.clear_session()
    det = ProductDetector(conf=a.conf)
    print("DETECTOR MODE:", det.mode)
    rec = RuleBasedActivityRecognizer(fps=vs.fps, phone_alert_seconds=a.phone_alert_seconds)
    pipe = Pipeline(detector=det, recognizer=rec, store=store, fps=vs.fps,
                    phone_alert_seconds=a.phone_alert_seconds)

    writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), vs.fps, vs.frame_size)
    maxf = int(a.max_seconds * vs.fps) if a.max_seconds else 10**9
    t0 = time.time(); n = 0; saved = []
    for idx, ts, frame in vs.frames():
        ann, res = pipe.process(idx, ts + a.start_seconds, frame)
        writer.write(ann); n += 1
        if n % max(int(vs.fps * 4), 1) == 0 and len(saved) < 6:
            fp = f"{a.frames_dir}/{stem}_{n:05d}.png"; cv2.imwrite(fp, ann); saved.append(fp)
        if n >= maxf:
            break
    writer.release(); vs.release()
    dt = time.time() - t0
    print(f"processed {n} frames in {dt:.1f}s ({n/max(dt,1e-6):.1f} fps) | {vs.frame_size} @ {vs.fps:.0f}fps")
    print("OBJECT counts:", store.counts("object"))
    print("ACTIVITY changes:", store.counts("activity"))
    print("ALERTS:", store.counts("alert"))
    for r in store.recent(200, event_types=["alert"])[::-1]:
        print(f"  ALERT t={r['video_ts']:.1f}s  {r['label']}  {r['detail']}  ({r['duration']:.0f}s)")
    print("annotated ->", out, "| frames ->", saved)


if __name__ == "__main__":
    main()
