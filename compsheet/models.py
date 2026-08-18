"""Data model for extracted offers.

Every scalar carries its provenance.  ``Field.source`` distinguishes a value
that was read out of the supplier's document from one the system chose on its
own -- that distinction is carried all the way through to cell comments in the
generated workbook.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Iterable

EXTRACTED = "extracted"
ASSUMED = "assumed"
MISSING = "missing"
USER = "user"

SOURCES = (EXTRACTED, ASSUMED, MISSING, USER)


@dataclass
class Field:
    """A single value plus where it came from."""

    value: Any = None
    source: str = MISSING
    note: str = ""

    def __post_init__(self):
        if self.source not in SOURCES:
            raise ValueError(f"unknown field source: {self.source!r}")
        if self.value is None and self.source == EXTRACTED:
            self.source = MISSING

    @property
    def is_trustworthy(self) -> bool:
        return self.source in (EXTRACTED, USER)

    def to_dict(self) -> dict:
        return {"value": self.value, "source": self.source, "note": self.note}

    @classmethod
    def from_dict(cls, data) -> "Field":
        if data is None:
            return cls()
        if not isinstance(data, dict):
            # Bare scalar in a hand-edited JSON review file: treat as a user edit.
            return cls(value=data, source=USER, note="set by user")
        return cls(
            value=data.get("value"),
            source=data.get("source", MISSING),
            note=data.get("note", ""),
        )

    @classmethod
    def extracted(cls, value, note="") -> "Field":
        return cls(value=value, source=EXTRACTED, note=note)

    @classmethod
    def assumed(cls, value, note) -> "Field":
        return cls(value=value, source=ASSUMED, note=note)

    @classmethod
    def missing(cls, note="") -> "Field":
        return cls(value=None, source=MISSING, note=note)


@dataclass
class LineItem:
    """One nomenclature position inside an offer."""

    description: Field = field(default_factory=Field)
    qty: Field = field(default_factory=Field)
    unit: Field = field(default_factory=Field)
    unit_price: Field = field(default_factory=Field)
    total_price: Field = field(default_factory=Field)
    notes: str = ""
    # Index into the purchase specification this item was matched to (or None).
    spec_index: int | None = None
    source_files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "description": self.description.to_dict(),
            "qty": self.qty.to_dict(),
            "unit": self.unit.to_dict(),
            "unit_price": self.unit_price.to_dict(),
            "total_price": self.total_price.to_dict(),
            "notes": self.notes,
            "spec_index": self.spec_index,
            "source_files": list(self.source_files),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LineItem":
        return cls(
            description=Field.from_dict(data.get("description")),
            qty=Field.from_dict(data.get("qty")),
            unit=Field.from_dict(data.get("unit")),
            unit_price=Field.from_dict(data.get("unit_price")),
            total_price=Field.from_dict(data.get("total_price")),
            notes=data.get("notes", ""),
            spec_index=data.get("spec_index"),
            source_files=list(data.get("source_files", [])),
        )


#: Scalar offer attributes, in the order they are shown during review.
SCALAR_FIELDS = (
    "company_name",
    "affiliation",
    "is_manufacturer",
    "tech_conclusion",
    "country_origin",
    "country_shipment",
    "city",
    "currency",
    "vat_included",
    "offer_date",
    "validity_end",
    "incoterms",
    "delivery_point",
    "payment_terms",
    "warranty_terms",
    "lead_time",
    "procurement_procedure",
    "transport_cost",
    "stated_total",
)


@dataclass
class Offer:
    """One supplier's commercial proposal, merged across all of their files."""

    company_name: Field = field(default_factory=Field)
    affiliation: Field = field(default_factory=Field)
    is_manufacturer: Field = field(default_factory=Field)
    tech_conclusion: Field = field(default_factory=Field)
    country_origin: Field = field(default_factory=Field)
    country_shipment: Field = field(default_factory=Field)
    city: Field = field(default_factory=Field)
    currency: Field = field(default_factory=Field)
    vat_included: Field = field(default_factory=Field)
    offer_date: Field = field(default_factory=Field)
    validity_end: Field = field(default_factory=Field)
    incoterms: Field = field(default_factory=Field)
    delivery_point: Field = field(default_factory=Field)
    payment_terms: Field = field(default_factory=Field)
    warranty_terms: Field = field(default_factory=Field)
    lead_time: Field = field(default_factory=Field)
    procurement_procedure: Field = field(default_factory=Field)
    transport_cost: Field = field(default_factory=Field)
    #: Total the supplier printed in their own document, used as a sanity check.
    stated_total: Field = field(default_factory=Field)

    line_items: list[LineItem] = field(default_factory=list)
    source_files: list[str] = field(default_factory=list)
    #: Free-form notes the extractor must emit for anything it guessed.
    assumptions: list[str] = field(default_factory=list)
    #: Problems that block a trustworthy comparison (unreadable file, short qty).
    warnings: list[str] = field(default_factory=list)
    confidence: float | None = None

    def iter_fields(self) -> Iterable[tuple[str, Field]]:
        for name in SCALAR_FIELDS:
            yield name, getattr(self, name)

    @property
    def display_name(self) -> str:
        return str(self.company_name.value or "?")

    def to_dict(self) -> dict:
        data = {name: f.to_dict() for name, f in self.iter_fields()}
        data["line_items"] = [item.to_dict() for item in self.line_items]
        data["source_files"] = list(self.source_files)
        data["assumptions"] = list(self.assumptions)
        data["warnings"] = list(self.warnings)
        data["confidence"] = self.confidence
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "Offer":
        offer = cls()
        for name in SCALAR_FIELDS:
            setattr(offer, name, Field.from_dict(data.get(name)))
        offer.line_items = [LineItem.from_dict(d) for d in data.get("line_items", [])]
        offer.source_files = list(data.get("source_files", []))
        offer.assumptions = list(data.get("assumptions", []))
        offer.warnings = list(data.get("warnings", []))
        offer.confidence = data.get("confidence")
        return offer


@dataclass
class FailedFile:
    """A file that could not be read, surfaced to the user rather than skipped."""

    path: str
    reason: str

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "FailedFile":
        return cls(path=data["path"], reason=data["reason"])


@dataclass
class ExtractionResult:
    """Everything the extraction stage produced, serialisable for review."""

    offers: list[Offer] = field(default_factory=list)
    failed_files: list[FailedFile] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "offers": [o.to_dict() for o in self.offers],
            "failed_files": [f.to_dict() for f in self.failed_files],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ExtractionResult":
        return cls(
            offers=[Offer.from_dict(d) for d in data.get("offers", [])],
            failed_files=[FailedFile.from_dict(d) for d in data.get("failed_files", [])],
        )
