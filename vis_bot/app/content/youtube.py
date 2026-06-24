"""Транскрипты свежих роликов с YouTube-каналов как источник для заметок.

Работает без платного YouTube Data API:
- список свежих видео берём из публичной RSS-ленты канала;
- субтитры — через youtube-transcript-api.

channel_id выглядит как UCxxxxxxxxxxxxxxxxxxxxxx. Как найти id канала:
открыть канал → «Поделиться каналом» → «Скопировать ID канала»,
либо посмотреть в исходном коде страницы канала (externalId).
"""
from __future__ import annotations

import asyncio
import datetime
import logging
from xml.etree import ElementTree

import httpx

logger = logging.getLogger(__name__)

_RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
_NS = {
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "atom": "http://www.w3.org/2005/Atom",
}

# Каналы задаются в .env (YOUTUBE_CHANNEL_IDS) и прокидываются сюда из bot.py.
_channel_ids: list[str] = []


def configure(channel_ids: list[str]) -> None:
    global _channel_ids
    _channel_ids = channel_ids


def has_channels() -> bool:
    return bool(_channel_ids)


async def _recent_video_ids(channel_id: str, limit: int) -> list[str]:
    url = _RSS_URL.format(channel_id=channel_id)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url)
        resp.raise_for_status()
    root = ElementTree.fromstring(resp.text)
    ids = [e.text for e in root.findall(".//yt:videoId", _NS) if e.text]
    return ids[:limit]


def _fetch_transcript_sync(video_id: str, languages: list[str]) -> str | None:
    """Субтитры одного ролика. Поддерживает API youtube-transcript-api 1.x и 0.x."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi

        try:
            # Новый API (>=1.0): инстанс + .fetch()
            fetched = YouTubeTranscriptApi().fetch(video_id, languages=languages)
            return " ".join(snippet.text for snippet in fetched)
        except AttributeError:
            # Старый API (<1.0): classmethod .get_transcript()
            data = YouTubeTranscriptApi.get_transcript(video_id, languages=languages)
            return " ".join(item["text"] for item in data)
    except Exception as exc:  # нет субтитров / видео недоступно и т.п.
        logger.info("Субтитры для %s недоступны: %s", video_id, exc)
        return None


async def daily_transcript(
    *,
    languages: tuple[str, ...] = ("ru", "en"),
    max_chars: int = 40_000,
    per_channel: int = 8,
) -> tuple[str, str] | None:
    """Возвращает (текст_транскрипта, video_id) одного свежего ролика с субтитрами.

    Ролик выбирается с поворотом по дате, чтобы заметка менялась день ото дня.
    Если каналов нет или субтитров не нашлось — возвращает None.
    """
    if not _channel_ids:
        return None

    candidates: list[str] = []
    for channel_id in _channel_ids:
        try:
            candidates.extend(await _recent_video_ids(channel_id, limit=per_channel))
        except Exception:
            logger.exception("Не удалось получить ленту канала %s", channel_id)

    if not candidates:
        return None

    # Поворот списка по дню года → разные ролики в разные дни.
    offset = datetime.date.today().toordinal() % len(candidates)
    ordered = candidates[offset:] + candidates[:offset]

    for video_id in ordered:
        text = await asyncio.to_thread(_fetch_transcript_sync, video_id, list(languages))
        if text:
            return text[:max_chars], video_id

    return None
