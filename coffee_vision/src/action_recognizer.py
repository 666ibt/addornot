"""Barista action recognition.

This module defines a small **interface** (``ActionRecognizer``) and one
**rule-based implementation** (``RuleBasedActionRecognizer``). The rest of the
pipeline only ever talks to the interface, so the rule-based block can later be
swapped for a trained temporal model **without touching pipeline/UI code**.

--------------------------------------------------------------------------
HOW TO REPLACE THE RULE-BASED BLOCK WITH A TRAINED MODEL (future work)
--------------------------------------------------------------------------
1. Collect + label short clips per action (grinding_tamping, espresso_extraction,
   milk_steaming, milk_pouring, idle).
2. Train a temporal model (e.g. a small LSTM/TCN over pose keypoints, or a video
   classifier like SlowFast / MoViNet over cropped clips).
3. Implement a new subclass::

       class MLActionRecognizer(ActionRecognizer):
           def __init__(self, weights): self.model = load(weights)
           def update(self, ctx: FrameContext) -> ActionPrediction:
               self.buffer.append(features(ctx))          # keep a sliding window
               logits = self.model(self.buffer.as_tensor())
               label, conf = decode(logits)
               return ActionPrediction(label, conf)

4. In pipeline.py, construct ``MLActionRecognizer(...)`` instead of
   ``RuleBasedActionRecognizer(...)``. Nothing else changes: same ``update()``
   contract (one FrameContext in, one ActionPrediction out), same label set.

The ``FrameContext`` deliberately carries everything a learned model would want
(wrist positions, per-wrist zone, nearby objects, frame index/time), so no
extra plumbing is needed later.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional, Tuple

# The fixed label set the MVP recognizes. A trained model must emit these too.
ACTIONS = [
    "grinding_tamping",
    "espresso_extraction",
    "milk_steaming",
    "milk_pouring",
    "idle",
]


@dataclass
class FrameContext:
    """Everything the recognizer sees for a single frame."""

    frame_index: int
    timestamp: float  # seconds into the video/stream
    left_wrist: Optional[Tuple[float, float]]
    right_wrist: Optional[Tuple[float, float]]
    # Zone name each wrist is currently inside (None if outside all zones / no
    # calibration). Filled in by the pipeline using Zones.zone_of_point.
    left_zone: Optional[str] = None
    right_zone: Optional[str] = None
    # Labels of objects detected near the active hand this frame.
    nearby_objects: List[str] = field(default_factory=list)


@dataclass
class ActionPrediction:
    label: str
    confidence: float


class ActionRecognizer:
    """Interface. Feed one FrameContext per frame, get one prediction back."""

    def update(self, ctx: FrameContext) -> ActionPrediction:  # pragma: no cover
        raise NotImplementedError

    def reset(self) -> None:  # pragma: no cover
        pass


class RuleBasedActionRecognizer(ActionRecognizer):
    """A transparent state machine over (zone, nearby object, wrist motion).

    Signals used:
      * **zone**   — which calibrated zone the active wrist is in.
      * **object** — which product the detector sees near the hand.
      * **motion** — variance of the wrist position over the last ~1 s window;
        high variance = repetitive/vigorous hand movement.

    None of this is a neural network — it is intentionally simple so the MVP
    runs today. Accuracy is approximate by design (see README "Assumptions").
    """

    def __init__(
        self,
        fps: float = 25.0,
        window_seconds: float = 1.0,
        # variance (px^2) of wrist position above which we call motion "active".
        motion_threshold: float = 120.0,
        # frames an action must persist before we commit to it (debounce).
        min_hold_frames: int = 3,
    ) -> None:
        self.fps = max(fps, 1.0)
        self.window = max(int(self.fps * window_seconds), 3)
        self.motion_threshold = motion_threshold
        self.min_hold_frames = min_hold_frames

        self._wrist_hist: Deque[Tuple[float, float]] = deque(maxlen=self.window)
        self._current = "idle"
        self._candidate = "idle"
        self._candidate_count = 0

    def reset(self) -> None:
        self._wrist_hist.clear()
        self._current = "idle"
        self._candidate = "idle"
        self._candidate_count = 0

    # -- motion -----------------------------------------------------------
    def _motion_variance(self) -> float:
        if len(self._wrist_hist) < 3:
            return 0.0
        xs = [p[0] for p in self._wrist_hist]
        ys = [p[1] for p in self._wrist_hist]
        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        var = sum((x - mx) ** 2 + (y - my) ** 2 for x, y in self._wrist_hist)
        return var / len(self._wrist_hist)

    # -- rules ------------------------------------------------------------
    def _raw_label(self, ctx: FrameContext) -> Tuple[str, float]:
        """Map the current signals to a (label, confidence) with no debounce."""
        wrist = ctx.right_wrist or ctx.left_wrist
        if wrist is not None:
            self._wrist_hist.append(wrist)
        if wrist is None:
            return "idle", 0.4

        zone = ctx.right_zone or ctx.left_zone
        objs = set(ctx.nearby_objects)
        motion = self._motion_variance()
        active = motion > self.motion_threshold

        # Zone-driven rules first — zones are the strongest signal when the user
        # has calibrated them. Confidence blends zone certainty with motion.
        if zone == "grinder":
            # Grinding / tamping is vigorous, repetitive hand motion at the grinder.
            return ("grinding_tamping", 0.75 if active else 0.55)

        if zone == "group_head":
            # Hand parked at the group head -> espresso is extracting (low motion).
            return ("espresso_extraction", 0.7 if not active else 0.5)

        if zone == "steam_wand":
            # At the steam wand: object nearby (pitcher) or motion -> steaming.
            if {"milk pitcher", "milk carton"} & objs or active:
                return ("milk_steaming", 0.72)
            return ("milk_steaming", 0.55)

        if zone == "counter":
            # Over the counter with a pitcher + motion -> pouring latte art.
            if {"milk pitcher", "coffee cup", "paper cup"} & objs and active:
                return ("milk_pouring", 0.68)
            return ("idle", 0.5)

        # No calibrated zones (or wrist outside them): fall back to object +
        # motion only, so the pipeline still produces actions before calibration.
        if {"milk pitcher", "milk carton"} & objs:
            return ("milk_steaming" if active else "milk_pouring", 0.5)
        if "portafilter" in objs:
            return ("grinding_tamping" if active else "espresso_extraction", 0.5)
        if active:
            return ("grinding_tamping", 0.45)
        return "idle", 0.4

    def update(self, ctx: FrameContext) -> ActionPrediction:
        label, conf = self._raw_label(ctx)

        # Debounce: require min_hold_frames of agreement before switching, so a
        # single noisy frame doesn't flip the reported action.
        if label == self._candidate:
            self._candidate_count += 1
        else:
            self._candidate = label
            self._candidate_count = 1

        if self._candidate_count >= self.min_hold_frames:
            self._current = self._candidate

        return ActionPrediction(label=self._current, confidence=conf)
