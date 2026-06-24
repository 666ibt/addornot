"""Команды бота и обработка кнопок."""
from __future__ import annotations

import logging

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import CallbackQuery, Message

from . import db, digest

logger = logging.getLogger(__name__)
router = Router()

WELCOME = (
    "👋 Привет! Я <b>Vis</b> — каждый день присылаю тебе:\n\n"
    "🌍 Главные мировые новости\n"
    "📖 Отрывок из стоящей книги\n"
    "👤 Историю одной выдающейся личности\n\n"
    "Ты подписан. Команды:\n"
    "/today — прислать сегодняшнюю подборку сейчас\n"
    "/stop — отписаться\n"
    "/start — подписаться снова"
)


@router.message(Command("start"))
async def cmd_start(message: Message) -> None:
    await db.add_user(message.from_user.id, message.from_user.username)
    await message.answer(WELCOME)


@router.message(Command("stop"))
async def cmd_stop(message: Message) -> None:
    await db.unsubscribe(message.from_user.id)
    await message.answer("Готово, отписал. Возвращайся через /start 👋")


@router.message(Command("today"))
async def cmd_today(message: Message) -> None:
    content = await digest.build()
    if not (content.news_text or content.book_text or content.person_text):
        await message.answer("Свежий контент пока не добавлен 🙂")
        return
    await digest.send(message, message.from_user.id, content)


@router.callback_query(F.data == "book_full")
async def on_book_full(callback: CallbackQuery) -> None:
    await callback.answer()
    saved = await db.get_last_book(callback.from_user.id)
    if not saved:
        await callback.message.answer("Не помню, о какой книге речь — дождись следующего отрывка 🙂")
        return
    _title, _author, where_to_read = saved
    if where_to_read:
        await callback.message.answer(where_to_read)
    else:
        await callback.message.answer(
            "Для этой книги не указано, где её прочитать. Поищи по названию в "
            "библиотеке или книжных сервисах 🙂"
        )
