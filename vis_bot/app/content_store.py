"""Файловое хранилище контента: данные пишутся в JSON, бот их читает и рендерит.

Каждый день добавляй записи в data/news.json, data/books.json, data/persons.json —
бот берёт следующую ещё не отправленную запись каждой категории.

Форматы записей:

news.json:    [ {"items": ["Новость 1", "Новость 2"]} , ... ]
books.json:   [ {"title": "...", "author": "...", "excerpt": "...",
                 "hook": "(необязательно)", "where_to_read": "(необязательно)"} , ... ]
persons.json: [ {"name": "...", "years": "1900–1980", "bio": "...",
                 "achievements": ["...", "..."], "quotes": ["...", "..."]} , ... ]

В любой записи можно задать своё поле "id" — тогда оно станет ключом для
антидублей (иначе ключ выводится из содержимого). В текстах можно использовать
HTML-теги <b> и <i> (Telegram parse_mode=HTML).
"""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_data_dir = Path("data")

_FILES = {"news": "news.json", "book": "books.json", "person": "persons.json"}


def configure(data_dir: str) -> None:
    global _data_dir
    _data_dir = Path(data_dir)


def load(category: str) -> list[dict]:
    path = _data_dir / _FILES[category]
    if not path.exists():
        logger.warning("Файл контента не найден: %s", path)
        return []
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        logger.exception("Не удалось прочитать %s", path)
        return []
    return data if isinstance(data, list) else []


def entry_key(category: str, entry: dict) -> str:
    """Стабильный ключ записи для защиты от повторов."""
    if entry.get("id"):
        return str(entry["id"])
    if category == "book":
        return f"{entry.get('title', '')} — {entry.get('author', '')}"
    if category == "person":
        return entry.get("name", "")
    raw = json.dumps(entry.get("items", entry), ensure_ascii=False, sort_keys=True)
    return "news:" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


# --- Рендеринг записей в готовые сообщения Telegram (HTML) ---


def render_news(entry: dict) -> str:
    items = entry.get("items") or []
    lines = "\n".join(f"• {item}" for item in items)
    return f"🌍 <b>Главное за день</b>\n\n{lines}"


def render_book(entry: dict) -> str:
    title = entry.get("title", "")
    author = entry.get("author", "")
    parts = ["📖 <b>Отрывок дня</b>", f"<i>{title}</i> — {author}", "", entry.get("excerpt", "")]
    hook = entry.get("hook")
    if hook:
        parts += ["", hook]
    return "\n".join(parts)


def render_person(entry: dict) -> str:
    name = entry.get("name", "")
    years = entry.get("years", "")
    header = f"👤 <b>{name}</b>" + (f" ({years})" if years else "")
    parts = [header, "", entry.get("bio", "")]

    achievements = entry.get("achievements") or []
    if achievements:
        parts += ["", "<b>Достижения:</b>"] + [f"• {a}" for a in achievements]

    quotes = entry.get("quotes") or []
    if quotes:
        parts += ["", "<b>Цитаты:</b>"] + [f"<i>{q}</i>" for q in quotes]

    return "\n".join(parts)
