"""End-to-end per-frame pipeline: detect -> per-worker activity -> overlay + events.

    pipe = Pipeline(store=EventStore(...), fps=src.fps)
    for idx, ts, frame in src.frames():
        annotated, result = pipe.process(idx, ts, frame)

No pose skeleton, no manual zones — activities come from the objects associated
with each tracked worker (see src/activity.py).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple

import cv2
import numpy as np

from .activity import (
    ActivityFrameResult,
    ActivityRecognizer,
    PersonActivity,
    RuleBasedActivityRecognizer,
    category_of,
)
from .detector import Detection, ProductDetector
from .events import Event, EventStore
from .line_counter import LineCounter

# BGR color per activity.
_ACT_COLOR = {
    "using_phone": (60, 60, 235),
    "eating": (0, 165, 255),
    "making_drink": (80, 200, 80),
    "working": (220, 160, 60),
    "idle": (150, 150, 150),
}
_OBJ_COLOR = {"phone": (60, 60, 235), "food": (0, 165, 255), "drink": (80, 200, 80)}


@dataclass
class FrameResult:
    detections: List[Detection]
    activity: ActivityFrameResult
    active_alerts: List[str]
    sales: Optional[dict] = None   # label -> count since start (line counter)


class Pipeline:
    def __init__(
        self,
        detector: Optional[ProductDetector] = None,
        recognizer: Optional[ActivityRecognizer] = None,
        store: Optional[EventStore] = None,
        fps: float = 15.0,
        phone_alert_seconds: float = 45.0,
        line_counter: Optional[LineCounter] = None,
    ) -> None:
        self.detector = detector if detector is not None else ProductDetector()
        self.recognizer = (
            recognizer if recognizer is not None
            else RuleBasedActivityRecognizer(fps=fps, phone_alert_seconds=phone_alert_seconds)
        )
        self.store = store
        # Optional: count products crossing the dispensing line.
        self.line_counter = line_counter
        self._seen_obj_tracks: set = set()

    def process(self, frame_index: int, video_ts: float, frame_bgr: np.ndarray):
        detections = self.detector.track(frame_bgr)
        persons = [d for d in detections if d.label == "person"]
        objects = [d for d in detections if d.label != "person"]

        result = self.recognizer.update(frame_index, video_ts, persons, objects)

        # -- dispensing line: products handed out --
        crossings = []
        if self.line_counter is not None:
            h, w = frame_bgr.shape[:2]
            crossings = self.line_counter.update(objects, video_ts, (w, h))

        # -- events --
        if self.store is not None:
            for c in crossings:
                self.store.log(Event("sale", c.label, track_id=c.track_id,
                                     video_ts=video_ts,
                                     detail=f"crossed line (dir {c.direction})"))
            for d in detections:
                if d.track_id is not None and d.track_id not in self._seen_obj_tracks:
                    self._seen_obj_tracks.add(d.track_id)
                    self.store.log(Event("object", d.label, track_id=d.track_id,
                                         confidence=d.confidence, video_ts=video_ts))
            for ev in result.events:
                self.store.log(Event(ev.event_type, ev.label, track_id=ev.track_id,
                                     duration=ev.duration, detail=ev.detail,
                                     video_ts=video_ts))

        active_alerts = [f"#{p.track_id} phone {int(p.phone_seconds)}s"
                         for p in result.persons if p.phone_alert]
        annotated = self._draw(frame_bgr, objects, result, active_alerts)
        sales = dict(self.line_counter.counts) if self.line_counter else None
        return annotated, FrameResult(detections, result, active_alerts, sales)

    # -- drawing ----------------------------------------------------------
    def _draw(self, frame, objects, result: ActivityFrameResult, alerts):
        out = frame.copy()

        # objects of interest (phone/food/drink) — thin highlight
        for o in objects:
            cat = category_of(o.label)
            if cat is None:
                continue
            x1, y1, x2, y2 = o.box
            col = _OBJ_COLOR.get(cat, (200, 200, 200))
            cv2.rectangle(out, (x1, y1), (x2, y2), col, 1)
            cv2.putText(out, o.label, (x1, max(y1 - 4, 10)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, col, 1, cv2.LINE_AA)

        # persons with activity label + phone timer
        for p in result.persons:
            x1, y1, x2, y2 = p.box
            col = _ACT_COLOR.get(p.activity, (200, 200, 200))
            thick = 3 if p.phone_alert else 2
            cv2.rectangle(out, (x1, y1), (x2, y2), col, thick)
            tag = f"#{p.track_id} {p.activity}"
            cv2.rectangle(out, (x1, y1 - 20), (x1 + 11 * len(tag), y1), col, -1)
            cv2.putText(out, tag, (x1 + 2, y1 - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
            if p.phone_seconds > 0:
                pt = f"phone {int(p.phone_seconds)}s"
                pc = (0, 0, 255) if p.phone_alert else (60, 60, 235)
                cv2.putText(out, pt, (x1 + 2, y2 + 15),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, pc, 2, cv2.LINE_AA)

        # dispensing line + running product count
        if self.line_counter is not None:
            h, w = out.shape[:2]
            (ax, ay), (bx, by) = self.line_counter._points_px((w, h))
            cv2.line(out, (int(ax), int(ay)), (int(bx), int(by)), (0, 255, 255), 2)
            cv2.putText(out, "DISPENSE LINE", (int(ax) + 6, int(ay) - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
            sold = "  ".join(f"{k}:{v}" for k, v in
                             sorted(self.line_counter.counts.items(), key=lambda x: -x[1])[:4])
            bar_y = out.shape[0] - 8
            cv2.rectangle(out, (0, out.shape[0] - 28), (out.shape[1], out.shape[0]), (0, 0, 0), -1)
            cv2.putText(out, f"SOLD {self.line_counter.total}   {sold}",
                        (8, bar_y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 1, cv2.LINE_AA)

        # top banner
        cv2.rectangle(out, (0, 0), (out.shape[1], 30), (0, 0, 0), -1)
        counts: dict = {}
        for p in result.persons:
            counts[p.activity] = counts.get(p.activity, 0) + 1
        summary = "  ".join(f"{a}:{n}" for a, n in sorted(counts.items()))
        cv2.putText(out, f"workers {len(result.persons)} | {summary}",
                    (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
        if alerts:
            msg = "PHONE >45s: " + ", ".join(alerts)
            cv2.rectangle(out, (0, 30), (out.shape[1], 56), (0, 0, 130), -1)
            cv2.putText(out, msg, (8, 49),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
        return out

    def close(self):
        pass
