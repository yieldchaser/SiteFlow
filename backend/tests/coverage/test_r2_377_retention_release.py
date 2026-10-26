"""R2-377 - retention withheld from bills is now a managed liability.

Before: every subcon bill's Retention deduction left the payable but nothing
recorded the obligation - no due date, no release path, no released amount,
and both report surfaces hardcoded empty columns ("Retention Amount" in
company-sales, "Due Date" in sales-deduction-retention). The company could
not enumerate what it owed its subcontractors.

Gate: POST /billing/bills/{bill_id}/deductions/{deduction_id}/release stamps
released_at/released_amount on the Retention deduction (full or partial),
refuses non-Retention deductions (400), unreviewed bills (409, mirroring the
R2-346 settlement gate), cancelled bills (409), double release (409) and
over-release (422); bill creation persists release_due_date; the two report
columns carry real values.
"""
import datetime
import json
import uuid

import pytest

from app import models

_SUFFIX = uuid.uuid4().hex[:8]
_DUE = datetime.datetime(2026, 12, 1)


def _mk_project(db, comp):
    p = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name=f"P377-{_SUFFIX}", code=f"PRJ-377-{_SUFFIX}", status="Ongoing", state="Karnataka",
    )
    db.add(p)
    db.commit()
    return p


def _create_wo(client, hdr, comp, project, team):
    r = client.post(
        "/apis/v3/billing/work-orders",
        headers=hdr,
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "subcontractor_id": str(team.id),
            "wo_number": f"WO-377-{_SUFFIX}-{uuid.uuid4().hex[:6]}",
            "wo_date": datetime.datetime(2026, 8, 1).isoformat(),
            "items": [{"quantity": 10000, "rate": 100}],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _create_bill(client, hdr, comp, project, team, invoice_number, subtotal=100000.0, extra_deductions=None):
    deductions = [
        {
            "deduction_type": "Retention",
            "amount": 0.0,
            "percentage": 10.0,
            "notes": "RA retention",
            "release_due_date": _DUE.isoformat(),
        },
        {"deduction_type": "TDS", "amount": 0.0, "percentage": 10.0},
    ]
    if extra_deductions:
        deductions.extend(extra_deductions)
    r = client.post(
        "/apis/v3/billing/bills",
        headers=hdr,
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "party_company_user_id": str(team.id),
            "invoice_number": invoice_number,
            "invoice_date": datetime.datetime.now().isoformat(),
            "invoice_type": "subcon",
            "subtotal": subtotal,
            "gst_pct": 18.0,
            "deductions": deductions,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _approve(db, bill_id):
    b = db.query(models.Bill).filter(models.Bill.id == bill_id).first()
    b.approval_flag = "approved"
    db.add(b)
    db.commit()


def _ded_by_type(bill_json, ded_type):
    return next(d for d in bill_json["deductions"] if d["deduction_type"] == ded_type)


def test_retention_release_full_lifecycle(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"R377a-{_SUFFIX}", user_name="U377a")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    _create_wo(client, hdr, comp, project, team)

    bill = _create_bill(client, hdr, comp, project, team, f"INV-377a-{_SUFFIX}")
    ret = _ded_by_type(bill, "Retention")
    assert float(ret["amount"]) == pytest.approx(10000.0)
    # Creation persists the stated release due date; nothing released yet.
    assert ret["release_due_date"].startswith(_DUE.isoformat()[:19])
    assert ret["released_at"] is None
    assert ret["released_amount"] is None

    _approve(db, bill["id"])
    r = client.post(
        f"/apis/v3/billing/bills/{bill['id']}/deductions/{ret['id']}/release", headers=hdr
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert float(body["released_amount"]) == pytest.approx(10000.0)
    assert body["released_at"] is not None

    listing = client.get(f"/apis/v3/billing/bills?project_id={project.id}", headers=hdr)
    assert listing.status_code == 200, listing.text
    listed = next(b for b in listing.json() if b["id"] == bill["id"])
    listed_ret = _ded_by_type(listed, "Retention")
    assert float(listed_ret["released_amount"]) == pytest.approx(10000.0)
    assert listed_ret["released_at"] is not None

    again = client.post(
        f"/apis/v3/billing/bills/{bill['id']}/deductions/{ret['id']}/release", headers=hdr
    )
    assert again.status_code == 409, again.text


def test_release_partial_then_over_then_rest(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"R377b-{_SUFFIX}", user_name="U377b")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    _create_wo(client, hdr, comp, project, team)

    bill = _create_bill(client, hdr, comp, project, team, f"INV-377b-{_SUFFIX}")
    ret = _ded_by_type(bill, "Retention")
    _approve(db, bill["id"])

    half = client.post(
        f"/apis/v3/billing/bills/{bill['id']}/deductions/{ret['id']}/release",
        headers=hdr,
        json={"released_amount": 4000.0},
    )
    assert half.status_code == 200, half.text
    assert float(half.json()["released_amount"]) == pytest.approx(4000.0)

    over = client.post(
        f"/apis/v3/billing/bills/{bill['id']}/deductions/{ret['id']}/release",
        headers=hdr,
        json={"released_amount": 999999.0},
    )
    assert over.status_code == 422, over.text

    rest = client.post(
        f"/apis/v3/billing/bills/{bill['id']}/deductions/{ret['id']}/release", headers=hdr
    )
    assert rest.status_code == 200, rest.text
    assert float(rest.json()["released_amount"]) == pytest.approx(10000.0)


def test_release_gates_review_retention_type_and_pairing(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"R377c-{_SUFFIX}", user_name="U377c")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    _create_wo(client, hdr, comp, project, team)

    pending = _create_bill(client, hdr, comp, project, team, f"INV-377c-{_SUFFIX}")
    approved = _create_bill(client, hdr, comp, project, team, f"INV-377c2-{_SUFFIX}")
    _approve(db, approved["id"])

    # Unreviewed bill: money must not leave before review (R2-346 principle).
    pending_ret = _ded_by_type(pending, "Retention")
    r = client.post(
        f"/apis/v3/billing/bills/{pending['id']}/deductions/{pending_ret['id']}/release",
        headers=hdr,
    )
    assert r.status_code == 409, r.text

    # TDS is remitted to the authority, never released back.
    tds = _ded_by_type(approved, "TDS")
    r = client.post(
        f"/apis/v3/billing/bills/{approved['id']}/deductions/{tds['id']}/release", headers=hdr
    )
    assert r.status_code == 400, r.text

    # A deduction id from another bill does not resolve on this one.
    r = client.post(
        f"/apis/v3/billing/bills/{approved['id']}/deductions/{pending_ret['id']}/release",
        headers=hdr,
    )
    assert r.status_code == 404, r.text


def test_reports_surface_retention_and_due_date(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"R377d-{_SUFFIX}", user_name="U377d")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    _create_wo(client, hdr, comp, project, team)

    subcon = _create_bill(client, hdr, comp, project, team, f"INV-377d-{_SUFFIX}")

    # company-sales covers revenue invoices only; give it a sale bill that
    # withholds a fixed-amount retention so its column has something to show.
    sale = client.post(
        "/apis/v3/billing/bills",
        headers=hdr,
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "party_company_user_id": str(team.id),
            "invoice_number": f"INV-377d-sale-{_SUFFIX}",
            "invoice_date": datetime.datetime.now().isoformat(),
            "invoice_type": "sale",
            "subtotal": 50000.0,
            "gst_pct": 18.0,
            # R2-401: tax invoices must carry line items reconciling to the subtotal.
            "items_json": json.dumps([
                {"desc": "Fitout work supplied", "qty": 1, "rate": 50000.0, "amount": 50000.0, "hsn_sac": "9954"}
            ]),
            "deductions": [
                {
                    "deduction_type": "Retention",
                    "amount": 2500.0,
                    "percentage": None,
                    "release_due_date": _DUE.isoformat(),
                }
            ],
        },
    )
    assert sale.status_code == 201, sale.text

    sales_rep = client.get(
        f"/apis/v3/reports/data/company-sales?company_id={comp.id}&project_id={project.id}",
        headers=hdr,
    )
    assert sales_rep.status_code == 200, sales_rep.text
    sale_row = next(
        row for row in sales_rep.json()["rows"] if row["Invoice Number"] == f"INV-377d-sale-{_SUFFIX}"
    )
    assert float(sale_row["Retention Amount"]) == pytest.approx(2500.0)

    ded_rep = client.get(
        f"/apis/v3/reports/data/subcon-deduction-retention?company_id={comp.id}&project_id={project.id}",
        headers=hdr,
    )
    assert ded_rep.status_code == 200, ded_rep.text
    rows = ded_rep.json()["rows"]
    subcon_row = next(
        row for row in rows if row["Invoice Number"] == f"INV-377d-{_SUFFIX}" and row["Type"] == "Retention"
    )
    assert subcon_row["Due Date"].startswith("2026-12-01T00:00")
    assert float(subcon_row["Amount"]) == pytest.approx(10000.0)
