"""Конфигурация бота: читает настройки из переменных окружения (.env)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Загружаем .env, который лежит рядом с этим файлом.
# override=True — значения из .env имеют приоритет над уже заданными
# переменными окружения (иначе их легко «перебить», особенно в Codespaces).
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

_BASE_DIR = Path(__file__).resolve().parent

# Новостные RSS-ленты по умолчанию (можно переопределить через NEWS_RSS_FEEDS).
_DEFAULT_FEEDS = "https://feeds.bbci.co.uk/russian/rss.xml,https://tass.ru/rss/v2.xml"


@dataclass(frozen=True)
class Config:
    bot_token: str
    admin_ids: list[int]
    daily_hour: int
    daily_minute: int
    timezone: str
    db_path: str
    data_dir: str
    news_mode: str
    news_rss_feeds: list[str]


def _require(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Не задана переменная окружения {name}. "
            f"Скопируй .env.example в .env и заполни значения."
        )
    return value


def _parse_admin_ids(raw: str) -> list[int]:
    ids: list[int] = []
    for chunk in raw.replace(" ", "").split(","):
        if chunk:
            try:
                ids.append(int(chunk))
            except ValueError:
                pass
    return ids


def load_config() -> Config:
    return Config(
        bot_token=_require("BOT_TOKEN"),
        admin_ids=_parse_admin_ids(os.getenv("ADMIN_IDS", "")),
        daily_hour=int(os.getenv("DAILY_HOUR", "9")),
        daily_minute=int(os.getenv("DAILY_MINUTE", "0")),
        timezone=os.getenv("TIMEZONE", "Europe/Moscow"),
        db_path=os.getenv("DB_PATH", str(_BASE_DIR / "vis.db")),
        data_dir=os.getenv("DATA_DIR", str(_BASE_DIR / "data")),
        news_mode=os.getenv("NEWS_MODE", "rss").strip().lower(),
        news_rss_feeds=[
            u.strip() for u in os.getenv("NEWS_RSS_FEEDS", _DEFAULT_FEEDS).split(",") if u.strip()
        ],
    )
