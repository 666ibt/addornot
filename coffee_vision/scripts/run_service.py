"""Headless 24/7 service: camera -> counting + activity -> SQLite -> Telegram.

    python -m scripts.run_service --url "rtsp://admin:PASS@192.168.0.135:554/Streaming/Channels/102"
    python -m scripts.run_service --source incoming_clean/clip.mp4 --once   # test on a file

What it does, forever:
  * reads the stream (auto-reconnecting when the camera drops);
  * counts products crossing the dispensing line -> `sale` events;
  * tracks worker activity and phone-on-workplace alerts;
  * at every shift change, sends the finished shift's report to Telegram.

Everything lands in events.db, so a restart never loses history and reports are
rebuilt from the database rather than from memory.

Run it without a display; use --preview to also write an annotated video.
"""
from __future__ import annotations

import argparse
import signal
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from src.activity import RuleBasedActivityRecognizer  # noqa: E402
from src.detector import ProductDetector  # noqa: E402
from src.events import EventStore  # noqa: E402
from src.line_counter import LineCounter  # noqa: E402
from src.notifier import TelegramNotifier, format_shift_report  # noqa: E402
from src.pipeline import Pipeline  # noqa: E402
from src.shifts import ShiftWatcher, shift_key, shift_name  # noqa: E402
from src.video_source import VideoSource, mask_url  # noqa: E402

_stop = False


def _handle_signal(signum, frame):
    global _stop
    print("\n[service] stopping…")
    _stop = True


def send_report(store: EventStore, notifier: TelegramNotifier, day: str, shift: int):
    sales = dict(store.counts_for_shift(day, shift, "sale"))
    acts = dict(store.counts_for_shift(day, shift, "activity"))
    alerts = dict(store.counts_for_shift(day, shift, "alert"))
    text = format_shift_report(day, shift_name(shift), sales, acts,
                               alerts.get("phone_on_workplace", 0))
    print("\n" + "=" * 50 + f"\n{text}\n" + "=" * 50)
    if notifier.enabled:
        print("[telegram] sent" if notifier.send(text) else "[telegram] FAILED")
    else:
        print("[telegram] not configured — report printed only "
              "(set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="RTSP URL")
    ap.add_argument("--source", help="video file or webcam index")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--phone-alert-seconds", type=float, default=45.0)
    ap.add_argument("--target-fps", type=float, default=6.0,
                    help="analytics FPS; lower = less CPU (detection is the cost)")
    ap.add_argument("--db", default=str(ROOT / "events.db"))
    ap.add_argument("--preview", help="also write an annotated mp4 here")
    ap.add_argument("--once", action="store_true",
                    help="process the source once and report, then exit (testing)")
    ap.add_argument("--report-now", action="store_true",
                    help="print/send the current shift's report and exit")
    a = ap.parse_args()

    store = EventStore(a.db, session_id="service")
    notifier = TelegramNotifier()

    if a.report_now:
        day, shift = shift_key()
        send_report(store, notifier, day, shift)
        return 0

    src = a.url or a.source
    if src is None:
        ap.error("give --url or --source")
    if isinstance(src, str) and src.isdigit():
        src = int(src)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    line = LineCounter.load(ROOT / "config" / "line.json")
    if line is None:
        line = LineCounter()  # default: horizontal at 55% height
        print("[service] no config/line.json — using a default horizontal line. "
              "Set it with:  python -m scripts.setup_line")
    print(f"[service] dispensing line {line.p1} -> {line.p2} ({line.direction})")

    print(f"[service] opening {mask_url(src)}")
    vs = VideoSource(src, target_fps=a.target_fps if not a.once else None)
    det = ProductDetector(conf=a.conf)
    print(f"[service] detector mode: {det.mode}")
    pipe = Pipeline(detector=det,
                    recognizer=RuleBasedActivityRecognizer(
                        fps=a.target_fps or vs.fps, phone_alert_seconds=a.phone_alert_seconds),
                    store=store, fps=a.target_fps or vs.fps,
                    phone_alert_seconds=a.phone_alert_seconds, line_counter=line)

    writer = None
    if a.preview:
        writer = cv2.VideoWriter(a.preview, cv2.VideoWriter_fourcc(*"mp4v"),
                                 max(a.target_fps, 1), vs.frame_size)

    watcher = ShiftWatcher()
    watcher.check()  # latch the current shift without reporting
    print(f"[service] running (shift {shift_name(shift_key()[1])}). Ctrl+C to stop.")

    n, t0, last_log = 0, time.time(), time.time()
    for idx, ts, frame in vs.frames():
        if _stop:
            break
        annotated, res = pipe.process(idx, ts, frame)
        n += 1
        if writer is not None:
            writer.write(annotated)

        ended = watcher.check()
        if ended:
            send_report(store, notifier, ended[0], ended[1])
            line.reset()  # counters restart with the new shift

        if time.time() - last_log > 60:
            last_log = time.time()
            print(f"[service] {datetime.now():%H:%M:%S} frames={n} "
                  f"({n/max(time.time()-t0,1):.1f} fps) sold={line.total} "
                  f"workers={len(res.activity.persons)}")

    if writer is not None:
        writer.release()
    vs.release()
    print(f"[service] processed {n} frames, sold={line.total} {dict(line.counts)}")
    if a.once:
        day, shift = shift_key()
        send_report(store, notifier, day, shift)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
