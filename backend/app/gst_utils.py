# -*- coding: utf-8 -*-
"""
D4 (R2-041, R2-125, R2-319) — GST place of supply derives from Project.state.

POS = Project.state vs supplier GSTIN prefix (first 2 chars).
Same state -> CGST+SGST halves. Different -> IGST full.
Forward-only — no data rewrite; existing invoices keep their stored total.

State codes follow GSTIN 2-digit prefix (01-38) as per IGST Act s.12(3)
for works contracts: site location, not party address.
"""

import re
from typing import Optional

# Map lowercase state name -> 2-digit code
_GST_STATE_CODE_MAP = {
    "jammu and kashmir": "01",
    "himachal pradesh": "02",
    "punjab": "03",
    "chandigarh": "04",
    "uttarakhand": "05",
    "haryana": "06",
    "delhi": "07",
    "rajasthan": "08",
    "uttar pradesh": "09",
    "bihar": "10",
    "sikkim": "11",
    "arunachal pradesh": "12",
    "nagaland": "13",
    "manipur": "14",
    "mizoram": "15",
    "tripura": "16",
    "meghalaya": "17",
    "assam": "18",
    "west bengal": "19",
    "jharkhand": "20",
    "odisha": "21",
    "orissa": "21",
    "chhattisgarh": "22",
    "madhya pradesh": "23",
    "gujarat": "24",
    "daman and diu": "25",
    "dadra and nagar haveli": "26",
    "maharashtra": "27",
    "andhra pradesh": "28",
    "karnataka": "29",
    "goa": "30",
    "lakshadweep": "31",
    "kerala": "32",
    "tamil nadu": "33",
    "puducherry": "34",
    "puduchery": "34",
    "andaman and nicobar islands": "35",
    "telangana": "36",
    "andhra pradesh (new)": "37",
    "andhra pradesh new": "37",
    "ladakh": "38",
}

# Abbreviations -> code
_ABBREV_MAP = {
    "jk": "01",
    "hp": "02",
    "pb": "03",
    "ch": "04",
    "uk": "05",
    "hr": "06",
    "dl": "07",
    "rj": "08",
    "up": "09",
    "br": "10",
    "sk": "11",
    "ar": "12",
    "nl": "13",
    "mn": "14",
    "mz": "15",
    "tr": "16",
    "ml": "17",
    "as": "18",
    "wb": "19",
    "jh": "20",
    "or": "21",
    "ct": "22",
    "mp": "23",
    "gj": "24",
    "dd": "25",
    "dn": "26",
    "mh": "27",
    "ap": "37",
    "ka": "29",
    "ga": "30",
    "ld": "31",
    "kl": "32",
    "tn": "33",
    "py": "34",
    "an": "35",
    "tg": "36",
    "la": "38",
}


def state_name_for_code(code: Optional[str]) -> str:
    """'27' reads 'Maharashtra' on a document; unknown codes give ''."""
    code = str(code or "").strip().zfill(2)
    for name, c in _GST_STATE_CODE_MAP.items():
        if c == code and "new" not in name and name not in ("orissa", "puduchery"):
            return name.title().replace(" And ", " and ")
    return ""


def project_state_code(state: Optional[str]) -> Optional[str]:
    """
    Normalize Project.state (free-form) to a 2-digit GST state code.

    Accepts:
      - "27" or "29" directly
      - "27-Maharashtra" or "Maharashtra (27)" (first 2 digits extracted)
      - "Maharashtra", "karnataka", "Tamil Nadu" (name map)
      - "MH", "KA" (abbrev)
    Returns None when the value is empty or unrecognizable.
    """
    if not state or not str(state).strip():
        return None
    s = str(state).strip()
    # Direct 2-digit
    if s.isdigit() and len(s) == 2:
        code = s.zfill(2)
        if 1 <= int(code) <= 38:
            return code
        return None
    # Leading 2-digit prefix like "29 Karnataka" or "27-Maharashtra"
    m = re.match(r"^\s*(\d{2})\b", s)
    if m:
        code = m.group(1)
        if 1 <= int(code) <= 38:
            return code
    # Search for any isolated 2-digit in "Maharashtra (27)"
    # Prefer the map first for named states that also contain numbers
    low = s.lower().strip()
    # Strip parenthetical content for map lookup but keep digits for fallback
    key = re.sub(r"\(.*\)", "", low).strip()
    key = re.sub(r"\s+", " ", key)
    if key in _GST_STATE_CODE_MAP:
        return _GST_STATE_CODE_MAP[key]
    # Abbrev (2 letters)
    if low in _ABBREV_MAP:
        return _ABBREV_MAP[low]
    # Try to find a 2-digit code somewhere in the string (e.g. "MH-27")
    m2 = re.search(r"\b(\d{2})\b", s)
    if m2:
        code = m2.group(1)
        if 1 <= int(code) <= 38:
            return code
    # Cleaned name without non-letters
    key2 = re.sub(r"[^a-z ]", "", low).strip()
    key2 = re.sub(r"\s+", " ", key2)
    if key2 in _GST_STATE_CODE_MAP:
        return _GST_STATE_CODE_MAP[key2]
    return None


def supplier_state_code(gstin: Optional[str]) -> Optional[str]:
    """Return the 2-char state prefix from a GSTIN, or None if absent/invalid."""
    if not gstin or not str(gstin).strip():
        return None
    s = str(gstin).strip()
    if len(s) < 2:
        return None
    prefix = s[:2]
    if prefix.isdigit() and 1 <= int(prefix) <= 38:
        return prefix
    return None


def is_inter_state(project_state: Optional[str], supplier_gstin: Optional[str]) -> Optional[bool]:
    """
    True if site state differs from supplier state (IGST),
    False if same (CGST+SGST),
    None if either side is missing/unrecognizable.
    """
    p_code = project_state_code(project_state)
    s_code = supplier_state_code(supplier_gstin)
    if p_code is None or s_code is None:
        return None
    return p_code != s_code


def gst_split(tax_amount, project_state: Optional[str] = None, supplier_gstin: Optional[str] = None):
    """
    D4-compliant split: IGST when inter-state, CGST/SGST halves when intra-state.

    When either side is missing (None), falls back to the legacy intra-state
    halves so that reports remain renderable for legacy rows; the would-change
    endpoint treats those as indeterminate rather than a head change.

    Returns (cgst, sgst, igst, utgst) floats rounded to 2dp in the conventional
    half-split manner (second half is remainder to avoid 0.01 drift).
    """
    try:
        tax = float(tax_amount) if tax_amount is not None else 0.0
    except Exception:
        tax = 0.0
    if tax == 0.0:
        return 0.0, 0.0, 0.0, 0.0
    inter = is_inter_state(project_state, supplier_gstin)
    if inter is True:
        # Inter-state — entire tax is IGST
        return 0.0, 0.0, round(tax, 2), 0.0
    # Intra-state (False) or indeterminate (None) — halves
    # Indeterminate stays legacy halves so existing PDFs without site state
    # do not silently shift to IGST; enforcement of state happens at write time.
    half = round(tax / 2.0, 2)
    return half, round(tax - half, 2), 0.0, 0.0
