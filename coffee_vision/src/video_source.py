"""Frame iterator over a webcam index or a video file — one small abstraction
so the rest of the code doesn't care where frames come from.
"""

from __future__ import annotations

from typing import Iterator, Tuple, Union

import cv2
import numpy as np


class VideoSource:
    def __init__(self, source: Union[int, str]):
        # int -> webcam index; str -> file path (or stream URL).
        self.source = source
        self.cap = cv2.VideoCapture(source)
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open video source: {source!r}")
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 25.0
        if self.fps <= 0 or self.fps > 240:
            self.fps = 25.0
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    @property
    def frame_size(self) -> Tuple[int, int]:
        return (self.width, self.height)

    def read(self) -> Tuple[bool, np.ndarray]:
        return self.cap.read()

    def frames(self) -> Iterator[Tuple[int, float, np.ndarray]]:
        """Yield (frame_index, video_timestamp_seconds, frame_bgr)."""
        idx = 0
        while True:
            ok, frame = self.cap.read()
            if not ok:
                break
            yield idx, idx / self.fps, frame
            idx += 1

    def release(self) -> None:
        self.cap.release()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release()
