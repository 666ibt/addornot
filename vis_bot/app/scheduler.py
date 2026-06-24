"""Ежедневная рассылка по расписанию (APScheduler).

Рассылается только стартовое сообщение с новостями и кнопкой — дальше
пользователь раскрывает отрывок и личность сам.
"""
from __future__ import annotations

import asyncio
import logging

from aiogram import Bot
from aiogram.exceptions import TelegramForbiddenError
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from . import db, digest

logger = logging.getLogger(__name__)


class _DirectSender:
    """Адаптер: даёт интерфейс .answer(), отправляя сообщение конкретному user_id."""

    def __init__(self, bot: Bot, chat_id: int) -> None:
        self._bot = bot
        self._chat_id = chat_id

    async def answer(self, text: str, **kwargs):
        return await self._bot.send_message(self._chat_id, text, **kwargs)


async def _broadcast(bot: Bot) -> None:
    user_ids = await db.get_subscribers()
    logger.info("Запускаю рассылку для %d подписчиков", len(user_ids))
    if not user_ids:
        return

    await digest.ensure_today()

    for user_id in user_ids:
        target = _DirectSender(bot, user_id)
        try:
            await digest.send_news(target)
        except TelegramForbiddenError:
            await db.unsubscribe(user_id)
        except Exception:
            logger.exception("Ошибка при рассылке пользователю %s", user_id)
        await asyncio.sleep(0.1)  # бережём лимиты Telegram


def setup_scheduler(bot: Bot, *, hour: int, minute: int, timezone: str) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone=timezone)
    scheduler.add_job(
        _broadcast,
        trigger="cron",
        hour=hour,
        minute=minute,
        args=[bot],
        id="daily_digest",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Планировщик запущен: ежедневно в %02d:%02d (%s)", hour, minute, timezone)
    return scheduler
