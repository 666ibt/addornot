"""Work zones for the coffee station.

A *zone* is a named quadrilateral (4 points) drawn once on the first frame of a
video via ``scripts/calibrate_zones.py`` and stored in ``config/zones.json``.
During recognition we ask "which zone is this wrist in?" to help decide the
barista's action (e.g. wrist in the ``grinder`` zone + repetitive motion ->
grinding_tamping).

zones.json format::

    {
      "frame_size": [width, height],
      "zones": {
        "grinder":   [[x1,y1],[x2,y2],[x3,y3],[x4,y4]],
        "group_head":[...],
        "steam_wand":[...],
        "counter":   [...]
      }
    }

Coordinates are in pixels of the frame the calibration ran on. ``frame_size``
lets us rescale if the live stream has a different resolution.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

# The zones the MVP knows how to reason about, in the order the calibration
# script asks the user to draw them. Keep this in sync with the action rules
# in action_recognizer.py.
DEFAULT_ZONE_NAMES: List[str] = ["grinder", "group_head", "steam_wand", "counter"]

Point = Tuple[float, float]


@dataclass
class Zones:
    frame_size: Tuple[int, int]  # (width, height) the polygons were drawn on
    polygons: Dict[str, np.ndarray]  # name -> (4, 2) float32 array

    @classmethod
    def load(cls, path: str | Path) -> "Zones":
        data = json.loads(Path(path).read_text())
        fs = tuple(data.get("frame_size", [0, 0]))
        polys = {
            name: np.asarray(pts, dtype=np.float32)
            for name, pts in data["zones"].items()
        }
        return cls(frame_size=fs, polygons=polys)

    @classmethod
    def maybe_load(cls, path: str | Path) -> Optional["Zones"]:
        """Return None instead of raising when the file is missing/empty.

        The pipeline must run even before the user has calibrated zones — it
        just falls back to object-proximity-only action logic.
        """
        p = Path(path)
        if not p.exists() or p.stat().st_size == 0:
            return None
        try:
            return cls.load(p)
        except (json.JSONDecodeError, KeyError):
            return None

    def save(self, path: str | Path) -> None:
        out = {
            "frame_size": list(self.frame_size),
            "zones": {name: poly.tolist() for name, poly in self.polygons.items()},
        }
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(out, indent=2))

    def _scaled(self, poly: np.ndarray, frame_wh: Tuple[int, int]) -> np.ndarray:
        """Rescale a polygon from calibration resolution to the current frame."""
        cw, ch = self.frame_size
        fw, fh = frame_wh
        if not cw or not ch or (cw == fw and ch == fh):
            return poly
        return poly * np.array([fw / cw, fh / ch], dtype=np.float32)

    def zone_of_point(
        self, point: Point, frame_wh: Optional[Tuple[int, int]] = None
    ) -> Optional[str]:
        """Return the name of the zone containing ``point``, or None.

        ``frame_wh`` is the (w, h) of the frame ``point`` came from; pass it so
        zones calibrated at a different resolution still line up.
        """
        px, py = point
        for name, poly in self.polygons.items():
            p = self._scaled(poly, frame_wh) if frame_wh else poly
            if _point_in_quad(px, py, p):
                return name
        return None

    def scaled_polygons(
        self, frame_wh: Tuple[int, int]
    ) -> Dict[str, np.ndarray]:
        """Polygons rescaled to ``frame_wh`` as int32 arrays for cv2 drawing."""
        return {
            name: self._scaled(poly, frame_wh).astype(np.int32)
            for name, poly in self.polygons.items()
        }


def _point_in_quad(px: float, py: float, quad: np.ndarray) -> bool:
    """Ray-casting point-in-polygon test for a 4-point polygon."""
    n = len(quad)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = quad[i]
        xj, yj = quad[j]
        if (yi > py) != (yj > py):
            x_cross = (xj - xi) * (py - yi) / (yj - yi + 1e-9) + xi
            if px < x_cross:
                inside = not inside
        j = i
    return inside
