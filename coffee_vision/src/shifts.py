"""Work shifts: 0:00–8:00 = 0, 8:00–16:00 = 1, 16:00–24:00 = 2.

Counters and reports are grouped by (date, shift), so a report always covers one
shift on one day even when a shift crosses midnight boundaries.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Tuple

SHIFT_HOURS = 8
SHIFT_NAMES = {0: "00:00–08:00", 1: "08:00–16:00", 2: "16:00–24:00"}


def current_shift(now: datetime | None = None) -> int:
    now = now or datetime.now()
    return min(now.hour // SHIFT_HOURS, 2)


def shift_key(now: datetime | None = None) -> Tuple[str, int]:
    """(YYYY-MM-DD, shift_index) — the identity of the shift in progress."""
    now = now or datetime.now()
    return now.strftime("%Y-%m-%d"), current_shift(now)


def shift_name(shift: int) -> str:
    return SHIFT_NAMES.get(shift, str(shift))


@dataclass
class ShiftWatcher:
    """Detects the moment the shift changes, so a report can be sent once."""

    date: str = ""
    shift: int = -1

    def check(self, now: datetime | None = None):
        """Return the (date, shift) that just ENDED, or None if unchanged."""
        d, s = shift_key(now)
        if self.shift == -1:            # first call: just latch, nothing ended
            self.date, self.shift = d, s
            return None
        if (d, s) != (self.date, self.shift):
            ended = (self.date, self.shift)
            self.date, self.shift = d, s
            return ended
        return None
