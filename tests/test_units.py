"""Unit tests for the pieces that decide what is trusted and what is guessed."""

from __future__ import annotations

import pytest

from compsheet.config import PARAM_ROLES, TOTAL_ROLES, Config
from compsheet.errors import FxError
from compsheet.extract.group import group_files, normalise_company
from compsheet.extract.heuristic import HeuristicExtractor, parse_number
from compsheet.extract.textract import looks_mangled
from compsheet.extract.tools import resolve_ocr_languages
from compsheet.fx import FxTable
from compsheet.models import ASSUMED, EXTRACTED, MISSING, Field, Offer


class TestFieldProvenance:
    def test_extracted_without_value_becomes_missing(self):
        assert Field(value=None, source=EXTRACTED).source == MISSING

    def test_bare_scalar_in_edited_json_counts_as_a_user_edit(self):
        assert Field.from_dict("USD").source == "user"

    def test_round_trip_keeps_source_and_note(self):
        offer = Offer(currency=Field.assumed("USD", "по символу $"))
        restored = Offer.from_dict(offer.to_dict())
        assert restored.currency.source == ASSUMED
        assert restored.currency.note == "по символу $"


class TestLabelRoles:
    @pytest.mark.parametrize("label,role", [
        ("Принадлежность поставщика", "affiliation"),
        ("Страна происхождения", "country_origin"),
        ("Базис поставки (ИНКОТЕРМС 2020)", "incoterms"),
        ("НДС в цене", "vat_included"),
    ])
    def test_parameter_labels(self, label, role):
        assert Config().match_role(label, PARAM_ROLES) == role

    @pytest.mark.parametrize("label,role", [
        ("Итого количество", "total_qty"),
        ("Сумма в валюте ТКП", "total_amount_ccy"),
        ("Сумма в UZS", "total_amount_base"),
        ("НДС 12%", "vat_amount"),
        ("Транспортные расходы", "transport_cost"),
        ("ИТОГО с НДС и транспортом", "grand_total"),
    ])
    def test_total_labels(self, label, role):
        assert Config().match_role(label, TOTAL_ROLES) == role

    def test_vat_in_price_is_not_a_vat_total(self):
        assert Config().match_role("НДС в цене", TOTAL_ROLES) is None


class TestFx:
    def test_base_currency_is_one(self):
        assert FxTable(base="UZS", rates={}).rate("UZS") == 1.0

    def test_unknown_currency_names_the_supplier(self):
        table = FxTable(base="UZS", rates={"USD": 12950})
        with pytest.raises(FxError, match="TRY"):
            table.rate("TRY", used_by="ООО Ромашка")

    def test_missing_currency_is_an_error_not_a_zero(self):
        with pytest.raises(FxError):
            FxTable(base="UZS", rates={}).rate("")

    def test_rows_start_with_the_base_currency(self):
        rows = FxTable(base="UZS", rates={"USD": 12950, "EUR": 14100}).as_rows()
        assert rows[0] == ("UZS", 1.0)
        assert ("USD", 12950.0) in rows


class TestMangledText:
    def test_question_marks(self):
        # A conversion that lost a non-Unicode font: some ASCII survives,
        # every Cyrillic glyph became '?'.
        text = "Kommercheskoe predlozhenie postavshchika oborudovaniya " + "????? " * 40
        mangled, reason = looks_mangled(text)
        assert mangled and "?" in reason

    def test_empty_conversion(self):
        assert looks_mangled("   \n  ")[0] is True

    def test_cp1251_read_as_latin1(self):
        text = "Коммерческое предложение на поставку резервуаров стальных" * 2
        mangled, reason = looks_mangled(text.encode("cp1251").decode("latin-1"))
        assert mangled and "Latin-1" in reason

    @pytest.mark.parametrize("text", [
        "Коммерческое предложение на поставку резервуаров стальных горизонтальных",
        "Commercial offer for the supply of horizontal steel tanks to Tashkent city",
        "Tijorat taklifi: rezervuar gorizontal po'lat, yetkazib berish sharti CPT",
    ])
    def test_readable_text_passes(self, text):
        assert looks_mangled(text)[0] is False


class TestNumbers:
    @pytest.mark.parametrize("token,value", [
        ("18 500,00", 18500.0),
        ("1 750 000,00", 1750000.0),
        ("235 000 000", 235000000.0),
        ("67600", 67600.0),
    ])
    def test_parse(self, token, value):
        assert parse_number(token) == value

    def test_row_is_rejected_when_price_and_total_disagree(self):
        assert HeuristicExtractor()._reconcile([50.0, 137.0])[3] is False

    def test_row_is_accepted_when_total_is_a_whole_multiple(self):
        qty, price, total, ok = HeuristicExtractor()._reconcile([4.0, 18500.0, 74000.0])
        assert (ok, qty, price, total) == (True, 4.0, 18500.0, 74000.0)

    def test_implausible_quantity_is_rejected(self):
        assert HeuristicExtractor()._reconcile([50.0, 235000940000.0])[3] is False


class TestGrouping:
    def test_files_group_by_leading_token(self, offers_dir):
        groups = dict(group_files(offers_dir))
        assert [p.name for p in groups["epsilon"]] == [
            "epsilon_commercial.pdf", "epsilon_tech.pdf"]
        assert len(groups["delta"]) == 2

    def test_company_key_ignores_legal_form_and_quotes(self):
        assert normalise_company('ООО «Альфа Нефтемаш»') == normalise_company("Альфа Нефтемаш")


class TestOcrLanguages:
    def test_missing_critical_language_raises(self):
        with pytest.raises(Exception, match="language pack"):
            resolve_ocr_languages(requested=("rus", "zzz"), critical=("zzz",))

    def test_non_critical_languages_are_only_reported(self):
        resolved = resolve_ocr_languages(requested=("eng", "zzz"), critical=("eng",))
        assert resolved.missing == ["zzz"] and "eng" in resolved.available
