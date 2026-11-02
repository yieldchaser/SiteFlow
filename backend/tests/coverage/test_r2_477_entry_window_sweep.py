"""R2-477 — every client-dated write obeys the Entry Controls back-dating window.

Gate: with restrict_entry_creation_enabled on, a write dated deeper into the
past than restrict_entry_creation_days must be rejected with an Entry Controls
400 on every endpoint that accepts a client-supplied date — subcontractor
labour attendance (the audit's proven offender and the primary input to a
subcon RA bill), quality inspections, equipment deployments/fuel logs/
maintenance bookings, HR leave applications and GRNs — exactly as DPR,
billing and planning already do. The window stays a no-op while the flag is
off, and re-posting onto an already-old attendance row obeys the editing window.
"""
import datetime
import uuid

from app import models


def _enable_window(db, comp, days):
    comp.restrict_entry_creation_enabled = True
    comp.restrict_entry_creation_days = days
    db.commit()


def _old(days_ago):
    return (datetime.datetime.utcnow() - datetime.timedelta(days=days_ago)).isoformat()


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _project(db, comp, name):
    proj = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name=name, code=name[:8], status="Ongoing"
    )
    db.add(proj)
    db.commit()
    return proj


def _equipment(db, comp, code):
    eq = models.Equipment(
        id=uuid.uuid4(),
        company_id=comp.id,
        name=f"Excavator {code}",
        code=code,
        category="Excavator",
        ownership_type="Owned",
    )
    db.add(eq)
    db.commit()
    return eq


# ── subcontractor labour attendance ──────────────────────────────────────────


def _attendance_payload(proj, subcon_id, date_iso):
    return {
        "project_id": str(proj.id),
        "subcontractor_id": str(subcon_id),
        "attendance_date": date_iso,
        "labor_role": "Mason",
        "worker_count": 4,
    }


def test_backdated_subcon_attendance_is_rejected(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="R477A", user_name="U477A")
    hdr = auth_headers(user, comp)
    proj = _project(db, comp, "R477A site")
    _enable_window(db, comp, 1)

    r = client.post(
        "/apis/v3/subcon/attendance",
        json=_attendance_payload(proj, team.id, _old(195)),
        headers=hdr,
    )
    assert r.status_code == 400
    assert "Entry Controls" in r.json()["detail"]
    assert db.query(models.SubcontractorAttendance).filter_by(project_id=proj.id).count() == 0


def test_recent_subcon_attendance_still_passes(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="R477B", user_name="U477B")
    hdr = auth_headers(user, comp)
    proj = _project(db, comp, "R477B site")
    _enable_window(db, comp, 1)

    r = client.post(
        "/apis/v3/subcon/attendance",
        json=_attendance_payload(proj, team.id, _now()),
        headers=hdr,
    )
    assert r.status_code == 201
    assert db.query(models.SubcontractorAttendance).filter_by(project_id=proj.id).count() == 1


def test_window_off_leaves_subcon_attendance_untouched(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="R477C", user_name="U477C")
    hdr = auth_headers(user, comp)
    proj = _project(db, comp, "R477C site")

    r = client.post(
        "/apis/v3/subcon/attendance",
        json=_attendance_payload(proj, team.id, _old(195)),
        headers=hdr,
    )
    assert r.status_code == 201


def test_upsert_onto_old_attendance_row_hits_editing_window(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="R477D", user_name="U477D")
    hdr = auth_headers(user, comp)
    proj = _project(db, comp, "R477D site")
    old_date = datetime.datetime.utcnow() - datetime.timedelta(days=195)
    db.add(models.SubcontractorAttendance(
        project_id=proj.id,
        subcontractor_id=team.id,
        attendance_date=old_date,
        labor_role="Mason",
        worker_count=2,
    ))
    db.commit()
    comp.restrict_entry_editing_enabled = True
    comp.restrict_entry_editing_days = 7
    db.commit()

    r = client.post(
        "/apis/v3/subcon/attendance",
        json=_attendance_payload(proj, team.id, old_date.isoformat()),
        headers=hdr,
    )
    assert r.status_code == 400
    assert "Entry Controls" in r.json()["detail"]
    row = db.query(models.SubcontractorAttendance).filter_by(project_id=proj.id).first()
    assert row.worker_count == 2  # untouched


# ── quality inspections ───────────────────────────────────────────────────────


def test_backdated_inspection_is_rejected(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="R477E", user_name="U477E")
    hdr = auth_headers(user, comp)
    proj = _project(db, comp, "R477E site")
    _enable_window(db, comp, 1)

    r = client.post(
        "/apis/v3/quality/inspections",
        json={
            "project_id": str(proj.id),
            "checklist_id": str(uuid.uuid4()),
            "inspection_date": _old(40),
        },
        headers=hdr,
    )
    assert r.status_code == 400
    assert "Entry Controls" in r.json()["detail"]
    assert db.query(models.SiteInspection).filter_by(project_id=proj.id).count() == 0


def test_recent_inspection_still_passes(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="R477F", user_name="U477F")
    hdr = auth_headers(user, comp)
    proj = _project(db, comp, "R477F site")
    _enable_window(db, comp, 1)

    r = client.post(
        "/apis/v3/quality/inspections",
        json={
            "project_id": str(proj.id),
            "checklist_id": str(uuid.uuid4()),
            "inspection_date": _now(),
        },
        headers=hdr,
    )
    assert r.status_code == 201
    assert db.query(models.SiteInspection).filter_by(project_id=proj.id).count() == 1


# ── equipment: deployment / fuel log / maintenance booking ───────────────────


def test_backdated_equipment_writes_are_rejected(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="R477G", user_name="U477G")
    hdr = auth_headers(user, comp)
    proj = _project(db, comp, "R477G site")
    eq = _equipment(db, comp, "R477G-EX")
    _enable_window(db, comp, 1)

    r = client.post(
        f"/apis/v3/equipment/{eq.id}/deploy",
        json={"project_id": str(proj.id), "start_date": _old(60)},
        headers=hdr,
    )
    assert r.status_code == 400
    assert "Entry Controls" in r.json()["detail"]

    r = client.post(
        f"/apis/v3/equipment/{eq.id}/fuel",
        json={
            "project_id": str(proj.id),
            "logged_date": _old(30),
            "liters": 20.0,
            "cost_per_liter": 90.0,
        },
        headers=hdr,
    )
    assert r.status_code == 400
    assert "Entry Controls" in r.json()["detail"]

    r = client.post(
        f"/apis/v3/equipment/{eq.id}/maintenance",
        json={"service_type": "Oil change", "scheduled_date": _old(15)},
        headers=hdr,
    )
    assert r.status_code == 400
    assert "Entry Controls" in r.json()["detail"]

    assert db.query(models.EquipmentDeployment).filter_by(equipment_id=eq.id).count() == 0
    assert db.query(models.FuelLog).filter_by(equipment_id=eq.id).count() == 0
    assert db.query(models.MaintenanceSchedule).filter_by(equipment_id=eq.id).count() == 0


def test_recent_equipment_fuel_still_passes(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="R477H", user_name="U477H")
    hdr = auth_headers(user, comp)
    proj = _project(db, comp, "R477H site")
    eq = _equipment(db, comp, "R477H-EX")
    _enable_window(db, comp, 1)

    r = client.post(
        f"/apis/v3/equipment/{eq.id}/deploy",
        json={"project_id": str(proj.id), "start_date": _now()},
        headers=hdr,
    )
    assert r.status_code == 201

    r = client.post(
        f"/apis/v3/equipment/{eq.id}/fuel",
        json={
            "project_id": str(proj.id),
            "logged_date": _now(),
            "liters": 20.0,
            "cost_per_liter": 90.0,
        },
        headers=hdr,
    )
    assert r.status_code == 201
    assert db.query(models.FuelLog).filter_by(equipment_id=eq.id).count() == 1


# ── HR leave applications ─────────────────────────────────────────────────────


def test_backdated_leave_is_rejected_and_recent_passes(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="R477I", user_name="U477I")
    hdr = auth_headers(user, comp)
    _enable_window(db, comp, 1)
    worker = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name="R477 Worker", status="active")
    db.add(worker)
    db.commit()

    def _leave(date_iso):
        return {
            "employee_id": str(worker.id),
            "employee_name": "R477 Worker",
            "leave_type": "CL",
            "start_date": date_iso,
            "end_date": date_iso,
            "days_count": 1,
        }

    r = client.post(f"/apis/v3/hr/leaves/{comp.id}", json=_leave(_old(45)), headers=hdr)
    assert r.status_code == 400
    assert "Entry Controls" in r.json()["detail"]
    assert db.query(models.LeaveRequest).filter_by(company_id=comp.id).count() == 0

    today = datetime.datetime.utcnow().isoformat()
    r = client.post(f"/apis/v3/hr/leaves/{comp.id}", json=_leave(today), headers=hdr)
    assert r.status_code in (200, 201)
    assert db.query(models.LeaveRequest).filter_by(company_id=comp.id).count() == 1


# ── GRN ───────────────────────────────────────────────────────────────────────


def test_backdated_grn_is_rejected_before_any_write(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="R477J", user_name="U477J")
    hdr = auth_headers(user, comp)
    _enable_window(db, comp, 1)

    grn_payload = {
        "company_id": str(comp.id),
        "project_id": str(uuid.uuid4()),
        "po_id": str(uuid.uuid4()),
        "received_date": _old(90),
        "items": [],
    }
    r = client.post("/apis/v3/procurement/grns", json=grn_payload, headers=hdr)
    assert r.status_code == 400
    assert "Entry Controls" in r.json()["detail"]
    assert db.query(models.GoodsReceiptNote).filter_by(company_id=comp.id).count() == 0


def test_grn_guard_is_a_noop_while_flag_off(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="R477K", user_name="U477K")
    hdr = auth_headers(user, comp)

    grn_payload = {
        "company_id": str(comp.id),
        "project_id": str(uuid.uuid4()),
        "po_id": str(uuid.uuid4()),
        "received_date": _old(90),
        "items": [],
    }
    r = client.post("/apis/v3/procurement/grns", json=grn_payload, headers=hdr)
    # The window must not fire; the request proceeds and fails later on the
    # (nonexistent) PO lookup instead.
    assert r.status_code == 404
    assert "Entry Controls" not in r.json()["detail"]
