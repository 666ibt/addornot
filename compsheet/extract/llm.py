"""Structured extraction of an offer from a supplier's documents.

One request per supplier, carrying every file they sent (text and, for scans,
the page images themselves -- reading the image beats reading bad OCR of a
table).  The response is constrained by a JSON schema, and the model is
required to list what it could not find and what it assumed, so that guessed
values never enter the workbook unlabelled.
"""

from __future__ import annotations

import base64
import io
import json
import os
from dataclasses import dataclass
from typing import Any

from ..errors import ExtractionError
from ..models import ASSUMED, EXTRACTED, MISSING, Field, LineItem, Offer
from .textract import ExtractedDoc

DEFAULT_MODEL = "claude-opus-5"
#: Long documents plus images: stream so a slow request cannot time out.
MAX_TOKENS = 16000
#: Claude downsamples above this; sending more just costs tokens.
MAX_IMAGE_EDGE = 1568
MAX_IMAGES_PER_REQUEST = 12

SYSTEM_PROMPT = """\
Ты извлекаешь данные из коммерческих предложений (КП) поставщиков для сборки
конкурентного листа. Документы бывают на русском, узбекском (кириллица и
латиница), английском и турецком языках; часть текста получена OCR и может
содержать ошибки распознавания.

Железные правила:
1. Никогда не выдумывай данные. Если поле отсутствует в документе — верни null
   и перечисли его в not_found.
2. Если значение выведено косвенно (например, валюта определена по символу
   "$", а не написана словом) — верни значение И опиши вывод в assumptions.
3. Числа возвращай числами, без пробелов и разделителей разрядов. Десятичная
   запятая в исходнике означает десятичную точку.
4. Даты возвращай в формате YYYY-MM-DD.
5. currency — трёхбуквенный код ISO 4217 (USD, EUR, UZS, RUB, TRY, CNY).
6. incoterms — только сам базис (EXW, FCA, CPT, CIP, DAP, DDP, FOB, CFR, CIF),
   пункт назначения указывай отдельно в delivery_point.
7. vat_included: true — цены с НДС, false — без НДС, null — не указано.
8. Если поставщик прислал несколько файлов, объедини их в одно предложение.
   При конфликте значений выбери коммерческий документ и опиши конфликт в
   assumptions.
9. line_items перечисляй так, как они даны в КП, ничего не додумывая. Если
   поставщик указал цену за 1 единицу, а не за весь требуемый объём —
   qty должно быть 1, не подгоняй его под требуемое количество.
10. stated_total — итоговая сумма, напечатанная самим поставщиком (нужна для
    сверки), либо null.
"""

OFFER_SCHEMA = {
    "type": "object",
    "properties": {
        "company_name": {"type": ["string", "null"]},
        "affiliation": {
            "type": ["string", "null"],
            "description": "принадлежность поставщика: производитель, дилер, дистрибьютор, посредник",
        },
        "is_manufacturer": {"type": ["boolean", "null"]},
        "tech_conclusion": {"type": ["string", "null"]},
        "country_origin": {"type": ["string", "null"]},
        "country_shipment": {"type": ["string", "null"]},
        "city": {"type": ["string", "null"]},
        "currency": {"type": ["string", "null"]},
        "vat_included": {"type": ["boolean", "null"]},
        "offer_date": {"type": ["string", "null"]},
        "validity_end": {"type": ["string", "null"]},
        "incoterms": {"type": ["string", "null"]},
        "delivery_point": {"type": ["string", "null"]},
        "payment_terms": {"type": ["string", "null"]},
        "warranty_terms": {"type": ["string", "null"]},
        "lead_time": {"type": ["string", "null"]},
        "procurement_procedure": {"type": ["string", "null"]},
        "transport_cost": {"type": ["number", "null"]},
        "stated_total": {"type": ["number", "null"]},
        "line_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "qty": {"type": ["number", "null"]},
                    "unit": {"type": ["string", "null"]},
                    "unit_price": {"type": ["number", "null"]},
                    "total_price": {"type": ["number", "null"]},
                    "notes": {"type": "string"},
                },
                "required": ["description", "qty", "unit", "unit_price", "total_price", "notes"],
                "additionalProperties": False,
            },
        },
        "not_found": {
            "type": "array",
            "items": {"type": "string"},
            "description": "имена полей, которых нет в документах",
        },
        "assumptions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "каждое значение, выведенное косвенно, с обоснованием",
        },
        "confidence": {"type": "number"},
    },
    "required": [
        "company_name", "affiliation", "is_manufacturer", "tech_conclusion",
        "country_origin", "country_shipment", "city", "currency", "vat_included",
        "offer_date", "validity_end", "incoterms", "delivery_point",
        "payment_terms", "warranty_terms", "lead_time", "procurement_procedure",
        "transport_cost", "stated_total", "line_items", "not_found",
        "assumptions", "confidence",
    ],
    "additionalProperties": False,
}

#: Model field name -> Offer attribute (identical today, kept explicit so the
#: schema can drift from the internal model without silent mismatches).
SCALAR_MAP = {name: name for name in OFFER_SCHEMA["properties"] if name not in
              ("line_items", "not_found", "assumptions", "confidence")}


def _encode_image(path: str) -> tuple[str, str]:
    """Return (media_type, base64 data), downscaled to the useful maximum."""
    from PIL import Image

    with Image.open(path) as image:
        image = image.convert("RGB")
        if max(image.size) > MAX_IMAGE_EDGE:
            ratio = MAX_IMAGE_EDGE / max(image.size)
            image = image.resize(
                (max(1, int(image.width * ratio)), max(1, int(image.height * ratio)))
            )
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
    return "image/png", base64.b64encode(buffer.getvalue()).decode("ascii")


def build_content(docs: list[ExtractedDoc], spec_note: str = "") -> list[dict]:
    """Assemble the user content blocks for one supplier."""
    content: list[dict] = []
    if spec_note:
        content.append({"type": "text", "text": spec_note})

    budget = MAX_IMAGES_PER_REQUEST
    for doc in docs:
        content.append({"type": "text", "text": f"\n=== ФАЙЛ: {os.path.basename(doc.path)} ({doc.mode}) ==="})
        if doc.is_ocr and doc.page_images and budget > 0:
            content.append({
                "type": "text",
                "text": "Это скан. Ниже сначала изображения страниц (им доверяй "
                        "больше), затем распознанный текст с возможными ошибками.",
            })
            for image_path in doc.page_images[:budget]:
                media_type, data = _encode_image(image_path)
                content.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": data},
                })
                budget -= 1
        content.append({"type": "text", "text": doc.text.strip()[:60000]})
    return content


def offer_from_payload(payload: dict, docs: list[ExtractedDoc]) -> Offer:
    """Convert the model's JSON into an Offer, preserving provenance."""
    offer = Offer()
    not_found = {str(name).strip() for name in payload.get("not_found") or []}
    assumptions = [str(a) for a in payload.get("assumptions") or []]
    # An assumption that names a field marks that field as assumed rather than
    # extracted, so the distinction survives into the workbook.
    assumed_fields = {
        name for name in SCALAR_MAP
        if any(name in text or name.replace("_", " ") in text.lower() for text in assumptions)
    }

    for name, attribute in SCALAR_MAP.items():
        value = payload.get(name)
        if value is None or name in not_found:
            source, note = MISSING, "не найдено в документах поставщика"
        elif name in assumed_fields:
            source, note = ASSUMED, next(
                (a for a in assumptions if name in a or name.replace("_", " ") in a.lower()), ""
            )
        else:
            source, note = EXTRACTED, ""
        setattr(offer, attribute, Field(value=value, source=source, note=note))

    sources = [doc.path for doc in docs]
    for raw in payload.get("line_items") or []:
        offer.line_items.append(
            LineItem(
                description=Field(value=raw.get("description"), source=EXTRACTED),
                qty=Field(value=raw.get("qty"), source=EXTRACTED if raw.get("qty") is not None else MISSING),
                unit=Field(value=raw.get("unit"), source=EXTRACTED if raw.get("unit") else MISSING),
                unit_price=Field(
                    value=raw.get("unit_price"),
                    source=EXTRACTED if raw.get("unit_price") is not None else MISSING,
                ),
                total_price=Field(
                    value=raw.get("total_price"),
                    source=EXTRACTED if raw.get("total_price") is not None else MISSING,
                ),
                notes=raw.get("notes") or "",
                source_files=list(sources),
            )
        )

    offer.source_files = sources
    offer.assumptions = assumptions
    offer.confidence = payload.get("confidence")
    for doc in docs:
        for warning in doc.warnings:
            offer.warnings.append(f"{os.path.basename(doc.path)}: {warning}")
    return offer


@dataclass
class LlmExtractor:
    """Extraction backed by Claude with a schema-constrained response."""

    model: str = DEFAULT_MODEL
    client: Any = None
    spec_note: str = ""

    def _get_client(self):
        if self.client is None:
            import anthropic

            self.client = anthropic.Anthropic()
        return self.client

    def extract(self, docs: list[ExtractedDoc]) -> Offer:
        if not docs:
            raise ExtractionError("<supplier>", "no readable documents")
        client = self._get_client()
        content = build_content(docs, self.spec_note)
        with client.messages.stream(
            model=self.model,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            thinking={"type": "adaptive"},
            output_config={"format": {"type": "json_schema", "schema": OFFER_SCHEMA}},
            messages=[{"role": "user", "content": content}],
        ) as stream:
            message = stream.get_final_message()

        if getattr(message, "stop_reason", None) == "refusal":
            raise ExtractionError(
                docs[0].path,
                f"model declined to process the document: {getattr(message, 'stop_details', None)}",
            )
        text = next((b.text for b in message.content if b.type == "text"), None)
        if not text:
            raise ExtractionError(docs[0].path, "model returned no JSON payload")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as error:
            raise ExtractionError(docs[0].path, f"model returned invalid JSON: {error}") from error
        return offer_from_payload(payload, docs)
