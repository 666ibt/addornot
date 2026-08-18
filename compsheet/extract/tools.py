"""External binaries and their preconditions.

Tesseract silently falls back to whatever language data it has, so an OCR run
with only ``eng`` installed happily returns transliterated nonsense for a
Russian document.  That is the single most expensive failure mode in this
pipeline, so language packs are verified up front.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field

from ..errors import DependencyError

DEFAULT_OCR_LANGS = ("rus", "uzb_cyrl", "uzb", "eng", "tur")

#: Language packs whose absence makes OCR output actively misleading rather
#: than merely incomplete.
CRITICAL_OCR_LANGS = ("rus",)

APT_PACKAGE = {
    "pdftotext": "poppler-utils",
    "pdftoppm": "poppler-utils",
    "tesseract": "tesseract-ocr",
    "soffice": "libreoffice",
}


def which(binary: str) -> str | None:
    return shutil.which(binary)


def require(binary: str) -> str:
    path = which(binary)
    if not path:
        package = APT_PACKAGE.get(binary, binary)
        raise DependencyError(
            f"required binary {binary!r} not found. Install it, e.g. "
            f"`apt-get install -y {package}`"
        )
    return path


def run(cmd: list[str], timeout: float = 300.0, cwd: str | None = None):
    """Run a command, returning the CompletedProcess (never raises on rc!=0)."""
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def tesseract_languages() -> set[str]:
    require("tesseract")
    result = run(["tesseract", "--list-langs"], timeout=60)
    langs: set[str] = set()
    for line in (result.stdout or b"").decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line or line.lower().startswith("list of available"):
            continue
        langs.add(line)
    return langs


@dataclass
class OcrLanguages:
    """The language string actually passed to tesseract, plus what is missing."""

    available: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)

    @property
    def spec(self) -> str:
        return "+".join(self.available)


def resolve_ocr_languages(
    requested=DEFAULT_OCR_LANGS,
    strict: bool = True,
    critical=CRITICAL_OCR_LANGS,
) -> OcrLanguages:
    """Check requested language packs against what tesseract actually has.

    With ``strict`` (the default) a missing *critical* pack raises instead of
    letting OCR produce transliterated garbage.
    """
    installed = tesseract_languages()
    available = [lang for lang in requested if lang in installed]
    missing = [lang for lang in requested if lang not in installed]

    if not available:
        raise DependencyError(
            "tesseract has none of the requested language packs "
            f"({', '.join(requested)}); installed: {', '.join(sorted(installed)) or 'none'}"
        )
    blocking = [lang for lang in missing if lang in critical]
    if blocking and strict:
        raise DependencyError(
            "tesseract is missing language pack(s) "
            f"{', '.join(blocking)} — OCR would return transliterated text "
            "instead of the real one. Install with "
            f"`apt-get install -y {' '.join('tesseract-ocr-' + l.replace('_', '-') for l in blocking)}` "
            "or re-run with --allow-missing-ocr-langs to accept degraded OCR."
        )
    return OcrLanguages(available=available, missing=missing)


def check_environment(need_ocr: bool = True) -> dict[str, str]:
    """Report on every binary the pipeline can use."""
    report = {}
    for binary in ("pdftotext", "pdftoppm", "soffice", "tesseract"):
        report[binary] = which(binary) or "MISSING"
    if need_ocr and report["tesseract"] != "MISSING":
        report["tesseract-langs"] = ", ".join(sorted(tesseract_languages()))
    return report
