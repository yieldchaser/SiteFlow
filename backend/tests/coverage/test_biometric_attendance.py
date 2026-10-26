"""Biometric terminals (ZKTeco / eSSL ADMS push) feed the attendance register."""

import uuid as _uuid
from datetime import datetime, timezone


def _setup(db, make_tenant, auth_headers, tag):
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"Bio{tag}-{sfx}", user_name=f"UBio{tag}-{sfx}",
        mobile=f"+9184{sfx}", email=f"bio{tag}-{sfx}@test.com",
    )
    project = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="Gate Site", state="Maharashtra")
    rajesh = models.StaffEmployee(id=_uuid.uuid4(), company_id=comp.id, project_id=project.id,
                                  name="Rajesh Kulkarni", employee_code="SIC-001", biometric_pin="101")
    sunil = models.StaffEmployee(id=_uuid.uuid4(), company_id=comp.id, project_id=project.id,
                                 name="Sunil Pawar", employee_code="SIC-002")
    db.add_all([project, rajesh, sunil])
    db.commit()
    return comp, auth_headers(user, comp), project, rajesh, sunil, sfx


def test_device_punches_become_attendance_in_and_out(client, db, make_tenant, auth_headers):
    from app import models

    comp, hdr, project, rajesh, sunil, sfx = _setup(db, make_tenant, auth_headers, "A")
    sn = f"CQZ7{sfx}"

    assert client.get(f"/iclock/cdata?SN={sn}&options=all").status_code == 404, "unregistered devices must be refused"

    res = client.post("/apis/v3/biometric/devices", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "serial_number": sn, "name": "Main gate",
    })
    assert res.status_code == 201, res.text

    hs = client.get(f"/iclock/cdata?SN={sn}&options=all")
    assert hs.status_code == 200 and f"GET OPTION FROM: {sn}" in hs.text and "TimeZone=5.5" in hs.text

    # Device local time is IST. Rajesh in 09:02, out 18:30; PIN 202 is not mapped yet.
    body = "101\t2026-10-20 09:02:11\t0\t1\t0\t0\n101\t2026-10-20 18:30:00\t1\t15\t0\t0\n202\t2026-10-20 08:55:00\t0\t1\t0\t0\n"
    up = client.post(f"/iclock/cdata?SN={sn}&table=ATTLOG&Stamp=1", content=body)
    assert up.status_code == 200 and up.text == "OK: 3", up.text
    # Devices resend after a timeout; nothing may double up.
    assert client.post(f"/iclock/cdata?SN={sn}&table=ATTLOG", content=body).text == "OK: 3"
    assert db.query(models.BiometricPunch).filter(models.BiometricPunch.company_id == comp.id).count() == 3

    logs = db.query(models.AttendanceLog).filter(models.AttendanceLog.employee_id == rajesh.id).all()
    assert len(logs) == 1
    log = logs[0]
    as_utc = lambda d: d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)
    assert as_utc(log.punch_in) == datetime(2026, 10, 20, 3, 32, 11, tzinfo=timezone.utc)
    assert as_utc(log.punch_out) == datetime(2026, 10, 20, 13, 0, 0, tzinfo=timezone.utc)
    assert float(log.hours_worked) == 9.46 and float(log.overtime_hours) == 1.46
    assert log.status == "Present" and log.location_verified

    shown = client.get(f"/apis/v3/hr/attendance/{project.id}/2026-10-20", headers=hdr)
    assert shown.status_code == 200, shown.text
    assert any(r["employee_id"] == str(rajesh.id) for r in shown.json()), shown.json()

    unmatched = client.get(f"/apis/v3/biometric/punches/{comp.id}?unmatched_only=true", headers=hdr).json()
    assert [p["device_pin"] for p in unmatched] == ["202"]

    # Mapping PIN 202 to Sunil applies the punch he already made.
    res = client.put(f"/apis/v3/biometric/employees/{sunil.id}/pin", headers=hdr, json={"biometric_pin": "202"})
    assert res.status_code == 200, res.text
    sunil_log = db.query(models.AttendanceLog).filter(models.AttendanceLog.employee_id == sunil.id).one()
    assert sunil_log.punch_in is not None and sunil_log.punch_out is None

    clash = client.put(f"/apis/v3/biometric/employees/{sunil.id}/pin", headers=hdr, json={"biometric_pin": "101"})
    assert clash.status_code == 409


def test_another_company_cannot_see_or_map_devices(client, db, make_tenant, auth_headers):
    comp, hdr, project, rajesh, _sunil, sfx = _setup(db, make_tenant, auth_headers, "B")
    _comp2, hdr2, project2, _r2, _s2, _ = _setup(db, make_tenant, auth_headers, "C")

    res = client.post("/apis/v3/biometric/devices", headers=hdr2, json={
        "company_id": str(comp.id), "project_id": str(project.id), "serial_number": f"X{sfx}", "name": "Hijack",
    })
    assert res.status_code in (403, 404), res.text
    assert client.get(f"/apis/v3/biometric/devices/{comp.id}", headers=hdr2).status_code in (403, 404)
    assert client.put(f"/apis/v3/biometric/employees/{rajesh.id}/pin", headers=hdr2,
                      json={"biometric_pin": "999"}).status_code in (403, 404)
