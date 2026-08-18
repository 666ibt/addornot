"""Group the incoming files by supplier.

One supplier commonly sends several files (a technical part and a commercial
part, separate offers per position, or a scan alongside the editable original),
so files are grouped before extraction and the model sees a supplier's whole
submission at once.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

IGNORED_NAMES = {".ds_store", "thumbs.db"}


def normalise_company(name: str) -> str:
    """A comparison key that survives quoting and legal-form differences."""
    text = unicodedata.normalize("NFKD", (name or "").lower())
    text = re.sub(r"\b(ооо|оао|зао|ао|тоо|ип|мчж|mchj|llc|ltd|llp|gmbh|a\.?ş|as|xk)\b", " ", text)
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def group_files(root: str | Path) -> list[tuple[str, list[Path]]]:
    """Return ``[(group key, files)]``.

    A subdirectory is taken as an explicit supplier grouping; loose files are
    grouped by their leading filename token, which is how these bundles are
    named in practice (``alfa_kp.pdf``, ``alfa_tech.pdf``).
    """
    root = Path(root)
    if not root.is_dir():
        raise NotADirectoryError(f"{root} is not a directory")

    groups: dict[str, list[Path]] = {}
    for entry in sorted(root.iterdir()):
        if entry.name.lower() in IGNORED_NAMES or entry.name.startswith("."):
            continue
        if entry.is_dir():
            files = [
                path for path in sorted(entry.rglob("*"))
                if path.is_file() and not path.name.startswith(".")
            ]
            if files:
                groups[entry.name] = files
        elif entry.is_file():
            key = re.split(r"[_\-. ]", entry.stem)[0].lower() or entry.stem.lower()
            groups.setdefault(key, []).append(entry)
    return sorted(groups.items())


def merge_by_company(results: list[tuple[str, "object"]]) -> list[tuple[str, list]]:
    """Merge groups that turned out to be the same company after extraction."""
    merged: dict[str, list] = {}
    order: list[str] = []
    for key, offer in results:
        name = normalise_company(getattr(offer, "display_name", "")) or key
        if name not in merged:
            order.append(name)
            merged[name] = []
        merged[name].append(offer)
    return [(name, merged[name]) for name in order]
