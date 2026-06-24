"""Книжный отрывок дня (не больше одной страницы) и подсказка, где взять книгу."""
from __future__ import annotations

import json

from . import claude_client

_SYSTEM = (
    "Ты — литературный куратор. Каждый день выбираешь ОДИН из самых ярких и "
    "цепляющих фрагментов значимой книги (художественной или нон-фикшн) и подаёшь "
    "его так, чтобы у читателя возникло желание прочитать книгу целиком. "
    "Отрывок — не больше одной страницы. Пиши на русском."
)

# Просим строгий JSON, чтобы надёжно вытащить название и автора для кнопки
# «полная версия». Структурированный вывод гарантирует валидный JSON.
_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "author": {"type": "string"},
        "message": {"type": "string"},
    },
    "required": ["title", "author", "message"],
    "additionalProperties": False,
}

_PROMPT = (
    "Подбери книжный отрывок дня.\n"
    "Верни JSON с полями:\n"
    "- title: название книги;\n"
    "- author: автор;\n"
    "- message: готовый текст для Telegram (parse_mode=HTML). Внутри message:\n"
    "    📖 <b>Отрывок дня</b>\n"
    "    строка с «<i>Название</i> — Автор»,\n"
    "    пустая строка,\n"
    "    сам отрывок (максимум одна страница),\n"
    "    пустая строка,\n"
    "    одно предложение-крючок, почему стоит прочитать книгу целиком.\n"
    "Используй только теги <b> и <i>."
)


async def daily_book() -> tuple[str, str, str]:
    """Возвращает (title, author, message_html)."""
    # Структурированный вывод: гарантированно валидный JSON по схеме.
    if claude_client._client is None:  # noqa: SLF001 — простая проверка конфигурации
        raise RuntimeError("claude_client не сконфигурирован")

    message = await claude_client._client.messages.create(  # noqa: SLF001
        model=claude_client.MODEL,
        max_tokens=4000,
        system=_SYSTEM,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
        messages=[{"role": "user", "content": _PROMPT}],
    )
    text = "".join(b.text for b in message.content if b.type == "text").strip()
    data = json.loads(text)
    return data["title"], data["author"], data["message"]


_FULL_SYSTEM = (
    "Ты помогаешь читателю найти, где легально прочитать или скачать книгу. "
    "Отвечай кратко и на русском."
)


async def where_to_read(title: str, author: str) -> str:
    prompt = (
        f"Книга «{title}» — {author}. Подскажи, где её можно прочитать целиком.\n"
        "Если книга в общественном достоянии (public domain) — укажи, что её можно "
        "бесплатно скачать (например, Project Gutenberg, Standard Ebooks, "
        "Викитека для русскоязычных текстов).\n"
        "Если книга современная и под авторским правом — предложи легальные сервисы "
        "(ЛитРес, Букмейт, MyBook, Bookmate) и не давай пиратских ссылок.\n"
        "Формат: 📚 <b>Где прочитать целиком</b>, затем 2–4 коротких пункта. "
        "Только теги <b>, <i>."
    )
    return await claude_client.generate(_FULL_SYSTEM, prompt, max_tokens=1500)
