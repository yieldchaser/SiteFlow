"""Face Recognition read a table nothing in the product wrote (no camera, no
face matching, no caller of POST /face/punch), so it was always empty, and that
endpoint stored any client's "face verified" claim as evidence. The screen now
lists the punches a face terminal sent through /iclock, checked by face."""
import uuid

from app import models


def _setup(client, db, make_tenant, auth_headers, tag):
    comp, user, _ = make_tenant(company_name=f"{tag}-{uuid.uuid4().hex[:6]}", user_name=tag)
    hdr = auth_headers(user, comp)
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Shivalik", code=f"P-{uuid.uuid4().hex[:6]}", status="Ongoing")
    db.add(p)
    db.flush()
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=p.id, name="Ramesh Patil", employee_code="E-7",
        status="active", basic_salary=1000.0, hra=0.0, other_allowances=0.0,
        pf_employee_pct=0.0, pf_employer_pct=0.0, esi_employee_pct=0.0,
        esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False, biometric_pin="7",
    )
    db.add(emp)
    db.commit()
    sn = f"SN{uuid.uuid4().hex[:10]}"
    r = client.post("/apis/v3/biometric/devices", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(p.id), "serial_number": sn, "name": "Gate terminal"})
    assert r.status_code == 201, r.text
    return comp, hdr, sn


def _push(client, sn, lines):
    r = client.post(f"/iclock/cdata?SN={sn}&table=ATTLOG", content="\n".join(lines))
    assert r.status_code == 200, r.text


def test_face_punches_from_terminal_are_listed(client, db, make_tenant, auth_headers):
    comp, hdr, sn = _setup(client, db, make_tenant, auth_headers, "FA")
    _push(client, sn, [
        "7\t2026-11-10 09:05:00\t0\t15",   # face
        "7\t2026-11-10 13:00:00\t0\t1",    # fingerprint: not a face punch
        "99\t2026-11-10 09:10:00\t0\t15",  # face, user not linked yet
    ])
    r = client.get(f"/apis/v3/face/logs/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 2
    names = {x["device_pin"]: x["employee_name"] for x in rows}
    assert names == {"7": "Ramesh Patil", "99": None}
    assert all(x["device_name"] == "Gate terminal" and x["site_name"] == "Shivalik" for x in rows)


def test_daily_summary_uses_site_day_not_utc(client, db, make_tenant, auth_headers):
    comp, hdr, sn = _setup(client, db, make_tenant, auth_headers, "FS")
    # 05:20 India time is the previous day in UTC; it belongs to the 10th.
    _push(client, sn, ["7\t2026-11-10 05:20:00\t0\t15", "7\t2026-11-10 18:40:00\t0\t15"])
    r = client.get(f"/apis/v3/face/summary/{comp.id}?date=2026-11-10", headers=hdr)
    assert r.status_code == 200, r.text
    s = r.json()
    assert len(s) == 1
    assert (s[0]["first_punch"], s[0]["last_punch"], s[0]["punches"]) == ("05:20", "18:40", 2)
    prev = client.get(f"/apis/v3/face/summary/{comp.id}?date=2026-11-09", headers=hdr).json()
    assert prev == []


def test_client_claimed_face_punch_endpoint_is_gone(client, db, make_tenant, auth_headers):
    comp, hdr, _sn = _setup(client, db, make_tenant, auth_headers, "FG")
    proj = db.query(models.Project).filter(models.Project.company_id == comp.id).first()
    emp = db.query(models.StaffEmployee).filter(models.StaffEmployee.company_id == comp.id).first()
    r = client.post("/apis/v3/face/punch", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(proj.id), "employee_id": str(emp.id),
        "punch_type": "in", "face_verified": True, "confidence_score": 0.99})
    assert r.status_code in (404, 405)


def test_staff_punch_report_lists_terminal_punches(client, db, make_tenant, auth_headers):
    from app.routers.reports import _REPORT_HANDLERS
    comp, _hdr, sn = _setup(client, db, make_tenant, auth_headers, "FR")
    _push(client, sn, ["7\t2026-11-10 09:05:00\t0\t15", "8\t2026-11-10 09:07:00\t0\t1"])
    rows = _REPORT_HANDLERS["staff-punch-report"](db, comp.id, None)
    assert [(r["Punch Time"], r["Employee Name"], r["Checked By"]) for r in rows] == [
        ("10-11-2026 09:07", "Not linked (terminal ID 8)", "Fingerprint"),
        ("10-11-2026 09:05", "Ramesh Patil", "Face"),
    ]
    assert "Confidence Score" not in rows[0]
