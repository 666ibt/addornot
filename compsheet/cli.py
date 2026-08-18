"""Command line entry point: build-competitive-sheet."""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

from .config import Config
from .errors import CompSheetError, DependencyError
from .extract.tools import DEFAULT_OCR_LANGS, check_environment, resolve_ocr_languages
from .fx import build_fx_table
from .pipeline import Pipeline, build_extractor
from .review import apply_edit, interactive_review, load_json, save_json, summary
from .template.render import render
from .validate import validate


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="build-competitive-sheet",
        description="Собрать конкурентный лист из шаблона .xlsx и пачки КП поставщиков.",
    )
    parser.add_argument("--template", help="шаблон .xlsx с одним блоком сравнения")
    parser.add_argument("--offers", help="каталог с файлами КП (или подкаталог на поставщика)")
    parser.add_argument("--out", help="куда записать готовый файл")
    parser.add_argument("--config", help="YAML: спецификация закупки, курсы, НДС, метки")
    parser.add_argument("--fx", help="YAML только с курсами (сливается с --config)")
    parser.add_argument("--fx-online", action="store_true",
                        help="взять курсы с cbu.uz (только для базовой валюты UZS)")
    parser.add_argument("--from-json", help="взять данные из ранее сохранённого JSON, без извлечения")
    parser.add_argument("--save-json", help="куда сохранить извлечённые данные (по умолчанию рядом с --out)")
    parser.add_argument("--set", dest="edits", action="append", default=[],
                        metavar="КОМПАНИЯ.ПОЛЕ=ЗНАЧЕНИЕ",
                        help="исправить поле, не перезапуская извлечение (можно повторять)")
    parser.add_argument("--no-llm", action="store_true",
                        help="офлайн-эвристика вместо Claude (заметно менее точно)")
    parser.add_argument("--model", help="модель Claude для извлечения")
    parser.add_argument("--suppliers-per-block", type=int,
                        help="сколько поставщиков в одном блоке (по умолчанию из конфига)")
    parser.add_argument("--ocr-langs", default="+".join(DEFAULT_OCR_LANGS),
                        help="языковые пакеты tesseract через +")
    parser.add_argument("--allow-missing-ocr-langs", action="store_true",
                        help="не останавливаться, если нужного языкового пакета нет")
    parser.add_argument("--yes", "-y", action="store_true", help="не спрашивать подтверждение")
    parser.add_argument("--no-pdf", action="store_true", help="не делать PDF для визуальной проверки")
    parser.add_argument("--keep-work", action="store_true", help="не удалять временные файлы")
    parser.add_argument("--check-env", action="store_true",
                        help="показать доступность внешних программ и выйти")
    return parser


def _load_config(args) -> Config:
    config = Config.load(args.config)
    if args.fx:
        extra = Config.load(args.fx)
        config.fx.update(extra.fx)
        if extra.fx_source != "config":
            config.fx_source, config.fx_date = extra.fx_source, extra.fx_date
    if args.suppliers_per_block:
        config.suppliers_per_block = args.suppliers_per_block
    return config


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.check_env:
        for name, value in check_environment().items():
            print(f"{name:18s} {value}")
        return 0

    missing = [name for name in ("template", "out") if not getattr(args, name)]
    if not args.offers and not args.from_json:
        missing.append("offers либо from-json")
    if missing:
        parser.error("не заданы обязательные параметры: --" + ", --".join(missing))

    workdir = Path(tempfile.mkdtemp(prefix="compsheet-"))
    try:
        return _run(args, workdir)
    except CompSheetError as error:
        print(f"\nОШИБКА: {error}", file=sys.stderr)
        return 2
    finally:
        if args.keep_work:
            print(f"рабочий каталог: {workdir}")
        else:
            shutil.rmtree(workdir, ignore_errors=True)


def _run(args, workdir: Path) -> int:
    config = _load_config(args)
    fx = build_fx_table(config, online=args.fx_online)
    print(f"Курсы к {fx.base}: " + ", ".join(
        f"{code}={rate:g}" for code, rate in fx.as_rows() if code != fx.base) or "(нет)")

    if args.from_json:
        result = load_json(args.from_json)
        print(f"Загружено {len(result.offers)} предложений из {args.from_json}")
    else:
        # Scans need OCR in both extraction modes.
        try:
            langs = resolve_ocr_languages(
                requested=tuple(args.ocr_langs.split("+")),
                strict=not args.allow_missing_ocr_langs,
            )
            if langs.missing:
                print(f"ВНИМАНИЕ: нет языковых пакетов OCR: {', '.join(langs.missing)}")
        except DependencyError as error:
            print(f"\nОШИБКА ОКРУЖЕНИЯ: {error}", file=sys.stderr)
            return 3
        print(f"Извлечение из {args.offers} "
              f"({'офлайн-эвристика' if args.no_llm else 'Claude'})…")
        pipeline = Pipeline(
            config=config, fx=fx, workdir=workdir, langs=langs,
            extractor=build_extractor(config, use_llm=not args.no_llm, model=args.model),
        )
        result = pipeline.run(args.offers)

    for expression in args.edits:
        print("  " + apply_edit(result, expression))

    json_path = Path(args.save_json) if args.save_json else Path(args.out).with_suffix(".offers.json")
    save_json(result, json_path)

    if not result.offers:
        print("Не извлечено ни одного предложения — нечего собирать.", file=sys.stderr)
        return 2

    if args.yes or not sys.stdin.isatty():
        print(summary(result, config, fx))
    elif not interactive_review(result, config, fx):
        print("Отменено пользователем.")
        return 1
    save_json(result, json_path)
    print(f"Данные сохранены: {json_path}")
    print("  повторный запуск с правками:  --from-json "
          f"{json_path} --set 'Компания.поле=значение'")

    staged = workdir / Path(args.out).name
    report = render(args.template, result.offers, config, fx, str(staged))
    print(f"\nСобрано блоков: {report.blocks} "
          f"({config.suppliers_per_block} поставщика на блок, "
          f"{report.item_rows_per_block} позиций номенклатуры)")
    for note in report.notes:
        print(f"  · {note}")

    print("Пересчёт в LibreOffice…")
    validation = validate(staged, result.offers, report.placements, workdir,
                          pdf=not args.no_pdf)

    if validation.formula_errors:
        broken = Path(str(args.out) + ".invalid.xlsx")
        shutil.copy(staged, broken)
        print("\nОШИБКИ ФОРМУЛ — файл не выдан:", file=sys.stderr)
        for error in validation.formula_errors[:20]:
            print(f"  {error}", file=sys.stderr)
        print(f"  проблемный файл сохранён для разбора: {broken}", file=sys.stderr)
        return 4

    shutil.copy(staged, args.out)
    print(f"Готово: {args.out}")
    if validation.pdf:
        pdf_out = Path(args.out).with_suffix(".pdf")
        shutil.copy(validation.pdf, pdf_out)
        print(f"PDF для визуальной проверки: {pdf_out}")

    if validation.mismatches:
        print("\nСВЕРКА С КП — расхождения (файл выдан, но проверьте):")
        for mismatch in validation.mismatches:
            print(f"  ⚠ {mismatch}")
    else:
        print(f"Сверка сумм с КП: расхождений нет ({validation.checked_totals} предложений)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
