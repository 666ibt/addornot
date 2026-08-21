"""Deterministic checks for the dispensing-line counter and shift logic."""
import os, sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.detector import Detection  # noqa: E402
from src.line_counter import LineCounter  # noqa: E402
from src.shifts import ShiftWatcher, current_shift, shift_key  # noqa: E402

WH = (1000, 600)  # frame size used in these tests


def det(label, cx, cy, tid):
    return Detection(label, 0.9, (cx - 10, cy - 10, cx + 10, cy + 10), track_id=tid)


def test_counts_once_when_crossing():
    lc = LineCounter(p1=(0.0, 0.5), p2=(1.0, 0.5))  # horizontal at y=300
    # a cup moving down across the line
    for y in (200, 250, 290, 310, 350, 400):
        lc.update([det("cup", 500, y, 1)], y / 100, WH)
    assert lc.counts.get("cup") == 1, f"expected 1 cup, got {lc.counts}"
    # keep moving — must not count again
    for y in (450, 500):
        lc.update([det("cup", 500, y, 1)], y / 100, WH)
    assert lc.counts.get("cup") == 1, "counted the same track twice"
    print("  crossing counted exactly once ✓")


def test_no_count_without_crossing():
    lc = LineCounter(p1=(0.0, 0.5), p2=(1.0, 0.5))
    for y in (100, 150, 200, 250, 290):  # stays above the line
        lc.update([det("cup", 500, y, 2)], y / 100, WH)
    assert not lc.counts, f"nothing should be counted, got {lc.counts}"


def test_direction_filter():
    # only count downward (positive) crossings
    lc = LineCounter(p1=(0.0, 0.5), p2=(1.0, 0.5), direction="positive")
    for y in (400, 350, 310, 290, 250):   # moving UP across the line
        lc.update([det("cup", 500, y, 3)], y / 100, WH)
    assert not lc.counts, f"upward crossing should be ignored, got {lc.counts}"
    for y in (200, 290, 310, 400):        # now DOWN across
        lc.update([det("cup", 500, y, 4)], y / 100, WH)
    assert lc.counts.get("cup") == 1, f"downward crossing should count, got {lc.counts}"
    print("  direction filter works ✓")


def test_off_segment_not_counted():
    # line spans only the left half; object crosses on the right => ignore
    lc = LineCounter(p1=(0.0, 0.5), p2=(0.4, 0.5))
    for y in (200, 290, 310, 400):
        lc.update([det("cup", 900, y, 5)], y / 100, WH)
    assert not lc.counts, f"crossing outside the segment must not count, got {lc.counts}"
    print("  off-segment crossing ignored ✓")


def test_only_product_classes():
    lc = LineCounter(p1=(0.0, 0.5), p2=(1.0, 0.5))
    for y in (200, 290, 310, 400):
        lc.update([det("person", 500, y, 6)], y / 100, WH)
    assert not lc.counts, "a person crossing is not a sale"


def test_diagonal_line():
    lc = LineCounter(p1=(0.0, 0.0), p2=(1.0, 1.0))  # diagonal
    # move across the diagonal from below-right to above-left
    for (x, y) in ((800, 200), (600, 300), (400, 350), (200, 400)):
        lc.update([det("bottle", x, y, 7)], 1.0, WH)
    assert lc.counts.get("bottle") == 1, f"diagonal crossing failed: {lc.counts}"
    print("  diagonal line works ✓")


def test_per_class_counts():
    lc = LineCounter(p1=(0.0, 0.5), p2=(1.0, 0.5))
    for tid, label in ((10, "cup"), (11, "cup"), (12, "sandwich")):
        for y in (200, 290, 310, 400):
            lc.update([det(label, 500, y, tid)], 1.0, WH)
    assert lc.counts == {"cup": 2, "sandwich": 1}, lc.counts
    assert lc.total == 3
    print("  per-class totals:", lc.counts)


def test_shifts():
    assert current_shift(datetime(2026, 1, 1, 3)) == 0
    assert current_shift(datetime(2026, 1, 1, 9)) == 1
    assert current_shift(datetime(2026, 1, 1, 20)) == 2
    assert shift_key(datetime(2026, 5, 4, 9)) == ("2026-05-04", 1)
    w = ShiftWatcher()
    assert w.check(datetime(2026, 1, 1, 9)) is None       # first call latches
    assert w.check(datetime(2026, 1, 1, 15)) is None      # same shift
    assert w.check(datetime(2026, 1, 1, 17)) == ("2026-01-01", 1)  # shift ended
    assert w.check(datetime(2026, 1, 2, 1)) == ("2026-01-01", 2)   # crossed midnight
    print("  shift detection ✓")


if __name__ == "__main__":
    for fn in [test_counts_once_when_crossing, test_no_count_without_crossing,
               test_direction_filter, test_off_segment_not_counted,
               test_only_product_classes, test_diagonal_line,
               test_per_class_counts, test_shifts]:
        fn()
    print("OK — line counting (once/direction/segment/diagonal) and shifts all pass.")
