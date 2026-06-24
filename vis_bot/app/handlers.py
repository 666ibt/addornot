"""Команды бота и обработка кнопок."""
from __future__ import annotations

import logging
import os

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import CallbackQuery, FSInputFile, Message

from . import content_store, db, digest, docgen

logger = logging.getLogger(__name__)
router = Router()

# Настраивается из bot.py.
_admin_ids: list[int] = []
_schedule_text: str = ""


def configure_handlers(admin_ids: list[int], hour: int, minute: int, timezone: str) -> None:
    global _admin_ids, _schedule_text
    _admin_ids = admin_ids
    _schedule_text = f"{hour:02d}:{minute:02d} ({timezone})"


def _is_admin(user_id: int) -> bool:
    return user_id in _admin_ids


@router.message(Command("start"))
async def cmd_start(message: Message) -> None:
    await db.add_user(message.from_user.id, message.from_user.username)
    await message.answer(
        "✅ Готово, ты подписан на <b>Vis</b>!\n\n"
        f"Каждый день в <b>{_schedule_text}</b> пришлю подборку: новости, "
        "отрывок книги и личность дня.\n\n"
        "Отписаться — /stop"
    )


@router.message(Command("stop"))
async def cmd_stop(message: Message) -> None:
    await db.unsubscribe(message.from_user.id)
    await message.answer("Отписал. Возвращайся через /start 👋")


@router.message(Command("today"))
async def cmd_today(message: Message) -> None:
    # Только для администратора — обычным пользователям недоступно.
    if not _is_admin(message.from_user.id):
        return
    await digest.ensure_today()
    sent = await digest.send_news(message)
    if not sent:
        await message.answer("На сегодня контент ещё не добавлен.")


@router.callback_query(F.data == "go_book")
async def on_go_book(callback: CallbackQuery) -> None:
    await callback.answer()
    current = await db.get_current_digest()
    entry = content_store.find("book", current["book_key"]) if current else None
    if not entry:
        await callback.message.answer("Отрывок на сегодня недоступен.")
        return
    has_file = content_store.book_full_path(entry) is not None
    has_person = bool(current and current["person_key"])
    await callback.message.answer(
        content_store.render_book(entry),
        reply_markup=digest.book_keyboard(has_file, has_person),
    )


@router.callback_query(F.data == "book_file")
async def on_book_file(callback: CallbackQuery) -> None:
    await callback.answer()
    current = await db.get_current_digest()
    entry = content_store.find("book", current["book_key"]) if current else None
    path = content_store.book_full_path(entry) if entry else None
    if not path:
        await callback.message.answer(
            "Полная версия этой книги пока недоступна для скачивания."
        )
        return
    # EPUB открывается в приложении Books на iOS (через «Поделиться» → Books).
    await callback.message.answer_document(
        FSInputFile(str(path), filename=path.name),
        caption="Полная версия. На iPhone: «Поделиться» → <b>Books</b>.",
    )


@router.callback_query(F.data == "go_person")
async def on_go_person(callback: CallbackQuery) -> None:
    await callback.answer()
    current = await db.get_current_digest()
    entry = content_store.find("person", current["person_key"]) if current else None
    if not entry:
        await callback.message.answer("Личность на сегодня недоступна.")
        return
    path, filename = docgen.build_person_docx(entry)
    try:
        await callback.message.answer_document(
            FSInputFile(path, filename=filename),
            caption="👤 Личность дня",
        )
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
