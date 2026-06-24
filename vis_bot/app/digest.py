"""Сборка дневной подборки из файлового контента и отправка получателям.

Подборка собирается ОДИН раз за рассылку: бот берёт по одной ещё не отправленной
записи из news/books/persons (антидубли через таблицу sent_items) и шлёт всем
подписчикам одинаковый контент.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from . import content_store, db

logger = logging.getLogger(__name__)


@dataclass
class Digest:
    news_text: str | None = None
    book_text: str | None = None
    book_entry: dict | None = None
    person_text: str | None = None


def full_book_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="📚 Где прочитать целиком", callback_data="book_full")]
        ]
    )


async def _pick(category: str) -> tuple[dict, str] | None:
    """Первая ещё не отправленная запись категории + её ключ."""
    entries = content_store.load(category)
    if not entries:
        return None
    used = await db.sent_keys(category)
    for entry in entries:
        key = content_store.entry_key(category, entry)
        if key not in used:
            return entry, key
    logger.warning("Свежие записи в категории '%s' закончились — добавь новые", category)
    return None


async def build() -> Digest:
    """Собирает подборку и фиксирует выбранные записи в истории."""
    digest = Digest()

    if (picked := await _pick("news")) is not None:
        entry, key = picked
        digest.news_text = content_store.render_news(entry)
        await db.remember_item("news", key)

    if (picked := await _pick("book")) is not None:
        entry, key = picked
        digest.book_entry = entry
        digest.book_text = content_store.render_book(entry)
        await db.remember_item("book", key)

    if (picked := await _pick("person")) is not None:
        entry, key = picked
        digest.person_text = content_store.render_person(entry)
        await db.remember_item("person", key)

    return digest


async def send(target, user_id: int, digest: Digest) -> None:
    """Отправляет готовую подборку одному получателю (target имеет .answer())."""
    if digest.news_text:
        await target.answer(digest.news_text)

    if digest.book_text and digest.book_entry is not None:
        title = digest.book_entry.get("title", "")
        author = digest.book_entry.get("author", "")
        where = digest.book_entry.get("where_to_read", "")
        await db.set_last_book(user_id, title, author, where)
        await target.answer(digest.book_text, reply_markup=full_book_keyboard())

    if digest.person_text:
        await target.answer(digest.person_text)
