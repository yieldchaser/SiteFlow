"""Exports are opened in Excel by accounts and site staff. They carried
Python float text ("85000.0", "1.7999999999999998 MT"), no byte-order mark
(Excel on Windows then misreads rupee signs and non-English names) and raw
UUIDs as filenames. Amounts now have two decimals, quantities no float
noise, files start with a BOM and are named after the project.
"""
import datetime
import uuid

from app import models

_TAG = uuid.uuid4().hex[:8]


def test_bocw_and_dpr_exports_are_clean(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"CSV-{_TAG}", user_name=f"CSV-{_TAG}",
                                mobile="+917" + str(int(_TAG, 16))[-8:])
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Shivalik Heights",
                             code=f"SH-{_TAG}", status="Ongoing")
    db.add(project)
    db.add(models.DailyProgressReport(
        id=uuid.uuid4(), project_id=project.id,
        dpr_date=datetime.datetime(2026, 10, 24), reported_by=user.name,
        executed_qty=44.0, workers_deployed=68, notes="L7 slab", status="submitted",
        materials_consumed=[{"material_name": "TMT Bar", "quantity": 1.7999999999999998, "unit": "MT"}]))
    db.commit()
    r = client.post("/apis/v3/labour/bocw", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "contractor_name": "Ganesh Constructions", "month_year": "2026-09",
        "workers_count": 64, "wages_paid": 2010000.0, "contribution_amount": 20100.0})
    assert r.status_code == 201, r.text

    r = client.get(f"/apis/v3/labour/bocw/{project.id}/export", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"\xef\xbb\xbf"), r.content[:10]
    assert f"SH-{_TAG}" in r.headers["content-disposition"], r.headers
    assert str(project.id) not in r.headers["content-disposition"]
    body = r.content.decode("utf-8-sig")
    assert "2010000.00,20100.00" in body, body
    assert ".0," not in body.replace("0.00,", ""), body

    r = client.get(f"/apis/v3/dpr/export?project_id={project.id}", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.content.decode("utf-8-sig")
    assert "TMT Bar 1.8 MT" in body, body
    assert "1.79999" not in body, body
    assert ",44," in body and ",Submitted" in body, body
