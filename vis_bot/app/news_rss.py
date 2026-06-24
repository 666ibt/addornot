"""Авто-новости из RSS-лент.

Бот сам берёт свежие заголовки из настроенных лент и собирает одно сообщение.
Без LLM и без ручной работы. Фильтр «только глобальное» здесь слабее, чем у
человека/модели — выбирай ленты помировее (мировые/международные разделы).
"""
from __future__ import annotations

import html
import logging

import feedparser
import httpx

logger = logging.getLogger(__name__)

_enabled = False
_feeds: list[str] = []


def configure(mode: str, feeds: list[str]) -> None:
    global _enabled, _feeds
    _enabled = mode == "rss"
    _feeds = feeds


def enabled() -> bool:
    return _enabled and bool(_feeds)


async def fetch_text(per_feed: int = 3, total: int = 7) -> str | None:
    """Собирает сообщение с заголовками. None — если ничего не удалось получить."""
    headlines: list[str] = []
    seen: set[str] = set()

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for url in _feeds:
            if len(headlines) >= total:
                break
            try:
                resp = await client.get(url)
                resp.raise_for_status()
            except Exception:
                logger.warning("Не удалось загрузить ленту %s", url)
                continue

            parsed = feedparser.parse(resp.content)
            taken = 0
            for entry in parsed.entries:
                title = (entry.get("title") or "").strip()
                if not title or title in seen:
                    continue
                seen.add(title)
                headlines.append(title)
                taken += 1
                if taken >= per_feed or len(headlines) >= total:
                    break

    if not headlines:
        return None

    lines = "\n".join(f"• {html.escape(h)}" for h in headlines)
    return f"🌍 <b>Главное за день</b>\n\n{lines}"
