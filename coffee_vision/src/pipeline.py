"""The end-to-end per-frame pipeline: detector + pose + action -> overlay + events.

Usage::

    pipe = Pipeline(zones_path="config/zones.json", store=EventStore(...))
    for idx, ts, frame in source.frames():
        annotated, result = pipe.process(idx, ts, frame)
        # push `annotated` to the UI; `result` has detections + action.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import cv2
import numpy as np

from .action_recognizer import (
    ActionRecognizer,
    ActionPrediction,
    FrameContext,
    RuleBasedActionRecognizer,
)
from .detector import Detection, ProductDetector
from .events import Event, EventStore
from .pose import PoseEstimator, PoseResult
from .zones import Zones

# BGR colors for drawing.
_ZONE_COLOR = (255, 180, 0)
_BOX_COLOR = (0, 200, 0)
_ACTION_COLOR = (0, 165, 255)


@dataclass
class FrameResult:
    detections: List[Detection]
    pose: PoseResult
    action: ActionPrediction
    active_zone: Optional[str]


class Pipeline:
    def __init__(
        self,
        detector: Optional[ProductDetector] = None,
        pose: Optional[PoseEstimator] = None,
        recognizer: Optional[ActionRecognizer] = None,
        zones: Optional[Zones] = None,
        zones_path: Optional[str] = None,
        store: Optional[EventStore] = None,
        fps: float = 25.0,
        # a hand is "near" an object if within this many px of the box center.
        near_px: float = 160.0,
    ) -> None:
        self.detector = detector if detector is not None else ProductDetector()
        self.pose = pose if pose is not None else PoseEstimator()
        self.recognizer = (
            recognizer
            if recognizer is not None
            else RuleBasedActionRecognizer(fps=fps)
        )
        if zones is None and zones_path:
            zones = Zones.maybe_load(zones_path)
        self.zones = zones
        self.store = store
        self.near_px = near_px

        # de-dup state so we log an event only on change, not every frame.
        self._seen_track_ids: set = set()
        self._last_action: Optional[str] = None

    # -- helpers ----------------------------------------------------------
    def _nearby_objects(
        self, wrist: Optional[Tuple[float, float]], dets: List[Detection]
    ) -> List[str]:
        if wrist is None:
            return []
        wx, wy = wrist
        out = []
        for d in dets:
            if d.label == "person":
                continue
            cx, cy = d.center
            if math.hypot(cx - wx, cy - wy) <= self.near_px:
                out.append(d.label)
        return out

    # -- main -------------------------------------------------------------
    def process(
        self, frame_index: int, video_ts: float, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, FrameResult]:
        h, w = frame_bgr.shape[:2]
        frame_wh = (w, h)

        detections = self.detector.track(frame_bgr)
        pose = self.pose.process(frame_bgr)

        active_wrist = pose.any_wrist
        left_zone = (
            self.zones.zone_of_point(pose.left_wrist, frame_wh)
            if self.zones and pose.left_wrist
            else None
        )
        right_zone = (
            self.zones.zone_of_point(pose.right_wrist, frame_wh)
            if self.zones and pose.right_wrist
            else None
        )

        ctx = FrameContext(
            frame_index=frame_index,
            timestamp=video_ts,
            left_wrist=pose.left_wrist,
            right_wrist=pose.right_wrist,
            left_zone=left_zone,
            right_zone=right_zone,
            nearby_objects=self._nearby_objects(active_wrist, detections),
        )
        action = self.recognizer.update(ctx)
        active_zone = right_zone or left_zone

        # -- events --
        if self.store is not None:
            for d in detections:
                if d.track_id is not None and d.track_id not in self._seen_track_ids:
                    self._seen_track_ids.add(d.track_id)
                    self.store.log(
                        Event(
                            event_type="object",
                            label=d.label,
                            confidence=d.confidence,
                            zone=None,
                            video_ts=video_ts,
                        )
                    )
            if action.label != self._last_action:
                self._last_action = action.label
                self.store.log(
                    Event(
                        event_type="action",
                        label=action.label,
                        confidence=action.confidence,
                        zone=active_zone,
                        video_ts=video_ts,
                    )
                )

        annotated = self._draw(frame_bgr, detections, pose, action, active_zone, frame_wh)
        return annotated, FrameResult(detections, pose, action, active_zone)

    # -- drawing ----------------------------------------------------------
    def _draw(
        self,
        frame: np.ndarray,
        dets: List[Detection],
        pose: PoseResult,
        action: ActionPrediction,
        active_zone: Optional[str],
        frame_wh: Tuple[int, int],
    ) -> np.ndarray:
        out = frame.copy()

        if self.zones is not None:
            overlay = out.copy()
            for name, poly in self.zones.scaled_polygons(frame_wh).items():
                highlight = name == active_zone
                cv2.polylines(out, [poly], True, _ZONE_COLOR, 2 if not highlight else 3)
                if highlight:
                    cv2.fillPoly(overlay, [poly], _ZONE_COLOR)
                x, y = poly[0]
                cv2.putText(
                    out, name, (int(x), int(y) - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, _ZONE_COLOR, 1, cv2.LINE_AA,
                )
            cv2.addWeighted(overlay, 0.15, out, 0.85, 0, out)

        for d in dets:
            x1, y1, x2, y2 = d.box
            cv2.rectangle(out, (x1, y1), (x2, y2), _BOX_COLOR, 2)
            tag = f"{d.label} {d.confidence:.2f}"
            if d.track_id is not None:
                tag += f" #{d.track_id}"
            cv2.putText(
                out, tag, (x1, max(y1 - 6, 12)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, _BOX_COLOR, 1, cv2.LINE_AA,
            )

        self.pose.draw(out, pose)

        banner = f"ACTION: {action.label}  ({action.confidence:.2f})"
        if active_zone:
            banner += f"  [zone: {active_zone}]"
        cv2.rectangle(out, (0, 0), (out.shape[1], 34), (0, 0, 0), -1)
        cv2.putText(
            out, banner, (10, 24),
            cv2.FONT_HERSHEY_SIMPLEX, 0.7, _ACTION_COLOR, 2, cv2.LINE_AA,
        )
        return out

    def close(self) -> None:
        try:
            self.pose.close()
        except Exception:
            pass
