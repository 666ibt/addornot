"""Frame source: webcam index, video file, or an **RTSP IP camera**.

RTSP (Hikvision / Dahua) needs a few things a file doesn't:
  * the FFMPEG backend and a small buffer, or frames pile up and you watch the
    past instead of the present;
  * **auto-reconnect** — a 24/7 camera stream *will* drop, and the service must
    come back on its own instead of dying;
  * a read timeout, so a half-dead connection doesn't hang forever.

Build a URL with :func:`rtsp_url` or paste one straight in::

    VideoSource("rtsp://admin:PASS@192.168.0.135:554/Streaming/Channels/102")
"""

from __future__ import annotations

import os
import time
from typing import Iterator, Optional, Tuple, Union

import cv2
import numpy as np

# Force FFMPEG's TCP transport for RTSP: UDP loses packets and smears frames.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

# channel/subtype 1 = main stream (full quality, heavy),
#                 2 = sub stream  (smaller, much lighter on CPU — use for CV).
_HIK = "rtsp://{user}:{pwd}@{host}:{port}/Streaming/Channels/{ch}"
_DAHUA = "rtsp://{user}:{pwd}@{host}:{port}/cam/realmonitor?channel=1&subtype={sub}"


def rtsp_url(host: str, password: str, user: str = "admin", port: int = 554,
             vendor: str = "hikvision", substream: bool = True) -> str:
    """Compose an RTSP URL for a Hikvision or Dahua camera.

    ``substream=True`` picks the lower-resolution stream — strongly recommended
    for analytics: same detections, a fraction of the CPU.
    """
    v = vendor.lower()
    if v.startswith("dahua"):
        return _DAHUA.format(user=user, pwd=password, host=host, port=port,
                             sub=1 if substream else 0)
    return _HIK.format(user=user, pwd=password, host=host, port=port,
                       ch="102" if substream else "101")


def mask_url(url: object) -> str:
    """Hide the password when printing/logging an RTSP URL."""
    s = str(url)
    if "://" not in s or "@" not in s:
        return s
    scheme, rest = s.split("://", 1)
    creds, tail = rest.rsplit("@", 1)
    user = creds.split(":", 1)[0]
    return f"{scheme}://{user}:***@{tail}"


class VideoSource:
    def __init__(
        self,
        source: Union[int, str],
        reconnect: Optional[bool] = None,
        max_retries: int = 0,          # 0 = retry forever (24/7 service)
        retry_delay: float = 3.0,
        target_fps: Optional[float] = None,
    ):
        # int -> webcam index; str -> file path or stream URL.
        self.source = source
        self.is_stream = isinstance(source, str) and "://" in source
        # Streams reconnect by default; files just end.
        self.reconnect = self.is_stream if reconnect is None else reconnect
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.target_fps = target_fps
        self.cap = self._open()
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open video source: {mask_url(source)}")
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 25.0
        if self.fps <= 0 or self.fps > 240:
            self.fps = 25.0
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    def _open(self):
        if self.is_stream:
            cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)
            # Keep only the newest frame: analytics must run on *now*.
            try:
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            except cv2.error:
                pass
            return cap
        return cv2.VideoCapture(self.source)

    def _reopen(self) -> bool:
        """Try to re-establish a dropped stream. True once frames flow again."""
        tries = 0
        while self.max_retries == 0 or tries < self.max_retries:
            tries += 1
            try:
                self.cap.release()
            except Exception:
                pass
            time.sleep(self.retry_delay)
            print(f"[video] reconnecting to {mask_url(self.source)} (attempt {tries})…")
            self.cap = self._open()
            if self.cap.isOpened():
                ok, _ = self.cap.read()
                if ok:
                    print("[video] reconnected")
                    return True
        return False

    @property
    def frame_size(self) -> Tuple[int, int]:
        return (self.width, self.height)

    def read(self) -> Tuple[bool, np.ndarray]:
        return self.cap.read()

    def frames(self) -> Iterator[Tuple[int, float, np.ndarray]]:
        """Yield (frame_index, timestamp_seconds, frame_bgr).

        For files the timestamp is position in the video; for live streams it is
        wall-clock seconds since start (that's what shift/alert timing wants).
        """
        idx = 0
        t0 = time.time()
        min_dt = 1.0 / self.target_fps if self.target_fps else 0.0
        last = 0.0
        while True:
            ok, frame = self.cap.read()
            if not ok:
                if self.reconnect and self._reopen():
                    continue
                break
            now = time.time()
            if min_dt and (now - last) < min_dt:
                continue  # drop frames we don't have the CPU budget for
            last = now
            ts = (now - t0) if self.is_stream else (idx / self.fps)
            yield idx, ts, frame
            idx += 1

    def release(self) -> None:
        self.cap.release()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release()
