"""The review step: show what was extracted before anything is generated.

Every value is printed with its provenance, so the person approving the run
sees at a glance which numbers came out of a supplier's document and which the
system filled in.  The same data round-trips through JSON, which is how a
single field gets corrected without re-running extraction.
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import Config
from .errors import CompSheetError
from .fx import FxTable
from .models import ASSUMED, EXTRACTED, MISSING, USER, ExtractionResult, Field, Offer

MARKER = {
    EXTRACTED: "✓",
    ASSUMED: "~",
    MISSING: "✗",
    USER: "✎",
}

LEGEND = "✓ из документа   ~ предположено системой   ✗ не найдено   ✎ задано вами"

FIELD_TITLES = {
    "company_name": "Компания",
    "affiliation": "Принадлежность",
    "is_manufacturer": "Производитель",
    "tech_conclusion": "Техзаключение",
    "country_origin": "Страна происхождения",
    "country_shipment": "Страна отгрузки",
    "city": "Город",
    "currency": "Валюта",
    "vat_included": "НДС в цене",
    "offer_date": "Дата КП",
    "validity_end": "Действительно до",
    "incoterms": "Базис поставки",
    "delivery_point": "Пункт поставки",
    "payment_terms": "Условия оплаты",
    "warranty_terms": "Гарантия",
    "lead_time": "Срок поставки",
    "procurement_procedure": "Процедура закупки",
    "transport_cost": "Транспорт",
    "stated_total": "Итог по КП",
}


def save_json(result: ExtractionResult, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return path


def load_json(path: str | Path) -> ExtractionResult:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return ExtractionResult.from_dict(data)


def summary(result: ExtractionResult, config: Config, fx: FxTable) -> str:
    lines: list[str] = ["", "=" * 78, "ПРОВЕРКА ИЗВЛЕЧЁННЫХ ДАННЫХ", "=" * 78, LEGEND]

    if result.failed_files:
        lines += ["", "НЕ УДАЛОСЬ ПРОЧИТАТЬ ФАЙЛЫ (запросите их повторно):"]
        for failed in result.failed_files:
            lines.append(f"  ✗ {Path(failed.path).name}: {failed.reason.splitlines()[0]}")

    for index, offer in enumerate(result.offers, start=1):
        lines += ["", "-" * 78, f"{index}. {offer.display_name}"]
        lines.append("    файлы: " + ", ".join(Path(p).name for p in offer.source_files))
        for name, value in offer.iter_fields():
            if name == "company_name":
                continue
            title = FIELD_TITLES.get(name, name)
            shown = "—" if value.value is None else str(value.value)
            line = f"    {MARKER[value.source]} {title:22s} {shown[:44]}"
            if value.source in (ASSUMED, MISSING) and value.note:
                line += f"   ({value.note[:44]})"
            lines.append(line)

        lines.append("    позиции:")
        for item in offer.line_items:
            spec = (config.spec[item.spec_index].description
                    if item.spec_index is not None and item.spec_index < len(config.spec)
                    else str(item.description.value))
            qty = item.qty.value
            price = item.unit_price.value
            total = item.total_price.value
            lines.append(
                f"      {MARKER[item.qty.source]} {str(spec)[:40]:42s} "
                f"кол-во {qty if qty is not None else '—'} × "
                f"{price if price is not None else '—'} = "
                f"{total if total is not None else '—'}"
            )

        if offer.warnings:
            lines.append("    ⚠ требует внимания:")
            for warning in offer.warnings:
                lines.append(f"      - {warning}")

        currency = offer.currency.value
        if currency and not fx.has(str(currency)):
            lines.append(f"    ⚠ курс для {currency} отсутствует в конфиге")

    lines += ["", "=" * 78]
    return "\n".join(lines)


def _coerce(text: str):
    lowered = text.strip().lower()
    if lowered in ("true", "да", "yes"):
        return True
    if lowered in ("false", "нет", "no"):
        return False
    if lowered in ("null", "none", "—", ""):
        return None
    try:
        return float(text) if ("." in text or "," in text) else int(text)
    except ValueError:
        return text


def apply_edit(result: ExtractionResult, expression: str) -> str:
    """Apply one ``Компания.поле=значение`` correction.

    The company may be given by a unique fragment of its name or by its 1-based
    position in the review listing; ``поле`` may also address a line item, as in
    ``Альфа.item2.unit_price``.
    """
    if "=" not in expression:
        raise CompSheetError(f"expected COMPANY.FIELD=VALUE, got {expression!r}")
    target, raw_value = expression.split("=", 1)
    parts = target.strip().split(".")
    if len(parts) < 2:
        raise CompSheetError(f"expected COMPANY.FIELD=VALUE, got {expression!r}")
    company, path = parts[0], parts[1:]

    offer = _find_offer(result, company)
    value = _coerce(raw_value)

    if path[0].startswith("item"):
        try:
            position = int(path[0][4:]) - 1
        except ValueError as error:
            raise CompSheetError(f"bad item reference {path[0]!r}") from error
        if not 0 <= position < len(offer.line_items):
            raise CompSheetError(
                f"{offer.display_name}: item {position + 1} does not exist "
                f"({len(offer.line_items)} positions)"
            )
        item = offer.line_items[position]
        if len(path) < 2 or not hasattr(item, path[1]):
            raise CompSheetError(f"unknown line item field {'.'.join(path[1:])!r}")
        setattr(item, path[1], Field(value=value, source=USER, note="исправлено вручную"))
        return f"{offer.display_name}: позиция {position + 1}.{path[1]} = {value!r}"

    name = path[0]
    if not hasattr(offer, name) or not isinstance(getattr(offer, name), Field):
        raise CompSheetError(f"unknown field {name!r}")
    setattr(offer, name, Field(value=value, source=USER, note="исправлено вручную"))
    return f"{offer.display_name}: {name} = {value!r}"


def _find_offer(result: ExtractionResult, company: str) -> Offer:
    if company.isdigit():
        index = int(company) - 1
        if not 0 <= index < len(result.offers):
            raise CompSheetError(f"no offer number {company}")
        return result.offers[index]
    matches = [offer for offer in result.offers
               if company.lower() in offer.display_name.lower()]
    if not matches:
        raise CompSheetError(f"no offer matching {company!r}")
    if len(matches) > 1:
        names = ", ".join(offer.display_name for offer in matches)
        raise CompSheetError(f"{company!r} matches several offers: {names}")
    return matches[0]


def interactive_review(result: ExtractionResult, config: Config, fx: FxTable) -> bool:
    """Show the summary and let the user fix fields. False cancels the run."""
    while True:
        print(summary(result, config, fx))
        print("Команды:  <Enter> — продолжить | п <Компания.поле=значение> — исправить | "
              "о — отмена")
        try:
            answer = input("> ").strip()
        except EOFError:
            return True
        if not answer:
            return True
        if answer.lower() in ("о", "o", "q", "cancel", "отмена"):
            return False
        if answer.lower().startswith(("п ", "p ", "set ")):
            expression = answer.split(" ", 1)[1]
            try:
                print("  " + apply_edit(result, expression))
            except CompSheetError as error:
                print(f"  ошибка: {error}")
        else:
            print("  не понял команду")
