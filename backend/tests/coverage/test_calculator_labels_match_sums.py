"""Calculator labels must say what the sum does.

The paint dropdown said "Premium Emulsion (140 sqft/L)" while the sum used
135, so the litres shown did not match the coverage the user picked. The
labels now read the same table as the sum.

The plaster mix labels had internal and external the wrong way round: 1:4 is
the richer mix used outside, where walls face rain; 1:6 is the usual inside.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3] / "frontend" / "src"
PAGE = ROOT / "app" / "c" / "[company_id]" / "d" / "reports" / "calculators" / "page.tsx"


def _paint_options(src):
    a = src.index('<option value="economy">')
    b = src.index("</select>", a)
    return src[a:b]


def test_paint_coverage_labels_come_from_the_table_the_sum_uses():
    src = PAGE.read_text(encoding="utf-8")
    opts = _paint_options(src)
    # No coverage number typed into a label; each one reads the shared table.
    assert not re.search(r"\(\d+(\.\d+)? sqft/L\)", opts), opts
    for q in ("economy", "premium", "luxury", "texture"):
        assert f"PAINT_COVERAGE_SQFT_PER_LITRE.{q}" in opts, q


def test_plaster_mix_labels_put_the_richer_mix_outside():
    src = PAGE.read_text(encoding="utf-8")
    assert '<option value="1:4">1:4 (External walls)</option>' in src
    assert '<option value="1:6">1:6 (Internal walls)</option>' in src
    assert "1:6 for external plaster" not in src
    assert "1:6 (External/Rough plaster)" not in src
