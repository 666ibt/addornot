"""Per-worker activity recognition (object-driven, no pose).

For each tracked **person** we decide what they're doing from the objects the
detector sees *associated with that person* (a phone/food/cup near them) plus how
much the person is moving. Each worker gets their own state and their own
timers, so we can say "worker #5 has been on their phone for 47 s".

Activities: ``using_phone``, ``eating``, ``making_drink``, ``working``, ``idle``.
Derived alert: **phone_on_workplace** — fired once when a worker's *continuous*
phone use crosses ``phone_alert_seconds`` (default 45 s).

--------------------------------------------------------------------------
SWAPPING IN A TRAINED MODEL (future "real learning" phase)
--------------------------------------------------------------------------
``ActivityRecognizer`` is the interface: ``update(frame_index, ts, persons,
objects) -> ActivityFrameResult``. The rule-based class below is one
implementation. To go ML-based, label spans of your footage per worker, train a
per-track temporal classifier over (person crop / associated-object features),
and implement a new subclass with the *same* signature and the same activity
labels. Nothing in the pipeline or UI changes. The per-track bookkeeping here
(episode timing, the 45 s alert) can be reused around a learned per-frame label.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional, Tuple

# ---- label -> category ----------------------------------------------------
# Works for both YOLO-World prompt labels and native COCO names.
_PHONE = {"cell phone", "phone", "mobile phone", "tablet", "smartphone"}
# NOTE: `bowl` is deliberately NOT food here — on a coffee bar, off-the-shelf
# detectors read cups/containers as "bowl" constantly (1875 hits in the test
# video), which would false-trigger "eating". Real food items only.
_FOOD = {
    "food", "snack", "sandwich", "donut", "doughnut", "cake", "pizza",
    "hot dog", "banana", "apple", "orange",
}
_DRINK = {
    "cup", "coffee cup", "paper cup", "drinking cup", "wine glass",
    "milk pitcher", "bottle", "bowl",
}


def category_of(label: str) -> Optional[str]:
    l = label.lower()
    if l in _PHONE:
        return "phone"
    if l in _FOOD:
        return "food"
    if l in _DRINK:
        return "drink"
    return None


ACTIVITIES = ["using_phone", "eating", "making_drink", "working", "idle"]


@dataclass
class PersonActivity:
    track_id: int
    activity: str
    box: Tuple[int, int, int, int]
    duration: float          # seconds in the current committed activity
    phone_seconds: float     # continuous phone-use seconds (0 if not on phone)
    phone_alert: bool        # True once this phone episode passed the threshold
    associated: List[str] = field(default_factory=list)  # object labels near them


@dataclass
class ActivityEvent:
    event_type: str          # 'activity' | 'alert'
    track_id: int
    label: str               # activity name, or 'phone_on_workplace' for alerts
    ts: float
    duration: float = 0.0     # seconds (prev activity length, or phone length)
    detail: str = ""


@dataclass
class ActivityFrameResult:
    persons: List[PersonActivity]
    events: List[ActivityEvent]


class ActivityRecognizer:
    """Interface: one call per frame with the frame's persons + objects."""

    def update(
        self, frame_index: int, ts: float,
        persons: List, objects: List,
    ) -> ActivityFrameResult:  # pragma: no cover
        raise NotImplementedError


# ---- internal per-track state --------------------------------------------
@dataclass
class _Track:
    committed: str = "idle"
    committed_since: float = 0.0
    candidate: str = "idle"
    candidate_since: float = 0.0
    last_seen: float = 0.0
    centroids: Deque[Tuple[float, float]] = field(default_factory=lambda: deque(maxlen=30))
    # phone episode
    phone_start: Optional[float] = None
    phone_last: float = 0.0
    phone_alerted: bool = False


class RuleBasedActivityRecognizer(ActivityRecognizer):
    def __init__(
        self,
        fps: float = 15.0,
        phone_alert_seconds: float = 45.0,
        commit_seconds: float = 0.6,      # debounce before switching activity
        motion_window_seconds: float = 1.0,
        motion_threshold: float = 6.0,    # px stddev of person centroid => "moving"
        assoc_expand: float = 0.35,       # expand person box by this frac for assoc
        phone_gap_seconds: float = 2.5,   # phone use may blink out this long w/o reset
        track_expire_seconds: float = 2.0,
    ) -> None:
        self.fps = max(fps, 1.0)
        self.phone_alert_seconds = phone_alert_seconds
        self.commit_seconds = commit_seconds
        self.motion_window = max(int(self.fps * motion_window_seconds), 3)
        self.motion_threshold = motion_threshold
        self.assoc_expand = assoc_expand
        self.phone_gap_seconds = phone_gap_seconds
        self.track_expire_seconds = track_expire_seconds
        self._tracks: Dict[int, _Track] = {}

    # -- helpers ----------------------------------------------------------
    @staticmethod
    def _expanded(box, frac):
        x1, y1, x2, y2 = box
        w, h = x2 - x1, y2 - y1
        return (x1 - w * frac, y1 - h * frac, x2 + w * frac, y2 + h * frac)

    @staticmethod
    def _contains(box, pt):
        x1, y1, x2, y2 = box
        return x1 <= pt[0] <= x2 and y1 <= pt[1] <= y2

    def _motion(self, tr: _Track) -> float:
        c = list(tr.centroids)[-self.motion_window:]
        if len(c) < 3:
            return 0.0
        xs = [p[0] for p in c]; ys = [p[1] for p in c]
        mx = sum(xs) / len(xs); my = sum(ys) / len(ys)
        var = sum((x - mx) ** 2 + (y - my) ** 2 for x, y in c) / len(c)
        return var ** 0.5

    def _raw_activity(self, cats, moving) -> str:
        if "phone" in cats:
            return "using_phone"
        if "food" in cats:
            return "eating"
        # A cup near a worker only means "making a drink" if they're actually
        # handling it (moving). Static counter cups near a still worker -> idle.
        if "drink" in cats and moving:
            return "making_drink"
        return "working" if moving else "idle"

    # -- main -------------------------------------------------------------
    def update(self, frame_index, ts, persons, objects) -> ActivityFrameResult:
        events: List[ActivityEvent] = []
        out: List[PersonActivity] = []

        # 1) associate each object to the nearest containing person
        assoc: Dict[int, List[str]] = defaultdict(list)
        pboxes = [(p.track_id, self._expanded(p.box, self.assoc_expand), p) for p in persons if p.track_id is not None]
        for o in objects:
            cat = category_of(o.label)
            if cat is None:
                continue
            oc = o.center
            best = None; bestd = 1e18
            for tid, ebox, p in pboxes:
                if self._contains(ebox, oc):
                    pc = p.center
                    d = (pc[0] - oc[0]) ** 2 + (pc[1] - oc[1]) ** 2
                    if d < bestd:
                        bestd = d; best = tid
            if best is not None:
                assoc[best].append(o.label)

        seen = set()
        for p in persons:
            tid = p.track_id
            if tid is None:
                continue
            seen.add(tid)
            tr = self._tracks.get(tid)
            if tr is None:
                tr = _Track(committed_since=ts, candidate_since=ts, last_seen=ts)
                self._tracks[tid] = tr
            tr.last_seen = ts
            tr.centroids.append(p.center)

            labels = assoc.get(tid, [])
            cats = {category_of(l) for l in labels}
            moving = self._motion(tr) > self.motion_threshold
            raw = self._raw_activity(cats, moving)

            # debounce: commit only after commit_seconds of agreement
            if raw != tr.candidate:
                tr.candidate = raw
                tr.candidate_since = ts
            if raw != tr.committed and (ts - tr.candidate_since) >= self.commit_seconds:
                prev = tr.committed
                events.append(ActivityEvent("activity", tid, tr.committed,
                                            ts, duration=ts - tr.committed_since,
                                            detail=f"-> {raw}"))
                tr.committed = raw
                tr.committed_since = ts

            # phone episode timing (independent of debounce so 45s is real time)
            if "phone" in cats:
                if tr.phone_start is None or (ts - tr.phone_last) > self.phone_gap_seconds:
                    tr.phone_start = ts
                    tr.phone_alerted = False
                tr.phone_last = ts
            phone_secs = 0.0
            if tr.phone_start is not None and (ts - tr.phone_last) <= self.phone_gap_seconds:
                phone_secs = ts - tr.phone_start
                if phone_secs >= self.phone_alert_seconds and not tr.phone_alerted:
                    tr.phone_alerted = True
                    events.append(ActivityEvent("alert", tid, "phone_on_workplace",
                                                ts, duration=phone_secs,
                                                detail=f"worker #{tid} on phone >{int(self.phone_alert_seconds)}s"))
            else:
                tr.phone_start = None

            out.append(PersonActivity(
                track_id=tid, activity=tr.committed, box=p.box,
                duration=ts - tr.committed_since,
                phone_seconds=phone_secs, phone_alert=tr.phone_alerted,
                associated=labels,
            ))

        # 2) expire stale tracks
        for tid in [t for t, tr in self._tracks.items()
                    if ts - tr.last_seen > self.track_expire_seconds and t not in seen]:
            del self._tracks[tid]

        return ActivityFrameResult(persons=out, events=events)
