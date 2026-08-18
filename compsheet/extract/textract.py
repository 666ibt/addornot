"""Turn an arbitrary supplier file into text (and page images when needed).

Routing per file type:

  pdf with text layer   -> pdftotext -layout
  pdf without one       -> pdftoppm -> tesseract
  doc/docx/rtf/odt      -> libreoffice txt; if the text comes out mangled
                           (the classic non-Unicode Cyrillic font case, where
                           conversion yields '?????'), fall back to
                           libreoffice pdf -> pdftoppm -> tesseract
  images                -> tesseract

A file that yields nothing usable raises ExtractionError; the caller reports it
to the user instead of quietly dropping the supplier.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from ..errors import ExtractionError
from .tools import OcrLanguages, require, resolve_ocr_languages, run

PDF_SUFFIXES = {".pdf"}
OFFICE_SUFFIXES = {".doc", ".docx", ".rtf", ".odt", ".txt", ".xls", ".xlsx", ".ods"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}

#: Below this many words per page a PDF is treated as a scan.
SCAN_WORDS_PER_PAGE = 25
#: Share of '?'/replacement characters above which a conversion is mangled.
MOJIBAKE_RATIO = 0.05
#: A usable document has at least this many letters.
MIN_LETTERS = 40
#: Share of Latin-1 supplement letters above which the text is a legacy
#: 8-bit encoding (CP1251 and friends) decoded as Latin-1.
LATIN1_SOUP_RATIO = 0.15

_LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)
_LATIN1_SUPPLEMENT_RE = re.compile(r"[\u00c0-\u00ff]")


@dataclass
class ExtractedDoc:
    path: str
    text: str = ""
    mode: str = ""
    page_images: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def word_count(self) -> int:
        return len(self.text.split())

    @property
    def is_ocr(self) -> bool:
        return self.mode.endswith("ocr")


# ---------------------------------------------------------------------------
# heuristics


def letter_count(text: str) -> int:
    return len(_LETTER_RE.findall(text))


def looks_mangled(text: str) -> tuple[bool, str]:
    """Detect a conversion that produced '?????' instead of readable text."""
    stripped = "".join(ch for ch in text if not ch.isspace())
    if not stripped:
        return True, "conversion produced no text"
    letters = letter_count(text)
    if letters < MIN_LETTERS:
        return True, f"only {letters} letters after conversion"
    suspicious = sum(
        1
        for ch in stripped
        if ch in "?�" or (unicodedata.category(ch) in ("Cc", "Co", "Cn") and ch not in "\t\n\r")
    )
    ratio = suspicious / len(stripped)
    if ratio > MOJIBAKE_RATIO:
        return True, f"{ratio:.0%} of characters are '?' or non-printable"
    soup = len(_LATIN1_SUPPLEMENT_RE.findall(text)) / max(1, letters)
    if soup > LATIN1_SOUP_RATIO:
        return True, (
            f"{soup:.0%} of letters are Latin-1 supplement characters — the text "
            "is a legacy 8-bit encoding read as Latin-1"
        )
    return False, ""


def _soffice_convert(path: Path, target: str, outdir: Path, timeout: float = 240.0) -> Path:
    """Convert with headless LibreOffice; returns the produced file."""
    require("soffice")
    outdir.mkdir(parents=True, exist_ok=True)
    profile = (outdir / "_loprofile").resolve()
    result = run(
        [
            "soffice",
            "--headless",
            "--norestore",
            "--nolockcheck",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to",
            target,
            "--outdir",
            str(outdir),
            str(path),
        ],
        timeout=timeout,
    )
    suffix = target.split(":")[0]
    produced = outdir / (path.stem + "." + suffix)
    if not produced.exists():
        stderr = (result.stderr or b"").decode("utf-8", "replace").strip()
        raise ExtractionError(str(path), f"LibreOffice could not convert to {suffix}: {stderr[:200]}")
    return produced


# ---------------------------------------------------------------------------
# per-format handlers


def pdf_to_text(path: Path) -> str:
    require("pdftotext")
    result = run(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"], timeout=180)
    if result.returncode != 0 and not result.stdout:
        stderr = (result.stderr or b"").decode("utf-8", "replace").strip()
        raise ExtractionError(str(path), f"pdftotext failed: {stderr[:200]}")
    return (result.stdout or b"").decode("utf-8", "replace")


def pdf_to_images(path: Path, outdir: Path, dpi: int = 300, max_pages: int = 30) -> list[str]:
    require("pdftoppm")
    outdir.mkdir(parents=True, exist_ok=True)
    prefix = outdir / path.stem
    result = run(
        ["pdftoppm", "-r", str(dpi), "-png", "-l", str(max_pages), str(path), str(prefix)],
        timeout=600,
    )
    images = sorted(str(p) for p in outdir.glob(path.stem + "-*.png"))
    if not images:
        stderr = (result.stderr or b"").decode("utf-8", "replace").strip()
        raise ExtractionError(str(path), f"could not render pages: {stderr[:200]}")
    return images


def ocr_images(images: list[str], langs: OcrLanguages) -> str:
    require("tesseract")
    chunks = []
    for image in images:
        result = run(["tesseract", image, "stdout", "-l", langs.spec, "--psm", "6"], timeout=300)
        chunks.append((result.stdout or b"").decode("utf-8", "replace"))
    return "\n".join(chunks)


# ---------------------------------------------------------------------------
# entry point


def extract_file(path: str | Path, workdir: str | Path, langs: OcrLanguages | None = None) -> ExtractedDoc:
    path = Path(path)
    workdir = Path(workdir)
    if not path.exists():
        raise ExtractionError(str(path), "file does not exist")
    if path.stat().st_size == 0:
        raise ExtractionError(str(path), "file is empty (download probably truncated)")

    suffix = path.suffix.lower()
    scratch = workdir / path.stem
    scratch.mkdir(parents=True, exist_ok=True)
    doc = ExtractedDoc(path=str(path))

    def ensure_langs() -> OcrLanguages:
        nonlocal langs
        if langs is None:
            langs = resolve_ocr_languages()
        return langs

    if suffix in PDF_SUFFIXES:
        text = pdf_to_text(path)
        pages = max(1, text.count("\f") or 1)
        if len(text.split()) >= SCAN_WORDS_PER_PAGE * pages:
            doc.text, doc.mode = text, "pdf_text"
            return doc
        doc.warnings.append("PDF has little or no text layer; treated as a scan and OCR'd")
        images = pdf_to_images(path, scratch)
        doc.page_images = images
        doc.text = ocr_images(images, ensure_langs())
        doc.mode = "pdf_ocr"

    elif suffix in IMAGE_SUFFIXES:
        doc.page_images = [str(path)]
        doc.text = ocr_images(doc.page_images, ensure_langs())
        doc.mode = "image_ocr"

    elif suffix in OFFICE_SUFFIXES:
        if suffix == ".txt":
            text = path.read_text(encoding="utf-8", errors="replace")
        else:
            converted = _soffice_convert(path, 'txt:Text (encoded):UTF8', scratch)
            text = converted.read_text(encoding="utf-8", errors="replace")
        mangled, reason = looks_mangled(text)
        if not mangled:
            doc.text, doc.mode = text, "office_text"
            return doc
        doc.warnings.append(
            f"text conversion looks mangled ({reason}); re-read via PDF render + OCR"
        )
        pdf = _soffice_convert(path, "pdf", scratch)
        images = pdf_to_images(pdf, scratch)
        doc.page_images = images
        doc.text = ocr_images(images, ensure_langs())
        doc.mode = "office_ocr"

    else:
        raise ExtractionError(str(path), f"unsupported file type {suffix!r}")

    if letter_count(doc.text) < MIN_LETTERS:
        raise ExtractionError(
            str(path),
            f"no readable text after {doc.mode} (got {letter_count(doc.text)} letters); "
            "the file is probably corrupt or a blank scan — ask the supplier to resend it",
        )
    return doc
