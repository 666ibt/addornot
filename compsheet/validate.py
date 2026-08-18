"""Post-generation checks.

A workbook is not handed over until LibreOffice has recalculated it and the
result has been read back: formula errors, a conversion that silently produced
zero, and totals that disagree with the supplier's own printed total are all
caught here rather than by the person who opens the file.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from openpyxl import load_workbook

from .errors import ValidationError
from .extract.tools import require, run
from .models import Offer

ERROR_MARKERS = ("#REF!", "#NAME?", "#DIV/0!", "#VALUE!", "#N/A", "#NULL!", "#NUM!", "Err:")


@dataclass
class ValidationReport:
    recalculated: str = ""
    pdf: str = ""
    formula_errors: list[str] = field(default_factory=list)
    mismatches: list[str] = field(default_factory=list)
    checked_totals: int = 0

    @property
    def ok(self) -> bool:
        return not self.formula_errors


def _soffice(args: list[str], outdir: Path, timeout: float = 300.0):
    require("soffice")
    outdir.mkdir(parents=True, exist_ok=True)
    profile = (outdir / "_loprofile").resolve()
    return run(
        ["soffice", "--headless", "--norestore", "--nolockcheck",
         f"-env:UserInstallation=file://{profile}", *args, "--outdir", str(outdir)],
        timeout=timeout,
    )


def recalculate(path: str | Path, workdir: str | Path) -> Path:
    """Round-trip the workbook through LibreOffice so formulas get values."""
    path = Path(path)
    workdir = Path(workdir) / "recalc"
    workdir.mkdir(parents=True, exist_ok=True)
    # Convert a copy: LibreOffice writes its output next to the name it is given.
    staged = workdir / path.name
    if staged.resolve() != path.resolve():
        shutil.copy(path, staged)
    result = _soffice(["--convert-to", "xlsx:Calc MS Excel 2007 XML", str(staged)],
                      workdir / "out")
    produced = workdir / "out" / path.name
    if not produced.exists():
        stderr = (result.stderr or b"").decode("utf-8", "replace")
        raise ValidationError(f"LibreOffice could not recalculate the workbook: {stderr[:300]}")
    return produced


def export_pdf(path: str | Path, workdir: str | Path) -> Path:
    """Re-export to PDF: the cheapest way to see layout problems."""
    path = Path(path)
    outdir = Path(workdir) / "pdf"
    result = _soffice(["--convert-to", "pdf", str(path)], outdir)
    produced = outdir / (path.stem + ".pdf")
    if not produced.exists():
        stderr = (result.stderr or b"").decode("utf-8", "replace")
        raise ValidationError(f"PDF export failed: {stderr[:300]}")
    return produced


def scan_formula_errors(path: str | Path) -> list[str]:
    workbook = load_workbook(path, data_only=True)
    errors = []
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                value = cell.value
                if isinstance(value, str) and any(value.startswith(m) or value == m
                                                  for m in ERROR_MARKERS):
                    errors.append(f"{sheet.title}!{cell.coordinate}: {value}")
    return errors


def cross_check_totals(path: str | Path, offers: list[Offer], placements) -> list[str]:
    """Compare the recalculated block totals with the supplier's own total."""
    workbook = load_workbook(path, data_only=True)
    by_company: dict[str, Offer] = {}
    for offer in offers:
        by_company.setdefault(offer.display_name, offer)

    problems = []
    for placement in placements:
        offer = by_company.get(placement.company)
        row = placement.role_rows.get("total_amount_ccy")
        if offer is None or row is None:
            continue
        stated = offer.stated_total.value
        if not stated:
            continue
        sheet = workbook[placement.sheet]
        computed = sheet.cell(row=row, column=placement.column).value
        if not isinstance(computed, (int, float)):
            problems.append(
                f"{placement.company}: сумма в валюте ТКП не вычислилась ({computed!r})"
            )
            continue
        if computed <= 0:
            problems.append(f"{placement.company}: сумма в валюте ТКП равна нулю")
            continue
        if abs(computed - float(stated)) > 0.01 * max(computed, float(stated)):
            problems.append(
                f"{placement.company}: в листе {computed:,.2f}, в самом КП {float(stated):,.2f} "
                "— расхождение больше 1%, проверьте цены и количества"
            )
    return problems


def validate(path: str | Path, offers: list[Offer], placements, workdir: str | Path,
             pdf: bool = True) -> ValidationReport:
    report = ValidationReport()
    recalculated = recalculate(path, workdir)
    report.recalculated = str(recalculated)
    report.formula_errors = scan_formula_errors(recalculated)
    report.mismatches = cross_check_totals(recalculated, offers, placements)
    report.checked_totals = len(placements)
    if pdf:
        report.pdf = str(export_pdf(path, workdir))
    return report
