"""Точка входа бота Vis.

Запуск:  python bot.py
Перед запуском: скопируй .env.example в .env и заполни BOT_TOKEN и ANTHROPIC_API_KEY.
"""
from __future__ import annotations

import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from app import db
from app.content import claude_client
from app.handlers import router
from app.scheduler import setup_scheduler
from config import load_config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


async def main() -> None:
    config = load_config()

    # Настраиваем зависимости.
    db.configure(config.db_path)
    await db.init()
    claude_client.configure(config.anthropic_api_key)

    # Все сообщения по умолчанию в HTML — наш контент размечен тегами <b>/<i>.
    bot = Bot(
        token=config.bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dp = Dispatcher()
    dp.include_router(router)

    setup_scheduler(
        bot,
        hour=config.daily_hour,
        minute=config.daily_minute,
        timezone=config.timezone,
    )

    logging.info("Vis запущен. Жду апдейтов…")
    await dp.start_polling(bot)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        logging.info("Остановлено.")
