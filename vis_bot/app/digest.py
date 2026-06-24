"""Сборка дневной подборки один раз и отправка её получателям.

Контент (новости, книга, личность) генерируется ОДИН раз за рассылку, а не для
каждого подписчика. Книга и личность записываются в историю, чтобы не
повторяться (антидубли). Новости не дедуплицируются — они и так привязаны ко дню.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from . import db
from .content import book, news, person

logger = logging.getLogger(__name__)

# Имя личности — текст внутри первого <b>...</b> в заметке (формат «👤 <b>Имя</b> …»).
_NAME_RE = re.compile(r"<b>(.*?)</b>", re.DOTALL)


@dataclass
class Digest:
    news_text: str | None = None
    book: tuple[str, str, str] | None = None  # (title, author, message_html)
    person_text: str | None = None


def full_book_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="📚 Где прочитать целиком", callback_data="book_full")]
        ]
    )


async def build() -> Digest:
    """Генерирует подборку и фиксирует выбранные книгу/личность в истории."""
    digest = Digest()

    # Новости (без дедупликации).
    try:
        digest.news_text = await news.daily_news()
    except Exception:
        logger.exception("Не удалось сформировать новости")

    # Книга — с учётом недавно отправленных.
    try:
        exclude = await db.recent_items("book")
        title, author, text = await book.daily_book(exclude)
        digest.book = (title, author, text)
        await db.remember_item("book", f"{title} — {author}")
    except Exception:
        logger.exception("Не удалось сформировать книжный отрывок")

    # Личность — с учётом недавно отправленных.
    try:
        exclude = await db.recent_items("person")
        digest.person_text = await person.daily_person(exclude)
        match = _NAME_RE.search(digest.person_text or "")
        if match:
            name = match.group(1).strip()
            if name:
                await db.remember_item("person", name)
    except Exception:
        logger.exception("Не удалось сформировать заметку о личности")

    return digest


async def send(target, user_id: int, digest: Digest) -> None:
    """Отправляет готовую подборку одному получателю (target имеет .answer())."""
    if digest.news_text:
        await target.answer(digest.news_text)

    if digest.book:
        title, author, text = digest.book
        # Запоминаем книгу для этого пользователя — нужно для кнопки «полная версия».
        await db.set_last_book(user_id, title, author)
        await target.answer(text, reply_markup=full_book_keyboard())

    if digest.person_text:
        await target.answer(digest.person_text)
