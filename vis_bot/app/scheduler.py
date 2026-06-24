"""Ежедневная рассылка по расписанию (APScheduler)."""
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
    """Генерирует подборку один раз и рассылает её всем подписчикам."""
    user_ids = await db.get_subscribers()
    logger.info("Запускаю рассылку для %d подписчиков", len(user_ids))
    if not user_ids:
        return

    # Контент общий для всех — генерируем единожды (дешевле и без дублей).
    content = await digest.build()

    for user_id in user_ids:
        target = _DirectSender(bot, user_id)
        try:
            await digest.send(target, user_id, content)
        except TelegramForbiddenError:
            # Пользователь заблокировал бота — отписываем.
            await db.unsubscribe(user_id)
        except Exception:
            logger.exception("Ошибка при рассылке пользователю %s", user_id)
        # Чтобы не упереться в лимиты Telegram при большой базе.
        await asyncio.sleep(0.1)


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
