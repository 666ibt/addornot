"""SQLite event store.

Event kinds in one table:
  * ``object``   — an object was first seen (one row per track id).
  * ``activity`` — a worker's committed activity changed (with the duration of
    the activity that just ended, and their track id).
  * ``alert``    — a derived alert, e.g. ``phone_on_workplace`` (worker on their
    phone longer than the threshold), with the phone-use duration.

Schema is created on first use; no migrations, no external DB.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          REAL    NOT NULL,   -- wall-clock unix time the row was written
    video_ts    REAL,               -- seconds into the video/stream
    event_type  TEXT    NOT NULL,   -- 'object' | 'activity' | 'alert'
    label       TEXT    NOT NULL,
    track_id    INTEGER,            -- worker/object track id when applicable
    confidence  REAL,
    duration    REAL,               -- seconds (activity length / phone-use length)
    detail      TEXT,
    session_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
"""


@dataclass
class Event:
    event_type: str
    label: str
    track_id: Optional[int] = None
    confidence: Optional[float] = None
    duration: Optional[float] = None
    detail: Optional[str] = None
    video_ts: Optional[float] = None
    ts: float = 0.0
    id: Optional[int] = None


class EventStore:
    def __init__(self, db_path: str | Path = "events.db", session_id: str = "default"):
        self.db_path = str(db_path)
        self.session_id = session_id
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self) -> None:
        """Add any columns missing from an older events.db (no-op if current)."""
        have = {r["name"] for r in self.conn.execute("PRAGMA table_info(events)")}
        for col, decl in [("track_id", "INTEGER"), ("duration", "REAL"),
                          ("detail", "TEXT"), ("video_ts", "REAL"),
                          ("confidence", "REAL")]:
            if col not in have:
                self.conn.execute(f"ALTER TABLE events ADD COLUMN {col} {decl}")

    def log(self, event: Event) -> int:
        ts = event.ts or time.time()
        cur = self.conn.execute(
            """INSERT INTO events
               (ts, video_ts, event_type, label, track_id, confidence, duration, detail, session_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                ts, event.video_ts, event.event_type, event.label, event.track_id,
                event.confidence, event.duration, event.detail, self.session_id,
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def recent(self, limit: int = 50, session_only: bool = True,
               event_types: Optional[List[str]] = None) -> List[sqlite3.Row]:
        q = "SELECT * FROM events WHERE 1=1"
        args: list = []
        if session_only:
            q += " AND session_id=?"; args.append(self.session_id)
        if event_types:
            q += f" AND event_type IN ({','.join('?' * len(event_types))})"
            args += event_types
        q += " ORDER BY id DESC LIMIT ?"; args.append(limit)
        return self.conn.execute(q, args).fetchall()

    def counts(self, event_type: str, session_only: bool = True):
        """Return [(label, n), ...] for the given event_type."""
        if session_only:
            rows = self.conn.execute(
                """SELECT label, COUNT(*) AS n FROM events
                   WHERE event_type=? AND session_id=?
                   GROUP BY label ORDER BY n DESC""",
                (event_type, self.session_id),
            ).fetchall()
        else:
            rows = self.conn.execute(
                """SELECT label, COUNT(*) AS n FROM events
                   WHERE event_type=? GROUP BY label ORDER BY n DESC""",
                (event_type,),
            ).fetchall()
        return [(r["label"], r["n"]) for r in rows]

    def clear_session(self) -> None:
        self.conn.execute("DELETE FROM events WHERE session_id=?", (self.session_id,))
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
