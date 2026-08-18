"""Extraction pipeline: files in, reviewed offer data out."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .config import Config
from .errors import CompSheetError, ExtractionError
from .extract.group import group_files, normalise_company
from .extract.heuristic import HeuristicExtractor
from .extract.textract import ExtractedDoc, extract_file
from .extract.tools import OcrLanguages
from .fx import FxTable
from .models import ASSUMED, ExtractionResult, FailedFile, Field, LineItem, Offer


def spec_note(config: Config) -> str:
    """The purchase specification, handed to the extractor as context."""
    if not config.spec:
        return ""
    lines = [
        "Закупаемая номенклатура (для сопоставления позиций; НЕ подгоняй под неё "
        "данные поставщика, только сопоставляй):"
    ]
    for index, item in enumerate(config.spec, 1):
        lines.append(f"{index}. {item.description} — {item.qty:g} {item.unit}".rstrip())
    return "\n".join(lines)


def match_to_spec(offer: Offer, config: Config) -> None:
    """Attach a spec index to every line item that clearly maps to one."""
    if not config.spec:
        return
    for item in offer.line_items:
        if item.spec_index is not None:
            continue
        description = re.sub(r"\s+", " ", str(item.description.value or "")).lower()
        best, best_score = None, 0
        for index, spec in enumerate(config.spec):
            for keyword in spec.keywords():
                tokens = [t for t in re.split(r"[\s,;]+", keyword.lower()) if len(t) > 3]
                score = sum(token in description for token in tokens)
                if score > best_score:
                    best, best_score = index, score
        if best is not None and best_score >= 1:
            item.spec_index = best


def check_offer(offer: Offer, config: Config, fx: FxTable) -> None:
    """Add the warnings a human must see before the workbook is generated."""
    currency = offer.currency.value
    if not currency:
        offer.warnings.append("валюта предложения не определена — укажите её при проверке")
    elif not fx.has(str(currency)):
        offer.warnings.append(
            f"нет курса для валюты {currency} — добавьте его в fx-конфиг, иначе пересчёт невозможен"
        )
    if offer.vat_included.value is None:
        offer.warnings.append(
            "не указано, включён ли НДС в цену — от этого зависит расчёт итоговой суммы"
        )

    for index, spec in enumerate(config.spec):
        items = [item for item in offer.line_items if item.spec_index == index]
        if not items:
            offer.warnings.append(
                f"позиция «{spec.description}» не предложена (или не распознана) — "
                "в лист будет записано «не предложено»"
            )
            continue
        quoted = sum(float(item.qty.value or 0) for item in items)
        if spec.qty and quoted and quoted < spec.qty:
            offer.warnings.append(
                f"по позиции «{spec.description}» поставщик указал {quoted:g} {spec.unit}, "
                f"а требуется {spec.qty:g} — сравнение по итоговой сумме некорректно"
            )

    stated = offer.stated_total.value
    if stated:
        computed = sum(
            float(item.total_price.value or 0)
            or float(item.qty.value or 0) * float(item.unit_price.value or 0)
            for item in offer.line_items
        )
        if computed and abs(computed - float(stated)) > 0.01 * max(computed, float(stated)):
            offer.warnings.append(
                f"сумма позиций ({computed:,.2f}) расходится с итогом в КП ({float(stated):,.2f}) "
                "более чем на 1% — проверьте цены и количества"
            )


def fill_missing_from_spec(offer: Offer, config: Config) -> None:
    """Write an explicit placeholder for every position a supplier skipped."""
    for index, spec in enumerate(config.spec):
        if any(item.spec_index == index for item in offer.line_items):
            continue
        offer.line_items.append(
            LineItem(
                description=Field(value=config.not_offered_text, source=ASSUMED,
                                  note=f"поставщик не предложил позицию «{spec.description}»"),
                qty=Field(value=0, source=ASSUMED, note="предложение отсутствует"),
                unit=Field(value=spec.unit or None, source=ASSUMED, note="из спецификации"),
                unit_price=Field(value=0, source=ASSUMED, note="предложение отсутствует"),
                total_price=Field(value=0, source=ASSUMED, note="предложение отсутствует"),
                spec_index=index,
            )
        )
    offer.line_items.sort(key=lambda item: (item.spec_index is None, item.spec_index or 0))


@dataclass
class Pipeline:
    config: Config
    fx: FxTable
    extractor: object
    workdir: Path
    langs: OcrLanguages | None = None
    verbose: bool = True

    def log(self, message: str) -> None:
        if self.verbose:
            print(message, flush=True)

    def read_documents(self, paths: list[Path]) -> tuple[list[ExtractedDoc], list[FailedFile]]:
        docs, failed = [], []
        for path in paths:
            try:
                doc = extract_file(path, self.workdir, self.langs)
                self.log(f"    {path.name}: {doc.mode}, {doc.word_count} слов")
                for warning in doc.warnings:
                    self.log(f"      ! {warning}")
                docs.append(doc)
            except ExtractionError as error:
                self.log(f"    {path.name}: НЕ ПРОЧИТАН — {error.reason}")
                failed.append(FailedFile(path=str(path), reason=error.reason))
        return docs, failed

    def run(self, offers_dir: str | Path) -> ExtractionResult:
        result = ExtractionResult()
        groups = group_files(offers_dir)
        if not groups:
            raise CompSheetError(f"no offer files found in {offers_dir}")

        collected: list[Offer] = []
        for key, paths in groups:
            self.log(f"  [{key}] {len(paths)} файл(ов)")
            docs, failed = self.read_documents(paths)
            result.failed_files.extend(failed)
            if not docs:
                self.log("    пропущен: ни один файл не прочитан")
                continue
            offer = self.extractor.extract(docs)
            for item in failed:
                offer.warnings.append(
                    f"файл {Path(item.path).name} не прочитан ({item.reason}) — "
                    "данные из него отсутствуют, запросите файл повторно"
                )
            match_to_spec(offer, self.config)
            collected.append(offer)
            self.log(f"    → {offer.display_name}: {len(offer.line_items)} позиц.")

        result.offers = self.merge_duplicates(collected)
        for offer in result.offers:
            # Check first: once the gaps are filled with placeholders, a
            # position nobody quoted is indistinguishable from a zero-priced one.
            check_offer(offer, self.config, self.fx)
            fill_missing_from_spec(offer, self.config)
        return result

    def merge_duplicates(self, offers: list[Offer]) -> list[Offer]:
        """Fold two file groups that turned out to be the same company."""
        merged: list[Offer] = []
        index: dict[str, Offer] = {}
        for offer in offers:
            key = normalise_company(offer.display_name)
            if key and key in index:
                target = index[key]
                for name, value in offer.iter_fields():
                    current = getattr(target, name)
                    if current.value is None and value.value is not None:
                        setattr(target, name, value)
                target.line_items.extend(offer.line_items)
                target.source_files.extend(offer.source_files)
                target.assumptions.extend(offer.assumptions)
                target.warnings.append(
                    f"объединено с предложением из файлов: {', '.join(Path(p).name for p in offer.source_files)}"
                )
                continue
            index[key] = offer
            merged.append(offer)
        return merged


def build_extractor(config: Config, use_llm: bool, model: str | None = None):
    if not use_llm:
        return HeuristicExtractor(config=config)
    from .extract.llm import DEFAULT_MODEL, LlmExtractor

    return LlmExtractor(model=model or DEFAULT_MODEL, spec_note=spec_note(config))
