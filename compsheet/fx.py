"""Currency rates.

Rates are never invented.  They come from the config file or from an explicit
online source; an unknown currency stops the run with a message naming the
currency and the supplier that used it.
"""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass

from .config import Config
from .errors import FxError

CBU_URL = "https://cbu.uz/ru/arkhiv-kursov-valyut/json/"


@dataclass
class FxTable:
    base: str
    rates: dict[str, float]
    source: str = "config"
    date: str = ""

    def rate(self, currency: str, used_by: str = "") -> float:
        code = (currency or "").strip().upper()
        if not code:
            raise FxError(
                f"currency is not set{f' for {used_by}' if used_by else ''}; "
                "fix it during review or add it to the offer JSON"
            )
        if code == self.base:
            return 1.0
        if code not in self.rates:
            who = f" (used by {used_by})" if used_by else ""
            raise FxError(
                f"no exchange rate for {code}{who}. Add it to the fx section of "
                f"your config, e.g.  fx: {{{code}: <{code}/{self.base} rate>}}"
            )
        value = float(self.rates[code])
        if value <= 0:
            raise FxError(f"exchange rate for {code} must be positive, got {value}")
        return value

    def has(self, currency: str) -> bool:
        code = (currency or "").strip().upper()
        return bool(code) and (code == self.base or code in self.rates)

    def as_rows(self) -> list[tuple[str, float]]:
        """Rows for the lookup table written into the workbook."""
        rows = [(self.base, 1.0)]
        rows += sorted((code, float(v)) for code, v in self.rates.items()
                       if code != self.base)
        return rows

    @classmethod
    def from_config(cls, config: Config) -> "FxTable":
        return cls(
            base=config.base_currency.upper(),
            rates={k.upper(): float(v) for k, v in config.fx.items()},
            source=config.fx_source,
            date=config.fx_date,
        )


def fetch_cbu_rates(timeout: float = 15.0) -> tuple[dict[str, float], str]:
    """Fetch UZS rates from the Central Bank of Uzbekistan.

    Returns ``(rates, date)``.  Any failure propagates -- a stale or guessed
    rate is worse than an error.
    """
    with urllib.request.urlopen(CBU_URL, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    rates: dict[str, float] = {}
    date = ""
    for entry in payload:
        code = str(entry.get("Ccy", "")).upper()
        try:
            rate = float(entry.get("Rate"))
        except (TypeError, ValueError):
            continue
        nominal = float(entry.get("Nominal", 1) or 1)
        if code and rate > 0:
            rates[code] = rate / (nominal if nominal else 1)
        date = entry.get("Date", date) or date
    if not rates:
        raise FxError("CBU returned no usable rates")
    return rates, date


def build_fx_table(config: Config, online: bool = False) -> FxTable:
    table = FxTable.from_config(config)
    if online:
        if table.base != "UZS":
            raise FxError(
                "--fx-online only supports UZS as the base currency; "
                f"config uses {table.base}"
            )
        fetched, date = fetch_cbu_rates()
        # Config rates win: a user-pinned contract rate is intentional.
        merged = dict(fetched)
        merged.update(table.rates)
        table = FxTable(base=table.base, rates=merged, source="cbu.uz", date=date)
    return table
