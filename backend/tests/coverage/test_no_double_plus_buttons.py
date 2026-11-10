"""A button with the add icon must not also start its text with "+": it
showed two plus signs ("+ + Add Material" on the DPR form)."""
import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[3] / "frontend" / "src"


def test_add_icon_is_not_followed_by_a_typed_plus():
    pat = re.compile(r'<Icon\s+name="add"[^>]*/>\s*\+')
    hits = [str(p.relative_to(SRC)) for p in SRC.rglob("*.tsx") if pat.search(p.read_text(encoding="utf-8"))]
    assert hits == []


def test_dpr_quantity_and_workers_labels_line_up():
    src = (SRC / "app" / "c" / "[company_id]" / "d" / "dpr" / "page.tsx").read_text(encoding="utf-8")
    assert '<div className="flex justify-between items-center h-5">\n                    <label className="text-muted">Executed Qty</label>' in src
    assert '<div className="flex items-center h-5">\n                    <label className="text-muted">Workers Deployed</label>' in src
