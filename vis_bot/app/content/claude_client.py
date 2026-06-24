"""Тонкая обёртка над Anthropic API для генерации контента на русском.

Используем модель claude-opus-4-8 и адаптивное мышление — Claude сам решает,
сколько «думать» над задачей. Для новостей подключаем серверный инструмент
web_search, чтобы дайджест был по реально свежим событиям.
"""
from __future__ import annotations

from anthropic import AsyncAnthropic
from anthropic.types import Message

MODEL = "claude-opus-4-8"

# Серверный инструмент веб-поиска (выполняется на стороне Anthropic).
WEB_SEARCH_TOOL = {"type": "web_search_20260209", "name": "web_search"}

_client: AsyncAnthropic | None = None


def configure(api_key: str) -> None:
    global _client
    _client = AsyncAnthropic(api_key=api_key)


def _extract_text(message: Message) -> str:
    """Склеиваем все текстовые блоки ответа в одну строку."""
    parts = [block.text for block in message.content if block.type == "text"]
    return "".join(parts).strip()


async def generate(
    system: str,
    prompt: str,
    *,
    use_web_search: bool = False,
    max_tokens: int = 4000,
) -> str:
    """Один запрос к модели. Возвращает готовый текст для отправки в Telegram."""
    if _client is None:
        raise RuntimeError("claude_client не сконфигурирован — вызови configure(api_key)")

    kwargs: dict = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "thinking": {"type": "adaptive"},
        "messages": [{"role": "user", "content": prompt}],
    }
    if use_web_search:
        kwargs["tools"] = [WEB_SEARCH_TOOL]

    message = await _client.messages.create(**kwargs)

    # Серверные инструменты (веб-поиск) могут приостановить ход на лимите
    # итераций со stop_reason="pause_turn" — продолжаем, дослав ответ обратно.
    guard = 0
    while message.stop_reason == "pause_turn" and guard < 5:
        guard += 1
        kwargs["messages"] = [
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": message.content},
        ]
        message = await _client.messages.create(**kwargs)

    return _extract_text(message)
