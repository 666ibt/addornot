"""Shared fixtures.

The template and the sample offers are committed under ``fixtures/``; they are
regenerated on demand so the suite still runs in a clean checkout.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
sys.path.insert(0, str(ROOT))

needs_libreoffice = pytest.mark.skipif(
    shutil.which("soffice") is None, reason="LibreOffice is not installed"
)
needs_ocr = pytest.mark.skipif(
    shutil.which("tesseract") is None or shutil.which("pdftoppm") is None,
    reason="tesseract/poppler are not installed",
)


@pytest.fixture(scope="session")
def template_path() -> Path:
    path = FIXTURES / "template.xlsx"
    if not path.exists():
        subprocess.run([sys.executable, str(FIXTURES / "make_template.py"), str(path)],
                       check=True, cwd=ROOT)
    return path


@pytest.fixture(scope="session")
def offers_dir() -> Path:
    path = FIXTURES / "offers"
    if not path.exists() or not any(path.iterdir()):
        subprocess.run([sys.executable, str(FIXTURES / "make_offers.py"), str(path)],
                       check=True, cwd=ROOT)
    return path


@pytest.fixture(scope="session")
def config():
    from compsheet.config import Config

    return Config.load(FIXTURES / "config.yaml")


@pytest.fixture(scope="session")
def fx(config):
    from compsheet.fx import FxTable

    return FxTable.from_config(config)


@pytest.fixture(scope="session")
def workdir():
    path = Path(tempfile.mkdtemp(prefix="compsheet-tests-"))
    yield path
    shutil.rmtree(path, ignore_errors=True)


@pytest.fixture(scope="session")
def extracted(config, fx, offers_dir, workdir):
    """The offline extraction of the whole fixture set, done once."""
    from compsheet.pipeline import Pipeline, build_extractor

    pipeline = Pipeline(
        config=config, fx=fx, workdir=workdir / "extract", verbose=False,
        extractor=build_extractor(config, use_llm=False),
    )
    return pipeline.run(offers_dir)
