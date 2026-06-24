"""Подборка дня и пошаговый показ контента через кнопки.

Логика «одно сообщение за раз»:
- рассылается ТОЛЬКО сообщение с новостями + кнопка «Перейти к отрывку дня»;
- отрывок и личность пользователь раскрывает кнопками.

Выбранные на сегодня записи фиксируются в current_digest (идемпотентно по дате),
поэтому кнопки у всех подписчиков ведут к одному и тому же контенту дня.
"""
from __future__ import annotations

import datetime as _dt
import logging

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from . import content_store, db, news_rss

logger = logging.getLogger(__name__)


def _today() -> str:
    return _dt.date.today().isoformat()


async def _pick(category: str) -> str | None:
    """Ключ первой ещё не отправленной записи категории (или None)."""
    entries = content_store.load(category)
    if not entries:
        return None
    used = await db.sent_keys(category)
    for entry in entries:
        key = content_store.entry_key(category, entry)
        if key not in used:
            return key
    logger.warning("Свежие записи в категории '%s' закончились — добавь новые", category)
    return None


async def _news_text() -> str | None:
    """Текст новостей дня: из RSS (если включён), иначе из файла news.json."""
    if news_rss.enabled():
        try:
            text = await news_rss.fetch_text()
            if text:
                return text
            logger.warning("RSS не дал новостей — пробую файл news.json")
        except Exception:
            logger.exception("Сбой RSS — пробую файл news.json")

    key = await _pick("news")
    if not key:
        return None
    await db.remember_item("news", key)
    entry = content_store.find("news", key)
    return content_store.render_news(entry) if entry else None


async def ensure_today() -> dict:
    """Возвращает подборку на сегодня, создавая её при наступлении нового дня."""
    current = await db.get_current_digest()
    if current and current["day"] == _today():
        return current

    news_text = await _news_text()
    book_key = await _pick("book")
    if book_key:
        await db.remember_item("book", book_key)
    person_key = await _pick("person")
    if person_key:
        await db.remember_item("person", person_key)

    await db.set_current_digest(_today(), news_text, book_key, person_key)
    logger.info(
        "Подборка на %s собрана (news=%s, book=%s, person=%s)",
        _today(), bool(news_text), book_key, person_key,
    )
    return await db.get_current_digest()  # type: ignore[return-value]


# --- Клавиатуры ---


def _news_keyboard(has_book: bool) -> InlineKeyboardMarkup | None:
    if not has_book:
        return None
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="📖 Перейти к отрывку дня", callback_data="go_book")]
        ]
    )


def book_keyboard(has_file: bool, has_person: bool) -> InlineKeyboardMarkup | None:
    rows = []
    if has_file:
        rows.append([InlineKeyboardButton(text="⬇️ Скачать полную версию", callback_data="book_file")])
    if has_person:
        rows.append([InlineKeyboardButton(text="👤 Перейти к личности дня", callback_data="go_person")])
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


# --- Отправка стартового (новостного) сообщения ---


async def send_news(target) -> bool:
    """Отправляет сообщение с новостями + кнопкой. target имеет .answer().

    Возвращает False, если новостей на сегодня нет.
    """
    current = await db.get_current_digest()
    if not current or not current["news_text"]:
        return False
    await target.answer(
        current["news_text"],
        reply_markup=_news_keyboard(bool(current["book_key"])),
    )
    return True
