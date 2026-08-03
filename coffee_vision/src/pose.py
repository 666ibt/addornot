"""MediaPipe Pose wrapper — we only need wrist / hand keypoints for the rules.

MediaPipe returns 33 body landmarks in normalized [0,1] coordinates. We expose
just the wrists (the action rules key off wrist position + motion) plus a helper
to draw the skeleton.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np

# MediaPipe Pose landmark indices we care about.
LEFT_WRIST = 15
RIGHT_WRIST = 16


@dataclass
class PoseResult:
    # Pixel coordinates of wrists, or None if not confidently detected.
    left_wrist: Optional[Tuple[float, float]]
    right_wrist: Optional[Tuple[float, float]]
    raw_landmarks: object = None  # mediapipe NormalizedLandmarkList, for drawing

    @property
    def any_wrist(self) -> Optional[Tuple[float, float]]:
        """Prefer the right wrist (dominant hand for most baristas), else left."""
        return self.right_wrist or self.left_wrist


class PoseEstimator:
    def __init__(
        self,
        min_detection_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
        model_complexity: int = 1,
    ) -> None:
        import mediapipe as mp  # lazy import

        self._mp = mp
        self._drawing = mp.solutions.drawing_utils
        self._pose_mod = mp.solutions.pose
        self.pose = self._pose_mod.Pose(
            static_image_mode=False,
            model_complexity=model_complexity,
            min_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence,
        )

    def process(self, frame_bgr: np.ndarray) -> PoseResult:
        import cv2

        h, w = frame_bgr.shape[:2]
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        res = self.pose.process(rgb)
        if not res.pose_landmarks:
            return PoseResult(left_wrist=None, right_wrist=None)

        lms = res.pose_landmarks.landmark

        def _wrist(idx: int) -> Optional[Tuple[float, float]]:
            lm = lms[idx]
            # visibility is MediaPipe's confidence the joint is present.
            if lm.visibility < 0.3:
                return None
            return (lm.x * w, lm.y * h)

        return PoseResult(
            left_wrist=_wrist(LEFT_WRIST),
            right_wrist=_wrist(RIGHT_WRIST),
            raw_landmarks=res.pose_landmarks,
        )

    def draw(self, frame_bgr: np.ndarray, result: PoseResult) -> np.ndarray:
        if result.raw_landmarks is None:
            return frame_bgr
        self._drawing.draw_landmarks(
            frame_bgr,
            result.raw_landmarks,
            self._pose_mod.POSE_CONNECTIONS,
            landmark_drawing_spec=self._drawing.DrawingSpec(
                color=(0, 255, 255), thickness=2, circle_radius=2
            ),
            connection_drawing_spec=self._drawing.DrawingSpec(
                color=(200, 200, 200), thickness=1
            ),
        )
        return frame_bgr

    def close(self) -> None:
        self.pose.close()
