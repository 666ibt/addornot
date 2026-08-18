"""Configuration: what a block *means*, not how it is drawn.

Everything that is specific to a particular purchase (labels used in the
template, the nomenclature being compared, VAT rate, FX rates) lives here so
that the engine itself stays product-agnostic.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .errors import CompSheetError

#: Semantic roles for the parameter rows above the nomenclature table.
PARAM_ROLES = (
    "affiliation",
    "is_manufacturer",
    "tech_conclusion",
    "country_origin",
    "country_shipment",
    "city",
    "currency",
    "offer_date",
    "validity_end",
    "incoterms",
    "delivery_point",
    "vat_included",
)

#: Semantic roles for the totals rows below the nomenclature table.
TOTAL_ROLES = (
    "total_qty",
    "total_amount_ccy",
    "total_amount_base",
    "vat_amount",
    "transport_cost",
    "grand_total",
    "lead_time",
    "payment_terms",
    "warranty_terms",
    "procurement_procedure",
)

#: Semantic roles for the columns of the nomenclature table.
ITEM_COLUMN_ROLES = (
    "num",
    "description",
    "unit",
    "qty",
    "unit_price_buyer",
    "unit_price_supplier",
    "amount",
)

DEFAULT_LABEL_PATTERNS: dict[str, list[str]] = {
    # -- parameter rows -------------------------------------------------
    "affiliation": [r"принадлежност"],
    "is_manufacturer": [r"производител"],
    "tech_conclusion": [r"тех(ническ\w*)?\s*заключ"],
    "country_origin": [r"стран\w*\s+происхожд"],
    "country_shipment": [r"стран\w*\s+отгруз"],
    "city": [r"^\s*город", r"пункт\s+отправ"],
    "currency": [r"валют"],
    "offer_date": [r"дат\w*\s+(предложен|ткп|кп)"],
    "validity_end": [r"срок\w*\s+действ", r"действительн\w*\s+до"],
    "incoterms": [r"базис\w*\s+поставк", r"incoterms", r"инкотермс"],
    "delivery_point": [r"пункт\w*\s+поставк", r"мест\w*\s+поставк"],
    "vat_included": [r"ндс\s+в\s+цене", r"цена\w*\s+с\s+ндс"],
    # -- totals rows ----------------------------------------------------
    "total_qty": [r"итог\w*\s+кол"],
    "total_amount_ccy": [r"сумм\w*\s+в\s+валют", r"сумм\w*\s+ткп"],
    "total_amount_base": [r"сумм\w*\s+в\s+(uzs|сум|узс)"],
    "vat_amount": [r"^\s*ндс(\s|\b)(?!.*в\s+цене)"],
    "transport_cost": [r"^\s*транспорт"],
    "grand_total": [r"^\s*итого(\s|$)(?!.*кол)"],
    "lead_time": [r"срок\w*\s+поставк"],
    "payment_terms": [r"услови\w*\s+оплат"],
    "warranty_terms": [r"гарант"],
    "procurement_procedure": [r"процедур\w*\s+закуп"],
}

DEFAULT_ITEM_COLUMN_PATTERNS: dict[str, list[str]] = {
    "num": [r"^\s*(№|n|номер)\s*(п/?п)?\s*$"],
    "description": [r"наименован", r"номенклатур", r"описан"],
    "unit": [r"ед\.?\s*изм"],
    "qty": [r"кол-?во", r"количеств"],
    "unit_price_buyer": [r"цен\w*\s+у?\s*покупател"],
    "unit_price_supplier": [r"цен\w*\s+у?\s*поставщик", r"цен\w*\s+за\s+ед"],
    "amount": [r"сумм"],
}


@dataclass
class SpecItem:
    """One position of the purchase specification (what the buyer asked for)."""

    description: str
    qty: float
    unit: str = ""
    #: Optional keywords used to match a supplier's free-text line to this item.
    match: list[str] = field(default_factory=list)

    def keywords(self) -> list[str]:
        return [k.lower() for k in (self.match or [self.description])]


@dataclass
class Config:
    base_currency: str = "UZS"
    vat_rate: float = 0.12
    suppliers_per_block: int = 2
    #: Rate of one unit of the key currency expressed in ``base_currency``.
    fx: dict[str, float] = field(default_factory=dict)
    fx_source: str = "config"
    fx_date: str = ""
    spec: list[SpecItem] = field(default_factory=list)
    label_patterns: dict[str, list[str]] = field(
        default_factory=lambda: {k: list(v) for k, v in DEFAULT_LABEL_PATTERNS.items()}
    )
    item_column_patterns: dict[str, list[str]] = field(
        default_factory=lambda: {
            k: list(v) for k, v in DEFAULT_ITEM_COLUMN_PATTERNS.items()
        }
    )
    #: Sheet that holds the dropdown lists; the FX table is written here too.
    reference_sheet: str | None = None
    #: Placeholder written into a position a supplier did not quote.
    not_offered_text: str = "— не предложено —"
    #: Reset "fit to one page" and insert page breaks between blocks.
    page_break_between_blocks: bool = True

    # -- helpers ------------------------------------------------------------

    def match_role(self, text: str, roles: tuple[str, ...]) -> str | None:
        """Return the semantic role of a label cell, or None if unrecognised."""
        if not text:
            return None
        norm = re.sub(r"\s+", " ", str(text)).strip().lower()
        for role in roles:
            for pattern in self.label_patterns.get(role, ()):
                if re.search(pattern, norm, re.IGNORECASE):
                    return role
        return None

    def match_item_column(self, text: str) -> str | None:
        if not text:
            return None
        norm = re.sub(r"\s+", " ", str(text)).strip().lower()
        for role in ITEM_COLUMN_ROLES:
            for pattern in self.item_column_patterns.get(role, ()):
                if re.search(pattern, norm, re.IGNORECASE):
                    return role
        return None

    def to_dict(self) -> dict:
        return {
            "base_currency": self.base_currency,
            "vat_rate": self.vat_rate,
            "suppliers_per_block": self.suppliers_per_block,
            "fx": dict(self.fx),
            "fx_source": self.fx_source,
            "fx_date": self.fx_date,
            "spec": [
                {
                    "description": s.description,
                    "qty": s.qty,
                    "unit": s.unit,
                    "match": list(s.match),
                }
                for s in self.spec
            ],
            "reference_sheet": self.reference_sheet,
            "not_offered_text": self.not_offered_text,
            "page_break_between_blocks": self.page_break_between_blocks,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Config":
        cfg = cls()
        for key in (
            "base_currency",
            "vat_rate",
            "suppliers_per_block",
            "fx_source",
            "fx_date",
            "reference_sheet",
            "not_offered_text",
            "page_break_between_blocks",
        ):
            if key in data and data[key] is not None:
                setattr(cfg, key, data[key])
        cfg.base_currency = cfg.base_currency.upper()
        cfg.fx = {str(k).upper(): float(v) for k, v in (data.get("fx") or {}).items()}
        cfg.spec = [
            SpecItem(
                description=str(item["description"]),
                qty=float(item.get("qty", 0) or 0),
                unit=str(item.get("unit", "") or ""),
                match=list(item.get("match", []) or []),
            )
            for item in (data.get("spec") or [])
        ]
        # Label overrides are merged, so a user only has to name what differs.
        for key, patterns in (data.get("label_patterns") or {}).items():
            cfg.label_patterns[key] = list(patterns)
        for key, patterns in (data.get("item_column_patterns") or {}).items():
            cfg.item_column_patterns[key] = list(patterns)
        if cfg.suppliers_per_block < 1:
            raise CompSheetError("suppliers_per_block must be >= 1")
        return cfg

    @classmethod
    def load(cls, path: str | Path | None) -> "Config":
        if path is None:
            return cls()
        text = Path(path).read_text(encoding="utf-8")
        data = yaml.safe_load(text) or {}
        if not isinstance(data, dict):
            raise CompSheetError(f"{path}: expected a YAML mapping")
        return cls.from_dict(data)
