"""Shared CSV export safety.

One helper, every export. R2-185 originally named four call sites and asked for
"one helper, four call sites"; it was closed on one site, and the pattern then
repeated twice more -- R2-407 closed with the note "last raw-text exporter",
and R2-743 found bi_export.py still unprotected. Each time the protection
existed in the repository and simply did not reach every surface, which is why
per-finding gates kept passing: each pinned its own file.

The three local `_csv_safe_cell` definitions (dpr.py, hr.py, labour.py) were
byte-identical duplicates. This module is the single copy they now share, and
bi_export.py routes through it too.
"""

# A cell whose text begins with any of these is executed as a formula when the
# export is opened in Excel / LibreOffice / Sheets. Quote-doubling protects the
# delimiter, not the formula -- a leading "=" survives a correctly-quoted CSV
# field entirely intact.
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def csv_safe_cell(value):
    """Neutralise a formula cell by prefixing a single quote.

    Everything that is not a string, and every string that does not begin with a
    formula prefix, passes through untouched -- this must not alter data.
    """
    if isinstance(value, str) and value.startswith(CSV_FORMULA_PREFIXES):
        return "'" + value
    return value


def csv_safe_row(row):
    """Apply csv_safe_cell to every value in a mapping or sequence."""
    if isinstance(row, dict):
        return {k: csv_safe_cell(v) for k, v in row.items()}
    return [csv_safe_cell(v) for v in row]


# ── Human-readable CSV files ────────────────────────────────────────────────
# Exports are opened in Excel by site and accounts staff. Python's float repr
# leaked into them ("85000.0", "1.7999999999999998 MT"), files carried no
# byte-order mark so Excel on Windows misread rupee signs and Indian names,
# and filenames were raw UUIDs. Every human-facing CSV goes through here.
import csv as _csv
import io as _io
import re as _re

from fastapi import Response as _Response


def money(value) -> str:
    """Rupee amount with two decimals, no symbol, so Excel can still sum it."""
    try:
        return f"{round(float(value or 0), 2):.2f}"
    except (TypeError, ValueError):
        return ""


def qty(value, places: int = 3) -> str:
    """A quantity without float noise: 1.8 not 1.7999999999999998, 29 not 29.0."""
    try:
        text = f"{round(float(value or 0), places):.{places}f}"
    except (TypeError, ValueError):
        return ""
    return text.rstrip("0").rstrip(".") if "." in text else text


def file_slug(*parts) -> str:
    """Readable filename part from names or codes, safe on every OS."""
    text = "-".join(str(p) for p in parts if p not in (None, ""))
    text = _re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")
    return text[:80] or "export"


def csv_attachment(columns, rows, filename: str) -> _Response:
    """CSV download with a UTF-8 byte-order mark (Excel needs it to read the
    file as UTF-8) and every text cell guarded against formula injection."""
    buf = _io.StringIO()
    writer = _csv.writer(buf)
    writer.writerow(columns)
    for row in rows:
        writer.writerow(csv_safe_row(row))
    if not filename.lower().endswith(".csv"):
        filename += ".csv"
    return _Response(
        content="﻿" + buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )
