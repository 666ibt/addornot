"""Offline, regex-based extraction.

This is the fallback used by ``--no-llm`` and by the regression tests, which
must run without network access or an API key.  It is deliberately conservative
and marks almost everything it derives as ASSUMED, so the review step shows the
user exactly what a machine guessed rather than read.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

from ..config import Config
from ..errors import ExtractionError
from ..models import ASSUMED, EXTRACTED, MISSING, Field, LineItem, Offer
from .textract import ExtractedDoc

#: Quantities in a competitive sheet are counts of equipment, never millions;
#: a larger "quantity" means the row was mis-parsed.
MAX_PLAUSIBLE_QTY = 10000

NUMBER_RE = re.compile(r"\d{1,3}(?:[   ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?")
DATE_RE = re.compile(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})")
INCOTERMS_RE = re.compile(r"\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b", re.IGNORECASE)

CURRENCY_HINTS = [
    ("USD", [r"\bUSD\b", r"долл", r"\$", r"AQSH dollar"]),
    ("EUR", [r"\bEUR\b", r"евро", r"€", r"\bYevro\b"]),
    ("RUB", [r"\bRUB\b", r"руб", r"₽"]),
    ("TRY", [r"\bTRY\b", r"турецк\w* лир", r"₺"]),
    ("CNY", [r"\bCNY\b", r"юан", r"¥"]),
    ("UZS", [r"\bUZS\b", r"\bсум\b", r"\bсўм\b", r"so'?m", r"сум\b"]),
]

VAT_INCLUDED_HINTS = [r"с\s+ндс", r"с\s+учет\w*\s+ндс", r"включая\s+ндс", r"ндс\s+включ",
                      r"qqs\s+bilan", r"vat\s+included", r"kdv\s+dahil"]
VAT_EXCLUDED_HINTS = [r"без\s+ндс", r"ндс\s+не\s+облага", r"qqs\s*siz", r"nds\s*siz",
                      r"excluding\s+vat", r"vat\s+excluded", r"kdv\s+hariç"]

COMPANY_RE = re.compile(
    r"((?:ООО|ОOО|АО|ЗАО|ТОО|ИП|МЧЖ|ХК|LLC|LLP|Ltd|GmbH|A\.?Ş|AS)[\s«\"']*[^\n,;]{2,60}"
    r"|[^\n,;]{2,60}?\s+(?:MChJ|MCHJ|XK|QK|LLC|Ltd|A\.?Ş))",
    re.IGNORECASE,
)

LABELLED = {
    "country_origin": [r"стран\w*\s+происхожден\w*", r"kelib chiqish mamlakati", r"country of origin"],
    "country_shipment": [r"стран\w*\s+отгрузк\w*", r"отгрузка", r"jo'?natish mamlakati", r"country of shipment"],
    "lead_time": [r"срок\w*\s+поставк\w*", r"yetkazib berish muddati", r"delivery time", r"teslim süresi"],
    "payment_terms": [r"услови\w*\s+оплат\w*", r"оплата", r"to'?lov", r"payment terms"],
    "warranty_terms": [r"гаранти\w*", r"kafolat", r"warranty", r"garanti"],
    "delivery_point": [r"пункт\w*\s+поставк\w*", r"мест\w*\s+поставк\w*"],
    "tech_conclusion": [r"техническ\w*\s+заключен\w*"],
    "affiliation": [r"принадлежност\w*"],
}


def parse_number(token: str) -> float:
    cleaned = token.replace(" ", " ").replace(" ", " ").strip()
    cleaned = cleaned.replace(" ", "")
    if "," in cleaned and "." in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    else:
        cleaned = cleaned.replace(",", ".")
    return float(cleaned)


def numbers_in(text: str) -> list[float]:
    return [parse_number(m.group()) for m in NUMBER_RE.finditer(text)]


def find_labelled(text: str, patterns: list[str]) -> str | None:
    for pattern in patterns:
        match = re.search(pattern + r"\s*[:\-–—]?\s*([^\n]{2,120})", text, re.IGNORECASE)
        if match:
            value = match.group(1).strip(" .;:")
            if value:
                return value
    return None


@dataclass
class HeuristicExtractor:
    """Regex extraction; every derived value is reported as an assumption."""

    config: Config = field(default_factory=Config)

    def extract(self, docs: list[ExtractedDoc]) -> Offer:
        if not docs:
            raise ExtractionError("<supplier>", "no readable documents")
        text = "\n".join(doc.text for doc in docs)
        offer = Offer()
        assumptions: list[str] = []

        def note(name: str, value, source=ASSUMED, reason=""):
            setattr(offer, name, Field(value=value, source=source, note=reason))
            if source == ASSUMED and value is not None:
                assumptions.append(f"{name}: {reason}")

        company = COMPANY_RE.search(text)
        if company:
            note("company_name", re.sub(r"\s+", " ", company.group(1)).strip(" «\"'"),
                 EXTRACTED)
        else:
            first = next((line.strip() for line in text.splitlines() if line.strip()), None)
            note("company_name", first, ASSUMED, "взято первое непустое поле документа")

        currency = self._currency(text)
        if currency:
            note("currency", currency, ASSUMED, "определена по упоминанию в тексте")
        else:
            note("currency", None, MISSING, "валюта не найдена")

        vat = self._vat(text)
        if vat is None:
            note("vat_included", None, MISSING, "не указано, входит ли НДС в цену")
        else:
            note("vat_included", vat, ASSUMED,
                 "определено по формулировке " + ("«с НДС»" if vat else "«без НДС»"))

        incoterms = INCOTERMS_RE.search(text)
        if incoterms:
            note("incoterms", incoterms.group(1).upper(), EXTRACTED)
            tail = text[incoterms.end(): incoterms.end() + 80].split("\n")[0]
            point = tail.strip(" .,:;–—-")
            if point:
                note("delivery_point", point, ASSUMED, "взят текст после базиса поставки")
        else:
            note("incoterms", None, MISSING, "базис поставки не найден")

        date = DATE_RE.search(text)
        if date:
            day, month, year = date.groups()
            note("offer_date", f"{year}-{int(month):02d}-{int(day):02d}", ASSUMED,
                 "взята первая дата в документе")

        for name, patterns in LABELLED.items():
            if getattr(offer, name).value is not None:
                continue
            value = find_labelled(text, patterns)
            if value:
                note(name, value, EXTRACTED)

        manufacturer = re.search(r"(являемся|мы)\s+производител|производитель\s*[:\-]\s*мы",
                                 text, re.IGNORECASE)
        if manufacturer:
            note("is_manufacturer", True, EXTRACTED)

        total = self._stated_total(text)
        if total is not None:
            note("stated_total", total, EXTRACTED)

        offer.line_items = self._line_items(text, docs)
        offer.source_files = [doc.path for doc in docs]
        offer.assumptions = assumptions + [
            "данные извлечены офлайн-эвристикой (--no-llm); проверьте каждое поле"
        ]
        offer.confidence = 0.35
        for doc in docs:
            for warning in doc.warnings:
                offer.warnings.append(f"{os.path.basename(doc.path)}: {warning}")
        return offer

    # -- pieces ---------------------------------------------------------

    def _currency(self, text: str) -> str | None:
        for code, patterns in CURRENCY_HINTS:
            for pattern in patterns:
                if re.search(pattern, text, re.IGNORECASE):
                    return code
        return None

    def _vat(self, text: str) -> bool | None:
        for pattern in VAT_EXCLUDED_HINTS:
            if re.search(pattern, text, re.IGNORECASE):
                return False
        for pattern in VAT_INCLUDED_HINTS:
            if re.search(pattern, text, re.IGNORECASE):
                return True
        return None

    def _stated_total(self, text: str) -> float | None:
        for line in text.splitlines():
            if re.search(r"^\s*(итого|всего|jami|total|toplam)\b", line.strip(), re.IGNORECASE):
                values = numbers_in(re.sub(r"\b\d{1,2}\s*%", "", line))
                if values:
                    return max(values)
        return None

    def _line_items(self, text: str, docs: list[ExtractedDoc]) -> list[LineItem]:
        """Match each specification position to a row in the supplier's table."""
        lines = text.splitlines()
        sources = [doc.path for doc in docs]
        anchors = self._anchors(lines)
        items: list[LineItem] = []

        for index, spec in enumerate(self.config.spec):
            if index not in anchors:
                continue
            start = anchors[index]
            stop = min(
                [position for position in anchors.values() if position > start] + [start + 6, len(lines)]
            )
            window = self._trim_window(lines[start:stop])
            values = [v for v in self._row_numbers(window) if v > 0]
            qty, unit_price, total, reliable = self._reconcile(values)
            source = ASSUMED if reliable else MISSING
            note = ("выведено из чисел строки КП" if reliable else
                    "строку таблицы не удалось разобрать однозначно — заполните вручную")
            items.append(
                LineItem(
                    description=Field(value=spec.description, source=ASSUMED,
                                      note="сопоставлено со строкой спецификации по ключевым словам"),
                    qty=Field(value=qty if reliable else None, source=source, note=note),
                    unit=Field(value=spec.unit or None,
                               source=ASSUMED if spec.unit else MISSING,
                               note="взято из спецификации закупки"),
                    unit_price=Field(value=unit_price if reliable else None, source=source, note=note),
                    total_price=Field(value=total if reliable else None, source=source, note=note),
                    notes=re.sub(r"\s+", " ", " ".join(window)).strip()[:200],
                    spec_index=index,
                    source_files=sources,
                )
            )
        return items

    @staticmethod
    def _trim_window(window: list[str]) -> list[str]:
        """Cut the row window at the totals line or a gap of two blank lines."""
        trimmed: list[str] = []
        blanks = 0
        for position, line in enumerate(window):
            if position and re.match(r"\s*(итого|всего|jami|total|toplam)\b", line, re.IGNORECASE):
                break
            if not line.strip():
                blanks += 1
                if blanks >= 2 and trimmed:
                    break
            else:
                blanks = 0
            trimmed.append(line)
        return trimmed

    def _anchors(self, lines: list[str]) -> dict[int, int]:
        """First line of the table row belonging to each specification item."""
        anchors: dict[int, int] = {}
        for index, spec in enumerate(self.config.spec):
            for position, line in enumerate(lines):
                if position in anchors.values():
                    continue
                if self._matches(line, spec.keywords()):
                    anchors[index] = position
                    break
        return anchors

    def _row_numbers(self, window: list[str]) -> list[float]:
        """Numbers of one table row, re-joining values split across lines.

        ``pdftotext -layout`` wraps narrow columns, so "74 000,00" arrives as
        "74" on one line and "000,00" on another.  Column offsets reassemble
        that for text PDFs; OCR destroys the offsets, so leftover thousands
        groups are then reattached positionally to the numbers above them.
        """
        rows: list[list[tuple[int, str]]] = []
        for line in window:
            cleaned = self._blank_description_noise(line)
            tokens = [(m.start(), m.group()) for m in NUMBER_RE.finditer(cleaned)]
            if tokens:
                rows.append(tokens)
        if not rows:
            return []

        base = [[column, text] for column, text in rows[0]]
        orphans: list[str] = []
        for tokens in rows[1:]:
            for column, text in tokens:
                if not self._is_group(text):
                    base.append([column, text])
                    continue
                target = self._nearest_open(base, column)
                if target is not None:
                    target[1] = target[1] + " " + text
                else:
                    orphans.append(text)

        # OCR case: the money columns are the rightmost ones, so pair leftover
        # groups with the last open numbers, in order.
        if orphans:
            open_entries = [entry for entry in base if self._is_open(entry[1])]
            for entry, text in zip(open_entries[-len(orphans):], orphans):
                entry[1] = entry[1] + " " + text

        return [parse_number(text) for _, text in base]

    @staticmethod
    def _is_group(text: str) -> bool:
        """A wrapped thousands group such as '000' or '000,00'."""
        return bool(re.fullmatch(r"\d{3}(?:[.,]\d{1,2})?", text))

    @staticmethod
    def _is_open(text: str) -> bool:
        """A number that has no fractional part yet, so a group may follow it."""
        return not re.search(r"[.,]\d{1,2}$", text)

    @classmethod
    def _nearest_open(cls, base: list[list], column: int):
        candidates = [
            entry for entry in base
            if abs(entry[0] - column) <= 4 and cls._is_open(entry[1])
        ]
        return min(candidates, key=lambda entry: abs(entry[0] - column), default=None)

    @staticmethod
    def _blank_description_noise(line: str) -> str:
        """Blank out digits belonging to the product name, keeping column offsets."""
        def blank(match):
            return " " * len(match.group())

        cleaned = re.sub(r"[A-Za-zА-Яа-яЁёЎўҚқҒғҲҳ]+[-‑]?\d+", blank, line)
        cleaned = re.sub(r"\d+\s*(?:м3|m3|мм|mm|см|cm|кг|kg|ГОСТ|шт\.?|dona|pcs)\b", blank, cleaned,
                         flags=re.IGNORECASE)
        cleaned = re.sub(r"\b\d{1,2}\s*%", blank, cleaned)
        return cleaned

    @staticmethod
    def _matches(line: str, keywords: list[str]) -> bool:
        """True when every significant token of some keyword is on the line.

        Requiring all tokens of one alternative keeps a heading like
        "ООО «Бета Резервуар»" from being mistaken for the row of the position
        "резервуар горизонтальный".
        """
        norm = re.sub(r"\s+", " ", line).lower()
        for keyword in keywords:
            tokens = [t for t in re.split(r"[\s,;]+", keyword.lower()) if len(t) > 3]
            if tokens and all(token in norm for token in tokens):
                return True
        return False

    @staticmethod
    def _strip_description_noise(text: str, spec) -> str:
        """Drop numbers that belong to the product name (РГС-50, 50 м3, ГОСТ ...)."""
        cleaned = re.sub(r"[A-Za-zА-Яа-яЎўҚқҒғҲҳ]+[-‑]?\d+", " ", text)
        cleaned = re.sub(r"\d+\s*(?:м3|m3|мм|mm|см|cm|кг|kg|т\b|ГОСТ|шт\.?|dona|pcs)", " ", cleaned,
                         flags=re.IGNORECASE)
        cleaned = re.sub(r"\b\d{1,2}\s*%", " ", cleaned)
        return cleaned

    @staticmethod
    def _reconcile(values: list[float]):
        """Derive (qty, unit price, total, reliable) from a row's numbers.

        The row is only trusted when the two largest numbers relate by a whole
        quantity -- otherwise the parse is reported as unreliable rather than
        guessed at.
        """
        if len(values) < 2:
            return None, None, None, False
        ordered = sorted(values)
        total, unit_price = ordered[-1], ordered[-2]
        if unit_price <= 0:
            return None, None, None, False
        ratio = total / unit_price
        qty = round(ratio)
        if 1 <= qty <= MAX_PLAUSIBLE_QTY and abs(ratio - qty) <= 0.01:
            return float(qty), unit_price, total, True
        return None, None, None, False
