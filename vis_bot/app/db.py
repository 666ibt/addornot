"""Хранилище подписчиков и состояния на aiosqlite.

Таблицы:
- users     — кто подписан на рассылку;
- last_book — последняя книга, отрывок из которой получил пользователь
              (нужно, чтобы по кнопке прислать полную версию).
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
            CREATE TABLE IF NOT EXISTS last_book (
                user_id INTEGER PRIMARY KEY,
                title   TEXT NOT NULL,
                author  TEXT NOT NULL
            )
            """
        )
        # История уже отправленного контента — чтобы книги и личности не повторялись.
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
        await db.commit()


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


async def set_last_book(user_id: int, title: str, author: str) -> None:
    async with aiosqlite.connect(_db_path) as db:
        await db.execute(
            """
            INSERT INTO last_book (user_id, title, author) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET title = excluded.title, author = excluded.author
            """,
            (user_id, title, author),
        )
        await db.commit()


async def get_last_book(user_id: int) -> tuple[str, str] | None:
    async with aiosqlite.connect(_db_path) as db:
        async with db.execute(
            "SELECT title, author FROM last_book WHERE user_id = ?", (user_id,)
        ) as cur:
            row = await cur.fetchone()
    return (row[0], row[1]) if row else None


async def recent_items(category: str, limit: int = 40) -> list[str]:
    """Последние отправленные элементы категории ('book' / 'person')."""
    async with aiosqlite.connect(_db_path) as db:
        async with db.execute(
            "SELECT item_key FROM sent_items WHERE category = ? ORDER BY id DESC LIMIT ?",
            (category, limit),
        ) as cur:
            rows = await cur.fetchall()
    return [row[0] for row in rows]


async def remember_item(category: str, item_key: str) -> None:
    async with aiosqlite.connect(_db_path) as db:
        await db.execute(
            "INSERT INTO sent_items (category, item_key) VALUES (?, ?)",
            (category, item_key),
        )
        await db.commit()
