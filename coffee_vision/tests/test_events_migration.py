"""An events.db created by an older version must keep working.

Regression test: the day/shift index used to live in SCHEMA, so opening a
pre-existing database failed with `no such column: day` before the migration
had a chance to add the columns.
"""
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.events import Event, EventStore  # noqa: E402
from src.shifts import shift_key  # noqa: E402

OLD_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, video_ts REAL,
    event_type TEXT NOT NULL, label TEXT NOT NULL, track_id INTEGER,
    confidence REAL, duration REAL, detail TEXT, session_id TEXT);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
"""


def test_opens_and_migrates_old_database():
    path = os.path.join(tempfile.mkdtemp(), "events.db")
    c = sqlite3.connect(path)
    c.executescript(OLD_SCHEMA)
    c.execute("INSERT INTO events (ts, event_type, label) VALUES (1, 'activity', 'idle')")
    c.commit()
    c.close()

    store = EventStore(path, session_id="t")          # must not raise
    cols = {r[1] for r in store.conn.execute("PRAGMA table_info(events)")}
    assert {"day", "shift"} <= cols, f"migration did not add columns: {cols}"

    # old rows survive
    assert store.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
    # new rows are stamped and queryable by shift
    store.log(Event("sale", "cup", track_id=7))
    day, shift = shift_key()
    assert store.counts_for_shift(day, shift, "sale") == [("cup", 1)]
    idx = {r[0] for r in store.conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index'")}
    assert "idx_events_shift" in idx, idx
    print("  old DB migrated, rows kept, shift queries work ✓")


def test_fresh_database():
    path = os.path.join(tempfile.mkdtemp(), "fresh.db")
    store = EventStore(path, session_id="t")
    store.log(Event("sale", "cup"))
    day, shift = shift_key()
    assert store.counts_for_shift(day, shift, "sale") == [("cup", 1)]
    print("  fresh DB works ✓")


if __name__ == "__main__":
    test_opens_and_migrates_old_database()
    test_fresh_database()
    print("OK — events.db migration from the old schema works.")
