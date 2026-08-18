#!/usr/bin/env bash
# System dependencies. LibreOffice needs writer *and* calc: the base
# `libreoffice` package alone cannot open a document, and every conversion
# fails with "source file could not be loaded".
set -euo pipefail

sudo apt-get update
sudo apt-get install -y \
  libreoffice-writer libreoffice-calc \
  poppler-utils \
  tesseract-ocr tesseract-ocr-rus tesseract-ocr-uzb tesseract-ocr-uzb-cyrl tesseract-ocr-tur

python3 -m pip install -r requirements.txt

echo
echo "Проверка:"
python3 -m compsheet.cli --check-env
