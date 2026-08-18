"""Exception types.

The pipeline deliberately fails loudly instead of degrading silently: a missing
OCR language pack or an unknown currency produces a wrong-but-plausible
spreadsheet, which is far more expensive than a stopped run.
"""


class CompSheetError(Exception):
    """Base class for all pipeline errors."""


class DependencyError(CompSheetError):
    """A required external binary or language pack is missing."""


class ExtractionError(CompSheetError):
    """A source document could not be turned into usable text/images."""

    def __init__(self, path, reason):
        self.path = path
        self.reason = reason
        super().__init__(f"{path}: {reason}")


class TemplateError(CompSheetError):
    """The template workbook does not match the expected block layout."""


class FxError(CompSheetError):
    """A currency was encountered that has no rate in the FX table."""


class ValidationError(CompSheetError):
    """The generated workbook failed recalculation or sanity checks."""
