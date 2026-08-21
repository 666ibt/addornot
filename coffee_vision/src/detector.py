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

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Set, Tuple

import numpy as np


def _clip_installed() -> bool:
    """Is the CLIP text encoder importable? YOLO-World needs it for prompts."""
    try:
        import clip  # noqa: F401
        return True
    except Exception:  # noqa: BLE001 — a broken install counts as missing
        return False


def _git_available() -> bool:
    """ultralytics installs CLIP with `pip install git+https://…` — that needs git."""
    return shutil.which("git") is not None

# If a model fine-tuned on your own footage is installed here (by scripts.train),
# it is used in preference to YOLO-World / COCO. Its own class names drive labels.
_CUSTOM_WEIGHTS = Path(__file__).resolve().parent.parent / "models" / "custom.pt"

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
        custom_weights: Optional[str] = None,
    ) -> None:
        from ultralytics import YOLO  # lazy: pulls in torch

        self.prompts = list(prompts) if prompts else list(ACTIVITY_PROMPTS)
        self.conf = conf
        self.device = device
        self.mode = "yolo-world"
        self.coco_keep = set(coco_keep) if coco_keep is not None else set(COCO_KEEP)
        self._coco_names: dict = {}

        # 1) prefer a fine-tuned model when present (explicit arg or installed file)
        cw = custom_weights or (str(_CUSTOM_WEIGHTS) if _CUSTOM_WEIGHTS.exists() else None)
        if cw:
            self.model = YOLO(cw)
            self._coco_names = dict(self.model.names)
            self.mode = "custom"
            print(f"[detector] using fine-tuned weights: {cw} "
                  f"(classes: {list(self.model.names.values())})")
            return

        # 2) Don't even attempt YOLO-World when it provably can't work here.
        # Without CLIP installed, ultralytics tries `pip install git+https://…`,
        # which hangs forever on a machine with no git. Skip straight to COCO.
        force_coco = os.environ.get("COFFEE_VISION_FORCE_COCO", "").strip() not in ("", "0")
        if allow_fallback and (force_coco or not (_clip_installed() or _git_available())):
            why = ("COFFEE_VISION_FORCE_COCO is set" if force_coco
                   else "CLIP is not installed and git is unavailable to fetch it")
            print(f"[detector] skipping YOLO-World ({why}); using COCO '{fallback_weights}'. "
                  f"Install git (and let it fetch CLIP) for open-vocabulary prompts.")
            self.model = YOLO(fallback_weights)
            self._coco_names = dict(self.model.names)
            self.mode = "coco-fallback"
            return

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
        if self.mode == "custom":
            # trust the fine-tuned model's own class names (all are wanted)
            return self._coco_names.get(k)
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
