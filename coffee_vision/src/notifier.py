"""Telegram reports — end-of-shift summary and instant alerts.

Uses only the stdlib (urllib), so there's no extra dependency. Credentials come
from the environment or ``config/telegram.json``; **never hard-code a token**::

    setx TELEGRAM_BOT_TOKEN "123:ABC"     (Windows)
    setx TELEGRAM_CHAT_ID   "987654321"

or config/telegram.json:  {"bot_token": "123:ABC", "chat_id": "987654321"}

If neither is configured the notifier stays silent (``enabled == False``) and the
rest of the system runs unchanged — reporting is optional.

Getting the two values: message @BotFather to create a bot (gives the token),
then message your bot once and open
https://api.telegram.org/bot<TOKEN>/getUpdates to read your chat id.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, Optional

_CONFIG = Path(__file__).resolve().parent.parent / "config" / "telegram.json"
_API = "https://api.telegram.org/bot{token}/sendMessage"


class TelegramNotifier:
    def __init__(self, bot_token: Optional[str] = None, chat_id: Optional[str] = None,
                 config_path: Path = _CONFIG, timeout: float = 10.0):
        self.timeout = timeout
        self.bot_token = bot_token or os.environ.get("TELEGRAM_BOT_TOKEN")
        self.chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID")
        if (not self.bot_token or not self.chat_id) and config_path.exists():
            try:
                cfg = json.loads(config_path.read_text())
                self.bot_token = self.bot_token or cfg.get("bot_token")
                self.chat_id = self.chat_id or cfg.get("chat_id")
            except (json.JSONDecodeError, OSError):
                pass

    @property
    def enabled(self) -> bool:
        return bool(self.bot_token and self.chat_id)

    def send(self, text: str) -> bool:
        """Send a message. Returns False (never raises) if it can't — a failed
        notification must never take down the analytics loop."""
        if not self.enabled:
            return False
        data = urllib.parse.urlencode({
            "chat_id": self.chat_id, "text": text, "parse_mode": "HTML",
        }).encode()
        try:
            req = urllib.request.Request(_API.format(token=self.bot_token), data=data)
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status == 200
        except Exception as exc:  # noqa: BLE001 — network issues are expected
            print(f"[telegram] send failed: {type(exc).__name__}: {exc}")
            return False


def format_shift_report(date: str, shift_label: str, sales: Dict[str, int],
                        activities: Optional[Dict[str, int]] = None,
                        phone_alerts: int = 0) -> str:
    """Human-readable end-of-shift summary."""
    lines = [f"☕ <b>Смена завершена</b> — {date}, {shift_label}", ""]
    total = sum(sales.values())
    if sales:
        lines.append("<b>Выдано товаров:</b>")
        for item, n in sorted(sales.items(), key=lambda x: -x[1]):
            lines.append(f"  • {item}: {n}")
    else:
        lines.append("Выдач не зафиксировано.")
    lines.append(f"\n<b>Итого: {total}</b>")
    if activities:
        lines.append("\n<b>Активность сотрудников</b> (смен состояния):")
        for a, n in sorted(activities.items(), key=lambda x: -x[1]):
            lines.append(f"  • {a}: {n}")
    if phone_alerts:
        lines.append(f"\n📵 <b>Телефон на рабочем месте: {phone_alerts}</b>")
    return "\n".join(lines)
