"""Object detection for worker-activity recognition.

Primary path — **YOLO-World** (`yolov8s-worldv2`): open-vocabulary, classes set
from text prompts (no fine-tuning) + built-in **ByteTrack**.

Offline-fallback path — **COCO YOLOv8** (`yolov8s.pt`): YOLO-World needs the CLIP
text encoder the first time `set_classes()` runs, and that CDN is blocked on some
networks (including the build environment for this MVP). When it can't be
fetched, the detector falls back to COCO YOLOv8. The activity we care about keys
off objects that are **native COCO classes** — `person`, `cell phone`, `cup`,
`bottle`, `bowl`, `sandwich`, `cake`, `fork/knife`, `laptop`, … — so phone/food/
drink detection still works in fallback; we just keep a whitelist instead of
remapping. Check `detector.mode` (`"yolo-world"` vs `"coco-fallback"`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Set, Tuple

import numpy as np

# Open-vocabulary vocabulary (YOLO-World prompts). Ordering doesn't matter.
ACTIVITY_PROMPTS: List[str] = [
    "person",
    "cell phone",
    "coffee cup",
    "paper cup",
    "drinking cup",
    "milk pitcher",
    "bottle",
    "food",
    "sandwich",
    "snack",
    "laptop",
    "tablet",
]

# COCO class names we surface in fallback mode (everything else is dropped).
# These are the objects the activity rules reason about.
COCO_KEEP: Set[str] = {
    "person",
    "cell phone",
    "cup",
    "wine glass",
    "bottle",
    "bowl",
    "sandwich",
    "donut",
    "cake",
    "pizza",
    "hot dog",
    "banana",
    "apple",
    "orange",
    "fork",
    "knife",
    "spoon",
    "laptop",
    "book",
}


@dataclass
class Detection:
    label: str
    confidence: float
    box: Tuple[int, int, int, int]  # x1, y1, x2, y2
    track_id: Optional[int] = None

    @property
    def center(self) -> Tuple[float, float]:
        x1, y1, x2, y2 = self.box
        return (x1 + x2) / 2.0, (y1 + y2) / 2.0

    @property
    def area(self) -> float:
        x1, y1, x2, y2 = self.box
        return max(x2 - x1, 0) * max(y2 - y1, 0)


class ProductDetector:
    """YOLO-World detector with ByteTrack, falling back to COCO YOLOv8 offline."""

    def __init__(
        self,
        prompts: Optional[List[str]] = None,
        weights: str = "yolov8s-worldv2.pt",
        fallback_weights: str = "yolov8s.pt",
        conf: float = 0.25,
        device: Optional[str] = None,
        allow_fallback: bool = True,
        coco_keep: Optional[Set[str]] = None,
    ) -> None:
        from ultralytics import YOLO  # lazy: pulls in torch

        self.prompts = list(prompts) if prompts else list(ACTIVITY_PROMPTS)
        self.conf = conf
        self.device = device
        self.mode = "yolo-world"
        self.coco_keep = set(coco_keep) if coco_keep is not None else set(COCO_KEEP)
        self._coco_names: dict = {}

        try:
            self.model = YOLO(weights)
            self.model.set_classes(self.prompts)  # needs CLIP text encoder
        except Exception as exc:  # noqa: BLE001 — any failure -> try fallback
            if not allow_fallback:
                raise
            print(
                f"[detector] YOLO-World unavailable ({type(exc).__name__}: {exc}); "
                f"falling back to COCO '{fallback_weights}'. Detecting the COCO "
                f"subset relevant to worker activity ({len(self.coco_keep)} classes)."
            )
            self.model = YOLO(fallback_weights)
            self._coco_names = dict(self.model.names)
            self.mode = "coco-fallback"

    def set_prompts(self, prompts: List[str]) -> None:
        """Re-set text prompts (YOLO-World only; a no-op in COCO fallback)."""
        self.prompts = list(prompts)
        if self.mode == "yolo-world":
            self.model.set_classes(self.prompts)

    # -- result parsing ---------------------------------------------------
    def _label_for_class(self, k: int) -> Optional[str]:
        if self.mode == "yolo-world":
            return self.prompts[k] if 0 <= k < len(self.prompts) else str(k)
        coco = self._coco_names.get(k)
        return coco if (coco in self.coco_keep) else None

    def _parse(self, result) -> List[Detection]:
        dets: List[Detection] = []
        boxes = getattr(result, "boxes", None)
        if boxes is None or boxes.data is None or len(boxes) == 0:
            return dets
        xyxy = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        clss = boxes.cls.cpu().numpy().astype(int)
        ids = (
            boxes.id.cpu().numpy().astype(int)
            if getattr(boxes, "id", None) is not None
            else [None] * len(xyxy)
        )
        for (x1, y1, x2, y2), c, k, tid in zip(xyxy, confs, clss, ids):
            label = self._label_for_class(int(k))
            if label is None:
                continue
            dets.append(
                Detection(
                    label=label,
                    confidence=float(c),
                    box=(int(x1), int(y1), int(x2), int(y2)),
                    track_id=int(tid) if tid is not None else None,
                )
            )
        return dets

    def detect(self, frame: np.ndarray) -> List[Detection]:
        results = self.model.predict(
            frame, conf=self.conf, verbose=False, device=self.device
        )
        return self._parse(results[0])

    def track(self, frame: np.ndarray) -> List[Detection]:
        """Detection + ByteTrack (stable ``track_id`` across frames)."""
        results = self.model.track(
            frame,
            conf=self.conf,
            persist=True,
            tracker="bytetrack.yaml",
            verbose=False,
            device=self.device,
        )
        return self._parse(results[0])
