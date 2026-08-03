"""Deterministic checks for the rule-based ActionRecognizer.

These don't need any model/video — they feed hand-built FrameContexts and assert
that every action label is reachable and that the debounce holds. Run with:

    python -m pytest tests/ -q       # or: python tests/test_action_recognizer.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.action_recognizer import (  # noqa: E402
    ACTIONS,
    FrameContext,
    RuleBasedActionRecognizer,
)


def _drive(rec, ctx, n=6):
    """Feed the same context n times (past the debounce) and return the label."""
    label = "idle"
    for i in range(n):
        label = rec.update(
            FrameContext(frame_index=i, timestamp=i / 25.0, **ctx)
        ).label
    return label


def _jitter(base, i):
    # alternate wrist position to create high motion variance ("active").
    dx = 40 if i % 2 else -40
    return (base[0] + dx, base[1] + dx)


def test_all_actions_reachable():
    reached = set()

    # grinder zone + motion -> grinding_tamping
    rec = RuleBasedActionRecognizer(fps=25, min_hold_frames=2)
    for i in range(8):
        w = _jitter((100, 100), i)
        reached.add(
            rec.update(FrameContext(i, i / 25, None, w, right_zone="grinder")).label
        )

    # group_head, low motion -> espresso_extraction
    rec = RuleBasedActionRecognizer(fps=25, min_hold_frames=2)
    for i in range(8):
        reached.add(
            rec.update(FrameContext(i, i / 25, None, (200, 200), right_zone="group_head")).label
        )

    # steam_wand + pitcher -> milk_steaming
    rec = RuleBasedActionRecognizer(fps=25, min_hold_frames=2)
    for i in range(8):
        reached.add(
            rec.update(
                FrameContext(i, i / 25, None, (300, 300),
                            right_zone="steam_wand", nearby_objects=["milk pitcher"])
            ).label
        )

    # counter + cup + pitcher + motion -> milk_pouring
    rec = RuleBasedActionRecognizer(fps=25, min_hold_frames=2)
    for i in range(8):
        w = _jitter((400, 400), i)
        reached.add(
            rec.update(
                FrameContext(i, i / 25, None, w, right_zone="counter",
                            nearby_objects=["milk pitcher", "coffee cup"])
            ).label
        )

    # no wrist -> idle
    rec = RuleBasedActionRecognizer(fps=25, min_hold_frames=2)
    reached.add(rec.update(FrameContext(0, 0, None, None)).label)

    missing = set(ACTIONS) - reached
    assert not missing, f"unreachable actions: {missing} (got {reached})"


def test_debounce_holds_current_until_min_frames():
    rec = RuleBasedActionRecognizer(fps=25, min_hold_frames=4)
    # one grinder frame shouldn't immediately flip the committed action.
    out = rec.update(FrameContext(0, 0, None, (100, 100), right_zone="grinder"))
    assert out.label == "idle", "single frame should not switch committed action"


if __name__ == "__main__":
    test_all_actions_reachable()
    test_debounce_holds_current_until_min_frames()
    print("OK — all action labels reachable; debounce holds.")
