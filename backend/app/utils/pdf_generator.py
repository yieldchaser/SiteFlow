# -*- coding: utf-8 -*-
"""
Pure Python PDF Generator for Phase 11 Client Portal & Progress Reports.
Creates a valid PDF 1.4 document with title, headings, margins, and text lines.

Also provides `generate_document_pdf`, a sibling generator for line-item
documents (Sales Invoice / Purchase Order / BOQ) that reuses the exact same
manual PDF object construction style (no external deps).
"""

from datetime import datetime
import zlib


# ─── Branding image embedding (R2-404) ───────────────────────────────────────
#
# The uploaded Logo / Signature / Stamp / Watermark (CompanyFile rows) are
# decoded here and embedded into the generated PDFs so the documents a company
# issues actually carry its letterhead and seals. Only baseline JPEG (DCTDecode
# passthrough) and non-interlaced 8/16-bit PNG are supported; anything else is
# skipped rather than rendered as something invented.

_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _parse_jpeg(data):
    """Return an embed spec for a baseline/progressive JPEG, else None."""
    if len(data) < 4 or data[0:2] != b"\xff\xd8":
        return None
    i = 2
    n = len(data)
    while i + 4 < n:
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if i + 9 > n:
            return None
        seg_len = int.from_bytes(data[i + 2:i + 4], "big")
        if seg_len < 2:
            return None
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height = int.from_bytes(data[i + 5:i + 7], "big")
            width = int.from_bytes(data[i + 7:i + 9], "big")
            components = data[i + 9]
            if width <= 0 or height <= 0 or components not in (1, 3):
                return None
            return {
                "kind": "jpeg",
                "width": width,
                "height": height,
                "colorspace": "/DeviceGray" if components == 1 else "/DeviceRGB",
                "stream": data,
            }
        i += 2 + seg_len
    return None


def _paeth(a, b, c):
    pa = abs(b - c)
    pb = abs(a - c)
    pc = abs(a + b - 2 * c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _decode_png(data):
    """Decode a non-interlaced PNG to raw RGB bytes (alpha composited on white)."""
    if data[:8] != _PNG_SIG:
        return None
    pos = 8
    header = None
    palette = b""
    idat = bytearray()
    while pos + 8 <= len(data):
        ln = int.from_bytes(data[pos:pos + 4], "big")
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if ctype == b"IHDR":
            header = chunk
        elif ctype == b"PLTE":
            palette = chunk
        elif ctype == b"IDAT":
            idat.extend(chunk)
        elif ctype == b"IEND":
            break
    if header is None or len(header) < 10:
        return None
    width = int.from_bytes(header[0:4], "big")
    height = int.from_bytes(header[4:8], "big")
    bit_depth, color_type, compression, filter_method, interlace = (
        header[8], header[9], header[10], header[11], header[12],
    )
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None or bit_depth not in (8, 16):
        return None
    if compression or filter_method or interlace:
        return None
    if width <= 0 or height <= 0 or width * height > 4_000_000:
        return None
    sample = bit_depth // 8
    stride = width * channels * sample
    try:
        raw = zlib.decompress(bytes(idat))
    except zlib.error:
        return None
    if len(raw) < (stride + 1) * height:
        return None

    lines = []
    prev = bytearray(stride)
    p = 0
    bpp = channels * sample
    for _y in range(height):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ftype == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif ftype == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif ftype == 4:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                upleft = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(left, prev[i], upleft)) & 255
        elif ftype != 0:
            return None
        prev = line
        if sample == 2:
            line = bytearray(line[i] for i in range(0, stride, 2))
        lines.append(line)

    rgb = bytearray(width * height * 3)
    out_i = 0
    for line in lines:
        for x in range(width):
            base = x * channels
            if color_type == 0:
                g = line[base]
                rgb[out_i] = rgb[out_i + 1] = rgb[out_i + 2] = g
            elif color_type == 2:
                rgb[out_i] = line[base]
                rgb[out_i + 1] = line[base + 1]
                rgb[out_i + 2] = line[base + 2]
            elif color_type == 3:
                idx = line[base] * 3
                rgb[out_i] = palette[idx] if idx + 2 < len(palette) else 255
                rgb[out_i + 1] = palette[idx + 1] if idx + 2 < len(palette) else 255
                rgb[out_i + 2] = palette[idx + 2] if idx + 2 < len(palette) else 255
            elif color_type == 4:
                g = line[base]
                a = line[base + 1]
                rgb[out_i] = rgb[out_i + 1] = rgb[out_i + 2] = (g * a + 255 * (255 - a)) // 255
            else:  # RGBA
                a = line[base + 3]
                for c in range(3):
                    v = line[base + c]
                    rgb[out_i + c] = (v * a + 255 * (255 - a)) // 255
            out_i += 3
    return {"kind": "raw", "width": width, "height": height,
            "colorspace": "/DeviceRGB", "stream": bytes(rgb)}


def decode_branding_image(data):
    """Decode upload bytes into an embeddable image spec, or None when the
    format is not supported (unsupported assets are skipped, never invented)."""
    if not data:
        return None
    return _parse_jpeg(data) or _decode_png(data)


def _fit_box(w, h, max_w, max_h):
    scale = min(max_w / float(w), max_h / float(h), 1.0)
    return w * scale, h * scale


def _image_draw_ops(name, spec, x, y, w, h, faded=False):
    ops = [b"q"]
    if faded:
        ops.append(b"/GS1 gs")
    ops.append(
        f"{w:.2f} 0 0 {h:.2f} {x:.2f} {y:.2f} cm".encode("ascii")
    )
    ops.append(f"/{name} Do".encode("ascii"))
    ops.append(b"Q")
    return ops


def _collect_branding_assets(branding):
    """Decode the upload map into embeddable image specs by asset name."""
    assets = {}
    if branding:
        for name in ("watermark", "logo", "signature", "stamp"):
            asset = branding.get(name)
            if not asset:
                continue
            spec = decode_branding_image(asset.get("data"))
            if spec:
                assets[name] = spec
    return assets


def _place_asset(assets, name, max_w, max_h):
    spec = assets.get(name)
    if not spec:
        return None
    w, h = _fit_box(spec["width"], spec["height"], max_w, max_h)
    return name.upper(), spec, w, h


def _add_image_object(add_object_fn, spec) -> int:
    """Append one image XObject; returns its object id."""
    head = (
        f"/Type /XObject /Subtype /Image /Width {spec['width']} /Height {spec['height']} "
        f"/ColorSpace {spec['colorspace']} /BitsPerComponent 8"
    )
    if spec["kind"] == "jpeg":
        head += " /Filter /DCTDecode"
    stream = spec["stream"]
    body = (
        f"<< {head} /Length {len(stream)} >>\nstream\n".encode("ascii")
        + stream
        + b"\nendstream\n"
    )
    return add_object_fn(body)

def generate_client_report_pdf(
    title: str,
    summary: str,
    metrics: dict,
    company_name: str = "",
    custom_banner: str = None,
    branding: dict = None,
    supplier_lines=None,
    details=None,
) -> bytes:
    """
    Generates a valid, readable minimal PDF 1.4 byte stream.

    details: optional "Key: Value" lines under the title (project, report
        date) so the client can tell which site the report is about.
    Requires no external packages (pure standard library).

    company_name: printed as a masthead line above the title. Sourced from
        Company.document_company_name_display ("company" vs "branch") -- the
        caller resolves which name string to pass in.
    custom_banner: when the company has Company.custom_pdf_template_enabled
        set and a PdfTemplate row is configured, its `content` is passed here
        and rendered as an extra banner line beneath the masthead, giving a
        visibly different ("custom") layout vs. the default template. None /
        empty keeps the default layout unchanged.
    supplier_lines: optional registered-identity lines of the issuing company
        (legal name / GSTIN / phone / address, R2-607 reusing the R2-403
        machinery), printed under the masthead so client-facing reports carry
        the same supplier details the bill/PO/BOQ documents print.
    branding: optional {"logo"|"signature"|"stamp"|"watermark": {"data": bytes,
        "content_type": str}} map of the company's uploaded branding assets
        (R2-404). Watermark renders faded behind the page, the logo sits at the
        top-right, signature and stamp are placed in the footer band. Assets in
        unsupported formats are skipped rather than invented.
    """
    # R2-414: zero assessed lab tests means there IS no rate, so say that
    # instead of printing a "0%" headline that reads as every test failed.
    # 0% remains honest only when tests exist and all of them fail.
    tests_pass_rate = metrics.get('quality_tests_pass_rate')
    if tests_pass_rate is None:
        tests_line = "Material Lab Tests Pass Rate: No lab tests assessed"
    else:
        tests_line = (
            f"Material Lab Tests Pass Rate: {tests_pass_rate}% "
            f"({metrics.get('quality_tests_pass_count', 0)} passed of "
            f"{metrics.get('quality_tests_total', 0) - metrics.get('quality_tests_unassessed', 0)} assessed; "
            f"{metrics.get('quality_tests_unassessed', 0)} not assessed)"
        )

    # Sections mapping
    sections = [
        ("PROJECT SCHEDULE & TIMELINE", [
            f"Total Tasks in WBS: {metrics.get('tasks_total', 0)}",
            f"Completed Tasks: {metrics.get('tasks_completed', 0)}",
            f"Tasks in Progress: {metrics.get('tasks_active', 0)}",
            f"Average Completion: {metrics.get('tasks_completion_pct', 0)}%"
        ]),
        ("FINANCIALS & SUBCONTRACTOR BILLING", [
            f"Total Work Orders Issued: {metrics.get('billing_wo_count', 0)}",
            f"Total RA Bills Submitted: {metrics.get('billing_ra_count', 0)}",
            f"Total Net Certified Amount: {_money_text(metrics.get('billing_certified_net', '0.00'))}"
        ]),
        ("MATERIAL PROCUREMENT", [
            f"Material Indents Raised: {metrics.get('procurement_indents', 0)}",
            f"Purchase Orders Issued: {metrics.get('procurement_pos', 0)}"
        ]),
        ("QUALITY CONTROL & LAB TESTS", [
            f"Total Site Inspections Run: {metrics.get('quality_inspections', 0)}",
            f"Open Non-Conformance Reports (NCRs): {metrics.get('quality_ncr_open', 0)}",
            f"Closed/Resolved NCRs: {metrics.get('quality_ncr_closed', 0)}",
            tests_line
        ])
    ]

    if summary:
        sections.insert(0, ("EXECUTIVE SUMMARY", [summary]))

    # Laid out by the same engine as invoices: measured text, wrapped
    # summary, IST footer with page numbers, branding in the same places.
    return generate_document_pdf(
        title=title,
        party_lines=list(details or []),
        sections=[(heading.title().replace("&", "and").replace("Ncrs", "NCRs"), lines) for heading, lines in sections],
        company_name=company_name,
        custom_banner=custom_banner,
        supplier_lines=supplier_lines,
        branding=branding,
    )


def _esc(s: str) -> str:
    """PDF text-escape parentheses and backslashes, latin1-safe."""
    return str(s).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _fmt_row(cells, widths):
    """Render one fixed-width row from cell strings + column widths."""
    out = []
    for cell, w in zip(cells, widths):
        s = _esc(str(cell))
        if len(s) > w:
            s = s[: max(w - 1, 1)] + " "
        out.append(s.ljust(w))
    return "".join(out)


def _wrap_text(text: str, width: int):
    """Greedy word-wrap, also splitting on explicit newlines. Returns lines."""
    lines = []
    for para in str(text).split("\n"):
        words = para.split(" ")
        cur = ""
        for w in words:
            if not cur:
                cur = w
            elif len(cur) + 1 + len(w) <= width:
                cur += " " + w
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines



# ── Text measurement and number formatting for document PDFs ────────────────
# Standard Helvetica / Helvetica-Bold advance widths (1/1000 em), ASCII 32-126.
_HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584]
_HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]


def _text_width(value: str, font: str, size: float) -> float:
    table = _HELV_B if font == "F2" else _HELV
    total = 0
    for ch in str(value):
        o = ord(ch)
        total += table[o - 32] if 32 <= o <= 126 else 556
    return total * size / 1000.0


def _wrap_width(value, font: str, size: float, max_w: float):
    """Word-wrap to a width in points; breaks over-long words too."""
    value = str(value or "")
    if not value:
        return []
    lines, cur = [], ""
    for word in value.split(" "):
        trial = word if not cur else cur + " " + word
        if _text_width(trial, font, size) <= max_w:
            cur = trial
            continue
        if cur:
            lines.append(cur)
        while _text_width(word, font, size) > max_w and len(word) > 1:
            cut = len(word)
            while cut > 1 and _text_width(word[:cut], font, size) > max_w:
                cut -= 1
            lines.append(word[:cut])
            word = word[cut:]
        cur = word
    if cur:
        lines.append(cur)
    return lines


def _is_number(value) -> bool:
    try:
        float(str(value).replace(",", "").strip())
        return str(value).strip() != ""
    except (TypeError, ValueError):
        return False


def _is_count_label(key: str) -> bool:
    k = key.lower()
    return any(w in k for w in ("items", "count", "milestone", "%", "pct", "percent", "no.", "number"))


def _indian(n: float, places: int = 2) -> str:
    """12,34,567.50: Indian digit grouping."""
    neg = n < 0
    text = f"{abs(n):.{places}f}"
    whole, _, frac = text.partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    out = whole + ("." + frac if frac else "")
    return ("-" if neg else "") + out


def _column_kind(header: str) -> str:
    h = str(header).lower()
    if any(w in h for w in ("rate", "amount", "value", "total", "price", "cost")):
        return "money"
    if any(w in h for w in ("qty", "quantity", "received", "tax%", "%", "nos")):
        return "qty"
    return "text"


def _format_cell(cell, kind: str) -> str:
    raw = "" if cell is None else str(cell)
    if kind == "text" or not _is_number(raw):
        return raw
    n = float(raw.replace(",", ""))
    if kind == "money":
        return _indian(n, 2)
    shown = _indian(n, 3)
    if "." in shown:
        shown = shown.rstrip("0").rstrip(".")
    return shown


def _money_text(value) -> str:
    try:
        return _indian(float(str(value).replace(",", "")), 2)
    except (TypeError, ValueError):
        return str(value)


def _ist_now():
    from datetime import timedelta, timezone as _tz
    return datetime.now(_tz(timedelta(hours=5, minutes=30)))

def generate_document_pdf(
    title: str,
    party_lines=None,
    table_headers=None,
    table_rows=None,
    col_widths=None,
    totals_lines=None,
    terms=None,
    company_name: str = "",
    custom_banner: str = None,
    supplier_lines=None,
    branding: dict = None,
    sections=None,
) -> bytes:
    """
    Pure-Python PDF for a line-item business document (Invoice / PO / BOQ).

    sections: optional [(heading, [lines])] blocks printed after the details,
        used by the client progress report.

    Reuses the same content-stream construction style as
    `generate_client_report_pdf` (manual object assembly, no external libs)
    but lays out a party-info block, an optional fixed-width line-item table,
    a totals block, and a wrapped Terms & Conditions footer. Long documents
    automatically paginate so content is never clipped off the page bottom.

    company_name / custom_banner: same semantics as the report generator
    (Document Company Name Display + optional custom PDF template banner).

    supplier_lines: optional registered-identity lines of the issuing company
        (legal name / GSTIN / phone / address, R2-403), printed under the
        masthead so tax documents carry the supplier details Rule 46 requires.

    branding: optional {"logo"|"signature"|"stamp"|"watermark": {"data": bytes,
        "content_type": str}} map of the company's uploaded branding assets
        (R2-404). The watermark renders faded behind every page, the logo at
        the top-right of page 1, signature and stamp in a reserved footer band
        on the final page. Assets in unsupported formats are skipped rather
        than invented.
    """
    party_lines = party_lines or []
    table_headers = table_headers or []
    table_rows = table_rows or []
    col_widths = col_widths or []
    totals_lines = totals_lines or []
    supplier_lines = supplier_lines or []

    assets = _collect_branding_assets(branding)
    watermark = _place_asset(assets, "watermark", 495, 700)
    if watermark:
        wm_w = watermark[2]
        wm_h = watermark[3]
        wm_x = (595 - wm_w) / 2
        wm_y = (842 - wm_h) / 2 - 10
    logo = _place_asset(assets, "logo", 180, 60)
    if logo:
        logo_x = 595 - 50 - logo[2]
        logo_y = 800 - logo[3]
    signature = _place_asset(assets, "signature", 170, 70)
    stamp = _place_asset(assets, "stamp", 170, 90)

    # Layout: everything is placed at absolute positions measured with the
    # real Helvetica widths. The old writer padded columns with spaces in a
    # proportional font, so tables never lined up and long text ran off the
    # page. Each "Key: Value" pair stays one text run.
    PAGE_W, PAGE_H = 595, 842
    LEFT, RIGHT = 40, 555
    WIDTH = RIGHT - LEFT
    TOP = 802
    BOTTOM = 175 if (signature or stamp) else 60

    pages = []          # list of op lists
    state = {"ops": None, "y": TOP}

    def new_page():
        ops = []
        if watermark:
            ops += _image_draw_ops(watermark[0], watermark[1], wm_x, wm_y, wm_w, wm_h, faded=True)
        pages.append(ops)
        state["ops"] = ops
        state["y"] = TOP

    def text(x, y, value, font="F1", size=9, gray=0.0, align="left"):
        value = str(value)
        if align == "right":
            x = x - _text_width(value, font, size)
        elif align == "center":
            x = x - _text_width(value, font, size) / 2
        state["ops"].append(
            (f"BT /{font} {size} Tf {gray:.2f} g 1 0 0 1 {x:.2f} {y:.2f} Tm (".encode("latin1", "replace")
             + _esc(value).encode("latin1", "replace") + b") Tj ET")
        )

    def hline(y, x1=LEFT, x2=RIGHT, gray=0.75, width=0.6):
        state["ops"].append(f"{gray:.2f} G {width} w {x1:.2f} {y:.2f} m {x2:.2f} {y:.2f} l S".encode("ascii"))

    def rect(x, y, w, h, fill_gray=None, stroke_gray=None):
        if fill_gray is not None:
            state["ops"].append(f"{fill_gray:.2f} g {x:.2f} {y:.2f} {w:.2f} {h:.2f} re f".encode("ascii"))
        if stroke_gray is not None:
            state["ops"].append(f"{stroke_gray:.2f} G 0.6 w {x:.2f} {y:.2f} {w:.2f} {h:.2f} re S".encode("ascii"))

    def need(h):
        """Start a new page when h points do not fit above the bottom band."""
        if state["y"] - h < BOTTOM:
            new_page()
            return True
        return False

    new_page()

    # ── Masthead ──
    y = TOP
    if company_name:
        text(LEFT, y, company_name, "F2", 14)
        y -= 15
    for line in supplier_lines:
        for part in _wrap_width(line, "F1", 8.5, WIDTH - (logo[2] + 10 if logo else 0)):
            text(LEFT, y, part, "F1", 8.5, gray=0.3)
            y -= 11
    if custom_banner:
        for part in _wrap_width(" ".join(custom_banner.split())[:300], "F1", 8.5, WIDTH):
            text(LEFT, y, part, "F1", 8.5, gray=0.3)
            y -= 11
    if logo:
        y = min(y, logo_y - 4)
    y -= 6
    hline(y, gray=0.2, width=1.2)
    y -= 24
    text(LEFT, y, title, "F2", 17)
    y -= 22

    # ── Party and document details, in two columns ──
    LEFT_KEYS = ("party", "project", "recipient", "place of supply", "vendor", "client", "supplier", "bill to", "ship to")
    left_lines = [ln for ln in party_lines if ln.split(":")[0].strip().lower().startswith(LEFT_KEYS)]
    right_lines = [ln for ln in party_lines if ln not in left_lines]
    if not left_lines:
        left_lines, right_lines = right_lines, []
    col_w = WIDTH / 2 - 10
    ly = ry = y
    for ln in left_lines:
        for i, part in enumerate(_wrap_width(ln, "F1", 9.5, col_w)):
            text(LEFT + (10 if i else 0), ly, part, "F1", 9.5)
            ly -= 13
    for ln in right_lines:
        for i, part in enumerate(_wrap_width(ln, "F1", 9.5, col_w)):
            text(LEFT + WIDTH / 2 + 10 + (10 if i else 0), ry, part, "F1", 9.5)
            ry -= 13
    y = min(ly, ry) - 8
    state["y"] = y

    # ── Headed sections (client progress report) ──
    for heading, lines in (sections or []):
        need(40)
        state["y"] -= 6
        text(LEFT, state["y"], heading, "F2", 11)
        state["y"] -= 5
        hline(state["y"], gray=0.8, width=0.5)
        state["y"] -= 14
        for ln in lines:
            for i, part in enumerate(_wrap_width(ln, "F1", 9.5, WIDTH)):
                need(13)
                text(LEFT + (10 if i else 0), state["y"], part, "F1", 9.5)
                state["y"] -= 13
        state["y"] -= 6

    # ── Line items ──
    if table_headers and col_widths:
        total_units = float(sum(col_widths)) or 1.0
        widths = [WIDTH * w / total_units for w in col_widths]
        xs = [LEFT]
        for w in widths[:-1]:
            xs.append(xs[-1] + w)
        kinds = [_column_kind(h) for h in table_headers]
        PAD = 4
        HEAD_H = 18
        LINE_H = 11

        def draw_header():
            yy = state["y"]
            rect(LEFT, yy - HEAD_H, WIDTH, HEAD_H, fill_gray=0.90)
            for i, h in enumerate(table_headers):
                if kinds[i] == "text":
                    text(xs[i] + PAD, yy - 12.5, h, "F2", 8.5)
                else:
                    text(xs[i] + widths[i] - PAD, yy - 12.5, h, "F2", 8.5, align="right")
            hline(yy, gray=0.6)
            hline(yy - HEAD_H, gray=0.6)
            state["y"] = yy - HEAD_H

        draw_header()
        for row in table_rows:
            cells = []
            for i, cell in enumerate(row):
                shown = _format_cell(cell, kinds[i] if i < len(kinds) else "text")
                if i < len(kinds) and kinds[i] == "text":
                    cells.append(_wrap_width(shown, "F1", 8.5, widths[i] - 2 * PAD) or [""])
                else:
                    cells.append([shown])
            row_h = max(len(c) for c in cells) * LINE_H + 6
            if need(row_h):
                draw_header()
            yy = state["y"]
            for i, lines in enumerate(cells):
                if i >= len(xs):
                    break
                for j, part in enumerate(lines):
                    ty = yy - 10.5 - j * LINE_H
                    if kinds[i] == "text":
                        text(xs[i] + PAD, ty, part, "F1", 8.5)
                    else:
                        text(xs[i] + widths[i] - PAD, ty, part, "F1", 8.5, align="right")
            state["y"] = yy - row_h
            hline(state["y"], gray=0.85, width=0.4)
        state["y"] -= 12

    # ── Totals ──
    sign_lines = []
    if totals_lines:
        figures, notes = [], []
        for ln in totals_lines:
            key, sep, val = ln.partition(": ")
            if not sep:
                sign_lines.append(ln)
            elif _is_number(val) and not _is_count_label(key):
                figures.append((key, _indian(float(val.replace(",", "")), 2)))
            elif _is_number(val):
                figures.append((key, val.strip()))
            else:
                notes.append(ln)
        if figures:
            need(len(figures) * 15 + 10)
            yy = state["y"]
            box_w = 250
            rect(RIGHT - box_w, yy - len(figures) * 15 - 6, box_w, len(figures) * 15 + 6, stroke_gray=0.75)
            yy -= 14
            for key, val in figures:
                strong = key.lower().startswith(("total", "grand total", "net", "boq value", "amount payable"))
                text(RIGHT - 8, yy, f"{key}: {val}", "F2" if strong else "F1", 9.5, align="right")
                yy -= 15
            state["y"] = yy - 8
        for ln in notes:
            parts = _wrap_width(ln, "F1", 9, WIDTH)
            need(len(parts) * 12 + 4)
            for part in parts:
                text(LEFT, state["y"], part, "F1", 9)
                state["y"] -= 12
            state["y"] -= 2
        state["y"] -= 6

    # ── Terms ──
    if terms and terms.strip():
        need(30)
        text(LEFT, state["y"], "Terms & Conditions", "F2", 10)
        state["y"] -= 14
        for para in str(terms).split("\n"):
            for part in _wrap_width(para, "F1", 8.5, WIDTH) or [""]:
                need(11)
                text(LEFT, state["y"], part, "F1", 8.5, gray=0.2)
                state["y"] -= 11

    # ── Signature block, after the terms as on a printed invoice ──
    if sign_lines:
        need(len(sign_lines) * 14 + 40)
        state["y"] -= 34
        for ln in sign_lines:
            text(RIGHT, state["y"], ln, "F2" if ln.lower().startswith("for ") else "F1", 9.5, align="right")
            state["y"] -= 14

    # ── Footer on every page, branding on first and last ──
    generated = _ist_now().strftime("%d %b %Y, %I:%M %p IST")
    total_pages = len(pages)
    for p_index, ops in enumerate(pages):
        state["ops"] = ops
        hline(42, gray=0.8, width=0.4)
        text(LEFT, 30, f"Generated {generated}", "F1", 7.5, gray=0.45)
        text(RIGHT, 30, f"Page {p_index + 1} of {total_pages}", "F1", 7.5, gray=0.45, align="right")
        if p_index == 0 and logo:
            ops += _image_draw_ops(logo[0], logo[1], logo_x, logo_y, logo[2], logo[3])
        if p_index == total_pages - 1:
            for placed in (signature, stamp):
                if not placed:
                    continue
                name, spec, w, h = placed
                x = RIGHT - w if placed is stamp else LEFT + 20
                ops += _image_draw_ops(name, spec, x, 58, w, h)

    pdf = bytearray(b"%PDF-1.4\n")
    objects = []

    def add_object(obj_def: bytes, stream_data: bytes = None) -> int:
        obj_id = len(objects) + 1
        body = f"{obj_id} 0 obj\n".encode("ascii") + obj_def
        if stream_data is not None:
            body += f"<< /Length {len(stream_data)} >>\nstream\n".encode("ascii")
            body += stream_data
            body += b"\nendstream\n"
        objects.append(body + b"endobj\n")
        return obj_id

    content_ids = []
    for ops in pages:
        stream_data = b"\n".join(ops)
        cid = add_object(
            f"<< /Length {len(stream_data)} >>\nstream\n".encode("ascii")
            + stream_data
            + b"\nendstream\n"
        )
        content_ids.append(cid)

    # Fonts.
    f1 = add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n")
    f2 = add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\n")

    image_ids = {}
    for placed in (watermark, logo, signature, stamp):
        if not placed:
            continue
        name, spec, _w, _h = placed
        image_ids[name] = _add_image_object(add_object, spec)

    resources_extra = b""
    if image_ids:
        ext_gstate_id = add_object(b"<< /Type /ExtGState /ca 0.12 /CA 0.12 >>\n")
        xobj_entries = "".join(f"/{n.upper()} {oid} 0 R " for n, oid in image_ids.items())
        resources_extra = (
            b" /XObject << " + xobj_entries.encode("ascii").strip() + b" >>"
            + f" /ExtGState << /GS1 {ext_gstate_id} 0 R >>".encode("ascii")
        )

    # Page objects + Pages tree. The tree is the object right after the last
    # page; Catalog and every Page must point at it. A hard-coded "2 0 R" hit
    # the Helvetica font object, so viewers found no pages: every bill, PO and
    # BOQ download opened blank.
    page_ids = []
    pages_tree_id = len(objects) + len(content_ids) + 1
    for cid in content_ids:
        pid = add_object(
            b"<< /Type /Page\n"
            + f"   /Parent {pages_tree_id} 0 R\n".encode("ascii")
            + b"   /Resources << /Font << /F1 "
            + str(f1).encode()
            + b" 0 R /F2 "
            + str(f2).encode()
            + b" 0 R >> >>"
            + resources_extra +
            b"\n"
            b"   /MediaBox [0 0 595 842]\n"
            b"   /Contents "
            + str(cid).encode()
            + b" 0 R\n"
            b">>\n"
        )
        page_ids.append(pid)

    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    pages_tree = add_object(f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>\n".encode("ascii"))
    assert pages_tree == pages_tree_id
    catalog = add_object(f"<< /Type /Catalog /Pages {pages_tree} 0 R >>\n".encode("ascii"))

    # Assemble byte offsets.
    current_offset = len(pdf)
    offsets = {}
    for i, obj in enumerate(objects):
        obj_id = i + 1
        offsets[obj_id] = current_offset
        pdf.extend(obj)
        current_offset += len(obj)

    xref_start = len(pdf)
    pdf.extend(b"xref\n")
    pdf.extend(f"0 {len(objects) + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for obj_id in range(1, len(objects) + 1):
        pdf.extend(f"{offsets[obj_id]:010d} 00000 n \n".encode("ascii"))

    pdf.extend(b"trailer\n")
    pdf.extend(f"<< /Size {len(objects) + 1} /Root {catalog} 0 R >>\n".encode("ascii"))
    pdf.extend(b"startxref\n")
    pdf.extend(f"{xref_start}\n".encode("ascii"))
    pdf.extend(b"%%EOF\n")

    return bytes(pdf)
