"""Open-vocabulary product detection with YOLO-World + built-in ByteTrack.

Primary path — **YOLO-World** (`yolov8s-worldv2`): classes are set from *text
prompts* with no fine-tuning on our own data, and objects are tracked across
frames with the built-in **ByteTrack**. To adapt to a different menu, just edit
``DEFAULT_PROMPTS`` (or the Streamlit sidebar); the model re-embeds the words.

Offline-fallback path — **COCO YOLOv8** (`yolov8s.pt`): YOLO-World needs the
CLIP text encoder (ViT-B/32) to embed the prompts the first time, and that file
is hosted on a CDN some locked-down networks block (this build environment was
one). When the CLIP weights can't be fetched, the detector transparently falls
back to a standard COCO-pretrained YOLOv8 and *remaps the overlapping COCO
classes to the coffee vocabulary* (cup -> "coffee cup", bottle -> "milk carton",
person -> "person", …) so the pipeline still produces real object detections.
COCO has no "espresso machine"/"portafilter" class, so those simply aren't
detected in fallback mode. Check ``detector.mode`` to see which path is active.

On a machine with normal internet, YOLO-World is used automatically — nothing to
configure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

# Product / object classes for the coffee-shop demo, as plain-English prompts.
DEFAULT_PROMPTS: List[str] = [
    "coffee cup",
    "paper cup",
    "milk carton",
    "milk pitcher",
    "syrup bottle",
    "portafilter",
    "espresso machine",
    "person",
    "coffee beans bag",
]

# COCO class name -> nearest coffee-vocabulary label, used ONLY in the offline
# COCO fallback. COCO classes not listed here are dropped so the event stream
# stays coffee-relevant. Approximate by construction (see module docstring).
COCO_TO_COFFEE: Dict[str, str] = {
    "person": "person",
    "cup": "coffee cup",
    "bottle": "milk carton",
    "wine glass": "milk pitcher",
    "vase": "milk pitcher",
    "bowl": "milk pitcher",
    "handbag": "coffee beans bag",
    "backpack": "coffee beans bag",
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


class ProductDetector:
    """YOLO-World detector with ByteTrack, falling back to COCO YOLOv8 offline.

    The heavy ``ultralytics`` import happens lazily inside ``__init__``.
    """

    def __init__(
        self,
        prompts: Optional[List[str]] = None,
        weights: str = "yolov8s-worldv2.pt",
        fallback_weights: str = "yolov8s.pt",
        conf: float = 0.05,
        device: Optional[str] = None,
        allow_fallback: bool = True,
    ) -> None:
        from ultralytics import YOLO  # lazy: pulls in torch

        self.prompts = list(prompts) if prompts else list(DEFAULT_PROMPTS)
        self.conf = conf
        self.device = device
        self.mode = "yolo-world"
        self._coco_names: Dict[int, str] = {}

        try:
            # yolov8s-worldv2 auto-downloads on first use.
            self.model = YOLO(weights)
            # set_classes() embeds the prompts via CLIP — this is what needs the
            # (sometimes blocked) CLIP text-encoder download.
            self.model.set_classes(self.prompts)
        except Exception as exc:  # noqa: BLE001 — any failure -> try fallback
            if not allow_fallback:
                raise
            print(
                f"[detector] YOLO-World unavailable ({type(exc).__name__}: {exc}); "
                f"falling back to COCO '{fallback_weights}' with class remapping. "
                f"Object detection will be limited to COCO classes."
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
        # COCO fallback: remap, dropping classes with no coffee equivalent.
        coco = self._coco_names.get(k)
        return COCO_TO_COFFEE.get(coco) if coco else None

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
            if label is None:  # dropped COCO class
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
        """One-shot detection (no tracking IDs)."""
        results = self.model.predict(
            frame, conf=self.conf, verbose=False, device=self.device
        )
        return self._parse(results[0])

    def track(self, frame: np.ndarray) -> List[Detection]:
        """Detection + ByteTrack, giving each object a stable ``track_id``.

        ``persist=True`` keeps tracker state across consecutive frames.
        """
        results = self.model.track(
            frame,
            conf=self.conf,
            persist=True,
            tracker="bytetrack.yaml",
            verbose=False,
            device=self.device,
        )
        return self._parse(results[0])
