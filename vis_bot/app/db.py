"""Хранилище на aiosqlite.

Таблицы:
- users           — подписчики;
- sent_items      — история отправленного контента (антидубли);
- current_digest  — выбранные на сегодня записи (по ним работают кнопки).
"""
from __future__ import annotations

import aiosqlite

_db_path: str = "vis.db"


def configure(db_path: str) -> None:
    global _db_path
    _db_path = db_path


async def init() -> None:
    async with aiosqlite.connect(_db_path) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id    INTEGER PRIMARY KEY,
                username   TEXT,
                subscribed INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS sent_items (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                category   TEXT NOT NULL,
                item_key   TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS current_digest (
                id         INTEGER PRIMARY KEY CHECK (id = 1),
                day        TEXT,
                news_text  TEXT,
                book_key   TEXT,
                person_key TEXT
            )
            """
        )
        # Для баз, созданных раньше (была колонка news_key): добавляем news_text.
        try:
            await db.execute("ALTER TABLE current_digest ADD COLUMN news_text TEXT")
        except Exception:
            pass
        await db.commit()


# --- Подписчики ---

async def add_user(user_id: int, username: str | None) -> None:
    async with aiosqlite.connect(_db_path) as db:
        await db.execute(
            """
            INSERT INTO users (user_id, username, subscribed)
            VALUES (?, ?, 1)
            ON CONFLICT(user_id) DO UPDATE SET subscribed = 1, username = excluded.username
            """,
            (user_id, username),
        )
        await db.commit()


async def unsubscribe(user_id: int) -> None:
    async with aiosqlite.connect(_db_path) as db:
        await db.execute("UPDATE users SET subscribed = 0 WHERE user_id = ?", (user_id,))
        await db.commit()


async def get_subscribers() -> list[int]:
    async with aiosqlite.connect(_db_path) as db:
        async with db.execute("SELECT user_id FROM users WHERE subscribed = 1") as cur:
            rows = await cur.fetchall()
    return [row[0] for row in rows]


# --- Антидубли ---

async def sent_keys(category: str) -> set[str]:
    async with aiosqlite.connect(_db_path) as db:
        async with db.execute(
            "SELECT item_key FROM sent_items WHERE category = ?", (category,)
        ) as cur:
            rows = await cur.fetchall()
    return {row[0] for row in rows}


async def remember_item(category: str, item_key: str) -> None:
    async with aiosqlite.connect(_db_path) as db:
        await db.execute(
            "INSERT INTO sent_items (category, item_key) VALUES (?, ?)",
            (category, item_key),
        )
        await db.commit()


# --- Текущая подборка дня ---

async def get_current_digest() -> dict | None:
    async with aiosqlite.connect(_db_path) as db:
        async with db.execute(
            "SELECT day, news_text, book_key, person_key FROM current_digest WHERE id = 1"
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return None
    return {"day": row[0], "news_text": row[1], "book_key": row[2], "person_key": row[3]}


async def set_current_digest(
    day: str, news_text: str | None, book_key: str | None, person_key: str | None
) -> None:
    async with aiosqlite.connect(_db_path) as db:
        await db.execute(
            """
            INSERT INTO current_digest (id, day, news_text, book_key, person_key)
            VALUES (1, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                day = excluded.day,
                news_text = excluded.news_text,
                book_key = excluded.book_key,
                person_key = excluded.person_key
            """,
            (day, news_text, book_key, person_key),
        )
        await db.commit()
