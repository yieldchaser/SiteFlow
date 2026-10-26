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
) -> bytes:
    """
    Generates a valid, readable minimal PDF 1.4 byte stream.
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
    pdf = bytearray(b"%PDF-1.4\n")
    objects = []
    offsets = {}

    def add_object(obj_def: bytes, stream_data: bytes = None) -> int:
        obj_id = len(objects) + 1
        obj_header = f"{obj_id} 0 obj\n".encode("ascii")
        obj_body = obj_def
        if stream_data is not None:
            obj_body += f"<< /Length {len(stream_data)} >>\nstream\n".encode("ascii")
            obj_body += stream_data
            obj_body += b"\nendstream\n"
        obj_footer = b"endobj\n"
        objects.append(obj_header + obj_body + obj_footer)
        return obj_id

    # Branding assets actually embeddable (undecodable ones are skipped).
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

    # Content Stream lines
    stream_lines = [b"BT"]
    cursor_placed = False  # True once the first absolute "Td" has been emitted

    # Masthead: company/branch name (Document Company Name Display setting).
    if company_name:
        safe_company = company_name.replace('(', '\\(').replace(')', '\\)')
        stream_lines += [
            b"/F2 11 Tf",  # Masthead Font (Helvetica-Bold 11pt)
            b"50 810 Td",  # absolute anchor: top of page
            f"({safe_company}) Tj".encode("latin1", "replace"),
            b"0 -18 Td",
        ]
        cursor_placed = True

    # R2-607: registered supplier identity lines (legal name / GSTIN / phone /
    # address, resolved by the caller via resolve_supplier_tax_details) print
    # under the masthead, same placement rule as the document generator.
    for line in (supplier_lines or []):
        safe_line = str(line).replace('(', '\\(').replace(')', '\\)')
        stream_lines += [b"/F1 9 Tf"]  # Supplier Font (Helvetica 9pt)
        if not cursor_placed:
            stream_lines += [b"50 810 Td"]  # absolute anchor: top of page
            cursor_placed = True
        stream_lines += [
            f"({safe_line}) Tj".encode("latin1", "replace"),
            b"0 -14 Td",
        ]

    # Custom banner: only present when custom_pdf_template_enabled + a
    # PdfTemplate is configured for the company, giving the "Custom" layout
    # a visibly different look from the "Default" one.
    if custom_banner:
        # Single-line Tj with no text wrapping: collapse whitespace/newlines
        # and cap length so a long template `content` value can't overrun the
        # page margin.
        flat_banner = " ".join(custom_banner.split())[:180]
        safe_banner = flat_banner.replace('(', '\\(').replace(')', '\\)')
        stream_lines += [b"/F1 9 Tf"]  # Banner Font (Helvetica 9pt)
        if not cursor_placed:
            stream_lines += [b"50 810 Td"]  # absolute anchor: top of page
            cursor_placed = True
        stream_lines += [
            f"({safe_banner}) Tj".encode("latin1", "replace"),
            b"0 -18 Td",
        ]

    # Title (default layout: absolute-anchored at 780; custom/masthead layout:
    # continues 12pt below whatever the cursor is at after the lines above).
    stream_lines += [b"/F2 20 Tf"]  # Title Font (Helvetica-Bold 20pt)
    if not cursor_placed:
        stream_lines += [b"50 780 Td"]
    else:
        stream_lines += [b"0 -12 Td"]
    stream_lines += [
        f"({title.replace('(', '\\(').replace(')', '\\)')}) Tj".encode("latin1", "replace"),
        b"0 -30 Td",
        b"/F1 10 Tf",      # Regular Font (Helvetica 10pt)
        f"(Generated on: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}) Tj".encode("latin-1"),
        b"0 -30 Td"
    ]

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
            f"Total Net Certified Amount: {metrics.get('billing_certified_net', '0.00')}"
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

    # Add summary section if provided
    if summary:
        sections.insert(0, ("EXECUTIVE SUMMARY", [summary]))

    # Render sections to content stream
    for heading, lines in sections:
        # Draw heading in bold 12pt
        stream_lines.append(b"/F2 12 Tf")
        safe_heading = heading.replace('(', '\\(').replace(')', '\\)')
        stream_lines.append(f"({safe_heading}) Tj".encode("latin1", "replace"))
        stream_lines.append(b"0 -18 Td")

        # Draw details in regular 10pt
        stream_lines.append(b"/F1 10 Tf")
        for line in lines:
            safe_line = line.replace('(', '\\(').replace(')', '\\)')
            stream_lines.append(f"({safe_line}) Tj".encode("latin1", "replace"))
            stream_lines.append(b"0 -14 Td")
        stream_lines.append(b"0 -12 Td") # Spacing between sections

    stream_lines.append(b"ET")

    # Branding overlays: watermark behind the text, letterhead/seals on top.
    if watermark:
        stream_lines = _image_draw_ops(watermark[0], watermark[1], wm_x, wm_y, wm_w, wm_h, faded=True) + stream_lines
    for placed in (logo, signature, stamp):
        if not placed:
            continue
        name, spec, w, h = placed
        x = logo_x if placed is logo else (595 - 50 - w if placed is stamp else 60)
        y = logo_y if placed is logo else 58
        stream_lines += _image_draw_ops(name, spec, x, y, w, h)

    stream_data = b"\n".join(stream_lines)

    # Contents, fonts, images: ids are resolved dynamically so adding branding
    # assets cannot desynchronise the hard-coded references.
    contents_id = add_object(b"", stream_data)
    f1 = add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n")
    f2 = add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\n")

    image_ids = {}
    for placed in (watermark, logo, signature, stamp):
        if not placed:
            continue
        name, spec, _w, _h = placed
        image_ids[name] = _add_image_object(add_object, spec)

    resources = f"     /Font << /F1 {f1} 0 R /F2 {f2} 0 R >>\n".encode("ascii")
    if image_ids:
        ext_gstate_id = add_object(b"<< /Type /ExtGState /ca 0.12 /CA 0.12 >>\n")
        xobj_entries = "".join(f"/{n.upper()} {oid} 0 R " for n, oid in image_ids.items())
        resources += (
            b"     /XObject << " + xobj_entries.encode("ascii").strip() + b" >>\n"
            + f"     /ExtGState << /GS1 {ext_gstate_id} 0 R >>\n".encode("ascii")
        )

    # The Pages tree is the object right after the page. The trailer must name
    # the Catalog: it used to name object 1 (the content stream), so viewers
    # found no document and showed a blank file.
    page_id = add_object(
        b"<< /Type /Page\n"
        + f"   /Parent {len(objects) + 2} 0 R\n".encode("ascii")
        + b"   /Resources <<\n"
        + resources
        + b"   >>\n"
        + b"   /MediaBox [0 0 595 842]\n"
        + f"   /Contents {contents_id} 0 R\n".encode("ascii")
        + b">>\n"
    )
    pages_tree_id = add_object(f"<< /Type /Pages /Kids [{page_id} 0 R] /Count 1 >>\n".encode("ascii"))
    catalog_id = add_object(f"<< /Type /Catalog /Pages {pages_tree_id} 0 R >>\n".encode("ascii"))

    # Assemble byteoffsets
    current_offset = len(pdf)
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
        offset = offsets[obj_id]
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))

    pdf.extend(b"trailer\n")
    pdf.extend(f"<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n".encode("ascii"))
    pdf.extend(b"startxref\n")
    pdf.extend(f"{xref_start}\n".encode("ascii"))
    pdf.extend(b"%%EOF\n")

    return bytes(pdf)


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
) -> bytes:
    """
    Pure-Python PDF for a line-item business document (Invoice / PO / BOQ).

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

    # Build a flat list of (font_key, font_size, text, dy_after) segments.
    # F2 = Helvetica-Bold, F1 = Helvetica (match the report generator).
    segs = []

    def add(font_key, size, text, dy):
        segs.append((font_key, size, text, dy))

    if company_name:
        add("F2", 11, company_name, 18)
    for line in supplier_lines:
        add("F1", 9, line, 12)
    if custom_banner:
        flat = " ".join(custom_banner.split())[:180]
        add("F1", 9, flat, 18)

    add("F2", 20, title, 30)
    add("F1", 10, f"Generated on: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}", 30)

    for line in party_lines:
        add("F1", 10, line, 14)
    if party_lines:
        add("F1", 10, "", 8)  # spacer

    if table_headers and col_widths:
        add("F2", 12, _fmt_row(table_headers, col_widths), 16)
        for row in table_rows:
            add("F1", 9, _fmt_row(row, col_widths), 12)
        add("F1", 9, "", 10)  # spacer

    if totals_lines:
        add("F2", 12, "SUMMARY / TOTALS", 16)
        for line in totals_lines:
            add("F1", 10, line, 14)
        add("F1", 10, "", 10)  # spacer

    if terms and terms.strip():
        add("F2", 12, "TERMS & CONDITIONS", 16)
        for line in _wrap_text(terms, 100):
            add("F1", 9, line, 12)

    # Paginate: page usable band y in (BOTTOM, TOP]. Top anchor at TOP.
    # R2-404: when a signature/stamp is present the footer band is reserved so
    # document text never runs underneath the seals.
    TOP = 800
    BOTTOM = 175 if (signature or stamp) else 50
    pages = []
    cur_y = TOP
    page_segs = []
    for font_key, size, text, dy in segs:
        if cur_y - dy < BOTTOM and page_segs:
            pages.append(page_segs)
            page_segs = []
            cur_y = TOP
        page_segs.append((font_key, size, text, dy))
        cur_y -= dy
    if page_segs:
        pages.append(page_segs)

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

    # Content streams (one per page).
    content_ids = []
    last_page_index = len(pages) - 1
    for p_index, p_segs in enumerate(pages):
        stream_lines = []
        if watermark:
            stream_lines += _image_draw_ops(
                watermark[0], watermark[1], wm_x, wm_y, wm_w, wm_h, faded=True
            )
        stream_lines.append(b"BT")
        first = True
        for font_key, size, text, dy in p_segs:
            if first:
                stream_lines.append(b"50 800 Td")
                first = False
            else:
                stream_lines.append(f"0 -{dy} Td".encode("ascii"))
            stream_lines.append(f"/{font_key} {size} Tf".encode("ascii"))
            stream_lines.append(f"({_esc(text)}) Tj".encode("latin1", "replace"))
        stream_lines.append(b"ET")
        if p_index == 0 and logo:
            stream_lines += _image_draw_ops(logo[0], logo[1], logo_x, logo_y, logo[2], logo[3])
        if p_index == last_page_index:
            for placed in (signature, stamp):
                if not placed:
                    continue
                name, spec, w, h = placed
                x = 595 - 50 - w if placed is stamp else 60
                stream_lines += _image_draw_ops(name, spec, x, 58, w, h)
        stream_data = b"\n".join(stream_lines)
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
