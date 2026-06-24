"""Конфигурация бота: читает настройки из переменных окружения (.env)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Загружаем .env, который лежит рядом с этим файлом.
load_dotenv(Path(__file__).resolve().parent / ".env")


@dataclass(frozen=True)
class Config:
    bot_token: str
    anthropic_api_key: str
    daily_hour: int
    daily_minute: int
    timezone: str
    db_path: str


def _require(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Не задана переменная окружения {name}. "
            f"Скопируй .env.example в .env и заполни значения."
        )
    return value


def load_config() -> Config:
    return Config(
        bot_token=_require("BOT_TOKEN"),
        anthropic_api_key=_require("ANTHROPIC_API_KEY"),
        daily_hour=int(os.getenv("DAILY_HOUR", "9")),
        daily_minute=int(os.getenv("DAILY_MINUTE", "0")),
        timezone=os.getenv("TIMEZONE", "Europe/Moscow"),
        db_path=os.getenv("DB_PATH", str(Path(__file__).resolve().parent / "vis.db")),
    )
