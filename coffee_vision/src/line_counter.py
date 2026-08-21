"""Virtual dispensing line — count products actually handed out.

A product sitting on the counter must not be counted; a product **carried across
the pickup line** is a sale. We track each object's centre and fire once when it
crosses the line.

Improvements over a plain horizontal `prev_y < LINE_Y <= curr_y` check:

* **Any orientation** — the line is two points, so it can run diagonally along
  the real pickup edge instead of being forced horizontal. Crossing is decided
  by the sign of the cross-product (which side of the line the point is on).
* **Direction aware** — only count the outward direction, so a barista pulling a
  cup back doesn't add a sale (``direction="both"`` disables this).
* **Counted once per track** — a track that hovers on the line can't double-count.
* **Per class** — cups, bottles, food counted separately.

Coordinates are stored **normalised (0..1)**, so a line drawn on one resolution
still lines up on another (main stream vs substream).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set, Tuple

# Classes that count as a dispensed product (COCO + our custom names).
DEFAULT_PRODUCT_CLASSES: Set[str] = {
    "cup", "coffee cup", "paper cup", "drinking cup", "wine glass",
    "bottle", "bowl", "sandwich", "cake", "donut", "pizza", "hot dog",
    "food", "snack",
}


@dataclass
class CrossEvent:
    track_id: int
    label: str
    ts: float
    direction: int  # +1 or -1, which way it crossed


@dataclass
class LineCounter:
    """Counts objects crossing a line segment defined in normalised coords."""

    p1: Tuple[float, float] = (0.0, 0.55)   # normalised (x, y)
    p2: Tuple[float, float] = (1.0, 0.55)
    direction: str = "both"                  # "both" | "positive" | "negative"
    product_classes: Set[str] = field(default_factory=lambda: set(DEFAULT_PRODUCT_CLASSES))
    counts: Dict[str, int] = field(default_factory=dict)
    _side: Dict[int, float] = field(default_factory=dict, repr=False)
    _counted: Set[int] = field(default_factory=set, repr=False)

    # -- geometry ---------------------------------------------------------
    def _points_px(self, frame_wh: Tuple[int, int]):
        w, h = frame_wh
        return (self.p1[0] * w, self.p1[1] * h), (self.p2[0] * w, self.p2[1] * h)

    @staticmethod
    def _cross(a, b, p) -> float:
        """>0 / <0 tells which side of line a→b the point p lies on."""
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])

    @staticmethod
    def _within(a, b, p) -> bool:
        """True if p projects onto the segment (not past its ends)."""
        vx, vy = b[0] - a[0], b[1] - a[1]
        L2 = vx * vx + vy * vy
        if L2 == 0:
            return False
        t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2
        return -0.02 <= t <= 1.02

    def is_product(self, label: str) -> bool:
        return label.lower() in self.product_classes

    # -- main -------------------------------------------------------------
    def update(self, detections: Sequence, ts: float,
               frame_wh: Tuple[int, int]) -> List[CrossEvent]:
        """Feed this frame's detections; return any crossings that just happened."""
        a, b = self._points_px(frame_wh)
        events: List[CrossEvent] = []
        seen: Set[int] = set()

        for d in detections:
            tid = getattr(d, "track_id", None)
            if tid is None or not self.is_product(d.label):
                continue
            seen.add(tid)
            c = d.center
            s = self._cross(a, b, c)
            prev = self._side.get(tid)
            self._side[tid] = s
            if prev is None or tid in self._counted:
                continue
            # sign flip = crossed the infinite line; _within keeps it on-segment
            if (prev < 0 <= s or prev > 0 >= s) and self._within(a, b, c):
                dirn = 1 if s >= 0 else -1
                if self.direction == "positive" and dirn != 1:
                    continue
                if self.direction == "negative" and dirn != -1:
                    continue
                self._counted.add(tid)
                self.counts[d.label] = self.counts.get(d.label, 0) + 1
                events.append(CrossEvent(tid, d.label, ts, dirn))

        # forget tracks that disappeared, so ids can be reused later
        gone = [t for t in self._side if t not in seen]
        if len(gone) > 200:
            for t in gone:
                self._side.pop(t, None)
                self._counted.discard(t)
        return events

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    def reset(self) -> None:
        self.counts.clear()
        self._side.clear()
        self._counted.clear()

    # -- persistence ------------------------------------------------------
    def save(self, path: str | Path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(
            {"p1": list(self.p1), "p2": list(self.p2), "direction": self.direction},
            indent=2))

    @classmethod
    def load(cls, path: str | Path) -> Optional["LineCounter"]:
        p = Path(path)
        if not p.exists() or p.stat().st_size == 0:
            return None
        try:
            d = json.loads(p.read_text())
            return cls(p1=tuple(d["p1"]), p2=tuple(d["p2"]),
                       direction=d.get("direction", "both"))
        except (json.JSONDecodeError, KeyError, TypeError):
            return None
