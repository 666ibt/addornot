"""SQLite event store.

Two event kinds land in one table:
  * ``object`` — a product was seen (deduplicated per track id so we don't write
    one row per frame).
  * ``action`` — the barista's recognized action changed.

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
    event_type  TEXT    NOT NULL,   -- 'object' | 'action'
    label       TEXT    NOT NULL,
    confidence  REAL,
    zone        TEXT,
    session_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
"""


@dataclass
class Event:
    event_type: str
    label: str
    confidence: Optional[float] = None
    zone: Optional[str] = None
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
        self.conn.commit()

    def log(self, event: Event) -> int:
        ts = event.ts or time.time()
        cur = self.conn.execute(
            """INSERT INTO events (ts, video_ts, event_type, label, confidence, zone, session_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                ts,
                event.video_ts,
                event.event_type,
                event.label,
                event.confidence,
                event.zone,
                self.session_id,
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def recent(self, limit: int = 50, session_only: bool = True) -> List[sqlite3.Row]:
        if session_only:
            rows = self.conn.execute(
                "SELECT * FROM events WHERE session_id=? ORDER BY id DESC LIMIT ?",
                (self.session_id, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return rows

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
