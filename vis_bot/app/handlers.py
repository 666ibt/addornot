"""Команды бота и обработка кнопок."""
from __future__ import annotations

import logging

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)

from . import db
from .content import book, news, person

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


def _full_book_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="📚 Где прочитать целиком", callback_data="book_full")]
        ]
    )


async def send_digest(message_target, user_id: int) -> None:
    """Собирает и отправляет полную дневную подборку одному пользователю.

    message_target — объект с методом .answer() (Message) либо bot-обёртка.
    """
    # Новости
    try:
        await message_target.answer(await news.daily_news())
    except Exception:
        logger.exception("Не удалось сформировать новости")

    # Книжный отрывок + кнопка «полная версия»
    try:
        title, author, text = await book.daily_book()
        await db.set_last_book(user_id, title, author)
        await message_target.answer(text, reply_markup=_full_book_keyboard())
    except Exception:
        logger.exception("Не удалось сформировать книжный отрывок")

    # Личность
    try:
        await message_target.answer(await person.daily_person())
    except Exception:
        logger.exception("Не удалось сформировать заметку о личности")


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
    await message.answer("Собираю подборку, пара минут… ⏳")
    await send_digest(message, message.from_user.id)


@router.callback_query(F.data == "book_full")
async def on_book_full(callback: CallbackQuery) -> None:
    await callback.answer()
    saved = await db.get_last_book(callback.from_user.id)
    if not saved:
        await callback.message.answer("Не помню, о какой книге речь — дождись следующего отрывка 🙂")
        return
    title, author = saved
    await callback.message.answer(await book.where_to_read(title, author))
