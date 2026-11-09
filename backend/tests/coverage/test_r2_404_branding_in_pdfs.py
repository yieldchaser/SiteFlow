"""R2-404 — uploaded Logo/Signature/Stamp/Watermark are rendered on generated documents.

Gate: the branding assets stored via POST /settings/company-file must be
consumed by the document generators instead of sitting write-only. A bill PDF
for a company with uploads carries embedded images; unsupported/garbage bytes
are skipped rather than invented; a company with no uploads is byte-identical
in structure to before.
"""
import base64
import re
import struct
import uuid
import zlib

import datetime

from app import models


def _png(w=3, h=2):
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    raw = (b"\x00" + bytes(w * 3)) * h
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


# A valid 2x2 white baseline JPEG (generated once with PIL; kept as a constant
# so the suite needs no imaging dependency).
_JPEG_B64 = "".join([
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a",
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy",
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIA",
    "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA",
    "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3",
    "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm",
    "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA",
    "AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx",
    "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK",
    "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3",
    "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iii",
    "gD//2Q==",
])


def _jpeg():
    return base64.b64decode(_JPEG_B64)


def _validate_pdf(pdf: bytes):
    assert pdf.startswith(b"%PDF-1.4")
    m = re.search(rb"startxref\s+(\d+)\s+%%EOF$", pdf)
    assert m, "missing startxref/%%EOF trailer"
    assert pdf[int(m.group(1)):int(m.group(1)) + 4] == b"xref"


def test_document_pdf_embeds_all_four_assets():
    from app.utils.pdf_generator import generate_document_pdf

    branding = {
        "logo": {"data": _jpeg(), "content_type": "image/jpeg"},
        "watermark": {"data": _png(), "content_type": "image/png"},
        "signature": {"data": _png(), "content_type": "image/png"},
        "stamp": {"data": _jpeg(), "content_type": "image/jpeg"},
    }
    pdf = generate_document_pdf(
        title="Sales Invoice", party_lines=["Party: X"], company_name="C", branding=branding
    )
    _validate_pdf(pdf)
    assert b"/Subtype /Image" in pdf
    assert b"/Filter /DCTDecode" in pdf          # JPEG passthrough
    assert b"/WATERMARK Do" in pdf               # faded background op present
    assert b"/GS1 gs" in pdf                     # ExtGState alpha for watermark
    assert b"/SIGNATURE Do" in pdf and b"/STAMP Do" in pdf


def test_document_pdf_without_branding_has_no_images():
    from app.utils.pdf_generator import generate_document_pdf

    pdf = generate_document_pdf(title="Purchase Order", party_lines=["Vendor: Y"], company_name="C")
    _validate_pdf(pdf)
    assert b"/Subtype /Image" not in pdf


def test_undecodable_assets_are_skipped_not_invented():
    from app.utils.pdf_generator import generate_document_pdf

    pdf = generate_document_pdf(
        title="T",
        company_name="C",
        branding={"logo": {"data": b"definitely-not-an-image", "content_type": "image/png"}},
    )
    _validate_pdf(pdf)
    assert b"/Subtype /Image" not in pdf


def test_multipage_watermarks_every_page_but_signs_once():
    from app.utils.pdf_generator import generate_document_pdf

    pdf = generate_document_pdf(
        title="BOQ",
        table_headers=["h"],
        table_rows=[["r"]] * 120,
        col_widths=[20],
        company_name="C",
        branding={
            "watermark": {"data": _png(), "content_type": "image/png"},
            "signature": {"data": _png(), "content_type": "image/png"},
            "stamp": {"data": _png(), "content_type": "image/png"},
        },
    )
    _validate_pdf(pdf)
    pages = pdf.count(b"/MediaBox")  # one per page object
    assert pages >= 2, "expected pagination for this row count"
    assert pdf.count(b"/WATERMARK Do") == pages   # every page
    assert pdf.count(b"/SIGNATURE Do") == 1       # last page only
    assert pdf.count(b"/STAMP Do") == 1


def _mk_project(db, comp):
    p = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="P", code=f"PRJ-{uuid.uuid4().hex[:8]}", status="Ongoing"
    )
    db.add(p)
    db.commit()
    return p


def test_bill_pdf_endpoint_renders_uploaded_branding(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="R404", user_name="U404")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    # Upload a real logo and signature through the settings endpoints.
    for asset_type, payload in (("logo", _jpeg()), ("signature", _png())):
        r = client.post(
            f"/apis/v3/settings/company-file/{comp.id}",
            params={"asset_type": asset_type},
            headers=hdr,
            files={"file": (f"{asset_type}.bin", payload)},
        )
        assert r.status_code == 200, r.text

    bill = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=team.id, invoice_number=f"INV-R404-{uuid.uuid4().hex[:6]}",
        invoice_date=datetime.datetime(2026, 2, 1), invoice_type="purchase",
        subtotal=5000.0, total_payable=5000.0,
    )
    db.add(bill)
    db.commit()

    r = client.get(f"/apis/v3/billing/bills/{bill.id}/pdf", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    body = r.content
    _validate_pdf(body)
    assert b"/Subtype /Image" in body
