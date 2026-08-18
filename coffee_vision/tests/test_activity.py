"""Deterministic checks for the rule-based worker-activity recognizer.

No model/video needed — feed synthetic Detections and assert activities + the
45s phone alert. Run: python tests/test_activity.py  (or: python -m pytest tests/)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.detector import Detection  # noqa: E402
from src.activity import RuleBasedActivityRecognizer  # noqa: E402


def person(tid, cx=300, cy=300, w=120, h=200):
    return Detection("person", 0.9, (cx - w // 2, cy - h // 2, cx + w // 2, cy + h // 2), track_id=tid)


def obj(label, cx, cy, tid=None):
    return Detection(label, 0.6, (cx - 15, cy - 15, cx + 15, cy + 15), track_id=tid)


def run(rec, frames, fps=15.0):
    """frames: list of (persons, objects); returns all events."""
    evs = []
    for i, (ps, os_) in enumerate(frames):
        r = rec.update(i, i / fps, ps, os_)
        evs += r.events
    return evs, r.persons


def test_phone_alert_after_threshold():
    fps = 15.0
    rec = RuleBasedActivityRecognizer(fps=fps, phone_alert_seconds=45.0, commit_seconds=0.6)
    # 50 seconds of a worker holding a phone at their center
    n = int(50 * fps)
    frames = [([person(7)], [obj("cell phone", 300, 300)]) for _ in range(n)]
    evs, persons = run(rec, frames, fps)
    alerts = [e for e in evs if e.event_type == "alert" and e.label == "phone_on_workplace"]
    assert alerts, "expected a phone_on_workplace alert"
    assert 44.0 <= alerts[0].duration <= 47.0, f"alert fired at wrong time: {alerts[0].duration:.1f}s"
    assert persons[0].activity == "using_phone"
    print(f"  phone alert fired at {alerts[0].duration:.1f}s for worker #{alerts[0].track_id}")


def test_short_phone_use_no_alert():
    fps = 15.0
    rec = RuleBasedActivityRecognizer(fps=fps, phone_alert_seconds=45.0)
    n = int(20 * fps)  # only 20s on phone -> no alert
    frames = [([person(7)], [obj("cell phone", 300, 300)]) for _ in range(n)]
    evs, _ = run(rec, frames, fps)
    assert not [e for e in evs if e.event_type == "alert"], "should not alert under threshold"


def test_activities_reachable():
    fps = 15.0
    got = set()
    # phone/food don't need motion; making_drink requires the worker to move.
    for label_obj, expect, move in [("cell phone", "using_phone", False),
                                    ("sandwich", "eating", False),
                                    ("cup", "making_drink", True)]:
        rec = RuleBasedActivityRecognizer(fps=fps, commit_seconds=0.4)
        frames = []
        for i in range(int(3 * fps)):
            cx = 300 + (25 if i % 2 else -25) if move else 300
            frames.append(([person(1, cx=cx)], [obj(label_obj, cx, 300)]))
        _, persons = run(rec, frames, fps)
        got.add(persons[0].activity)
        assert persons[0].activity == expect, f"{label_obj} -> {persons[0].activity}, want {expect}"
    # idle: person alone, still
    rec = RuleBasedActivityRecognizer(fps=fps, commit_seconds=0.4)
    _, persons = run(rec, [([person(1)], []) for _ in range(int(3 * fps))], fps)
    got.add(persons[0].activity)
    assert persons[0].activity == "idle"
    print("  activities reached:", got)


def test_two_workers_independent_timers():
    fps = 15.0
    rec = RuleBasedActivityRecognizer(fps=fps, phone_alert_seconds=45.0)
    n = int(50 * fps)
    frames = []
    for _ in range(n):
        # worker 1 on phone, worker 2 idle
        frames.append(([person(1, cx=200), person(2, cx=600)],
                       [obj("cell phone", 200, 300)]))
    evs, persons = run(rec, frames, fps)
    alerts = [e for e in evs if e.event_type == "alert"]
    assert len(alerts) == 1 and alerts[0].track_id == 1, "only worker #1 should alert"
    acts = {p.track_id: p.activity for p in persons}
    assert acts[2] == "idle", f"worker #2 should be idle, got {acts[2]}"


if __name__ == "__main__":
    test_phone_alert_after_threshold()
    test_short_phone_use_no_alert()
    test_activities_reachable()
    test_two_workers_independent_timers()
    print("OK — activity rules, 45s phone alert, and per-worker timers all pass.")
