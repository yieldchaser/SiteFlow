"""Prompt 7 / D1 + D2 + D5 backend tests: BOCW create, cost_code import."""
import datetime
import io
import uuid

from openpyxl import Workbook

from app import models


def _project(db, company):
    p = models.Project(
        id=uuid.uuid4(), company_id=company.id, name="P7Proj",
        code=uuid.uuid4().hex[:6], status="Ongoing",
    )
    db.add(p)
    db.commit()
    return p


def _subcontractor(db, company):
    user = models.User(id=uuid.uuid4(), name="Subby", mobile="+919888760001")
    db.add(user)
    db.flush()
    team = models.CompanyTeam(
        id=uuid.uuid4(), company_id=company.id, user_id=user.id,
        priority_type="subcontractor",
    )
    db.add(team)
    db.commit()
    return team


def test_create_bocw_appears_in_list(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="A", user_name="UB", mobile="+919888770002")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)

    r = client.post(
        "/apis/v3/labour/bocw",
        json={
            "company_id": str(comp.id),
            "project_id": str(proj.id),
            "contractor_name": "M/s Demo Contractor",
            "month_year": "2026-07",
            "workers_count": 25,
            "wages_paid": 500000.0,
            "contribution_amount": 5000.0,
            "acknowledgement_number": "BOCW-001",
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    assert r.json()["contractor_name"] == "M/s Demo Contractor"

    lst = client.get(f"/apis/v3/labour/bocw/{proj.id}", headers=hdr)
    assert lst.status_code == 200
    assert any(rec["acknowledgement_number"] == "BOCW-001" for rec in lst.json())


def test_import_boq_preserves_cost_code(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="A", user_name="UC", mobile="+919888780001")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)

    # R2-334: imported cost codes must already exist in the Cost Code Library.
    db.add_all([
        models.LibraryCostCode(id=uuid.uuid4(), company_id=comp.id, code="1.1", name="Earthwork"),
        models.LibraryCostCode(id=uuid.uuid4(), company_id=comp.id, code="1.2", name="PCC"),
    ])
    db.commit()

    wb = Workbook()
    ws = wb.active
    ws.append(["item_name", "unit", "qty", "rate", "cost_code"])
    ws.append(["Earthwork", "Cum", 100, 250, "1.1"])
    ws.append(["PCC", "Cum", 50, 4500, "1.2"])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    r = client.post(
        "/apis/v3/budgeting/boq/import",
        data={"project_id": str(proj.id)},
        files={"file": ("boq.xlsx", buf.read(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        headers=hdr,
    )
    assert r.status_code == 201, r.text

    items = client.get(f"/apis/v3/budgeting/boq?project_id={proj.id}", headers=hdr)
    assert items.status_code == 200
    codes = {row["item_name"]: (row.get("cost_code") or "") for row in items.json()}
    assert codes.get("Earthwork") == "1.1"
    assert codes.get("PCC") == "1.2"
