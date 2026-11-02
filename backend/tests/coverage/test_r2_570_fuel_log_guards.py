"""R2-570 - fuel logs accepted a backwards odometer, a date 73 years out and fuel for a machine never deployed to the project being charged.

POST /equipment/{id}/fuel validated only liters > 0 and cost_per_liter >= 0.
Everything relational and temporal was unchecked, and all of it landed 201:
odometer 5 right after 9000 (no monotonicity), logged_date 2099-12-31, and
fuel charged to a project the machine has no deployment on - which finance
then summed straight into that project's Plant & Machinery actual.

Gate: logged_date is bounded at today; the equipment must have a deployment
on the project covering logged_date (boundaries inclusive); odometer_hours
may never fall below the machine's previous reading.
"""
import uuid
from datetime import datetime, timezone

from app import models


def _mk_equipment(db, comp, name, code):
    eq = models.Equipment(
        id=uuid.uuid4(), company_id=comp.id, name=name, code=code,
        category="Excavator", ownership_type="Owned", status="deployed",
        hourly_rate=1200.0,
    )
    db.add(eq)
    db.commit()
    return eq


def _log_fuel(client, hdr, eq_id, project_id, **kw):
    body = {
        "project_id": str(project_id),
        "logged_date": "2026-08-22T10:00:00Z",
        "liters": 50.0,
        "cost_per_liter": 90.0,
    }
    body.update(kw)
    return client.post(f"/apis/v3/equipment/{eq_id}/fuel", headers=hdr, json=body)


def test_r2_570_fuel_log_guards(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(
        company_name="R2570", user_name="U570",
        mobile="+9192570001", email="r570@test.com",
    )
    hdr = auth_headers(user, comp)
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="P570",
        code="PRJ-570", status="Ongoing",
    )
    other_project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="P570-other",
        code="PRJ-570O", status="Ongoing",
    )
    db.add_all([project, other_project])
    eq = _mk_equipment(db, comp, "ZZ 570 Excavator", "EQ-570")
    # Deployment covering 2026-08-21T00:00Z onward, still open.
    db.add(models.EquipmentDeployment(
        id=uuid.uuid4(), equipment_id=eq.id, project_id=project.id,
        start_date=datetime(2026, 8, 21, tzinfo=timezone.utc), end_date=None,
    ))
    db.commit()

    # A date years in the future is refused outright.
    r = _log_fuel(client, hdr, eq.id, project.id, logged_date="2099-12-31T00:00:00Z")
    assert r.status_code == 400, r.text
    assert "future" in r.json()["detail"], r.text

    # Fuel for a machine with no deployment on the charged project is refused.
    r = _log_fuel(client, hdr, eq.id, other_project.id)
    assert r.status_code == 400, r.text
    assert "deployed on this project" in r.json()["detail"], r.text

    # A valid log inside the deployment window goes through...
    r = _log_fuel(client, hdr, eq.id, project.id, odometer_hours=9000.0)
    assert r.status_code == 201, r.text

    # ...but the odometer may never run backwards for that machine.
    r = _log_fuel(client, hdr, eq.id, project.id, odometer_hours=5.0)
    assert r.status_code == 400, r.text
    assert "previous reading" in r.json()["detail"], r.text

    # Equal or higher readings stay legal, and the start boundary is inclusive.
    r = _log_fuel(client, hdr, eq.id, project.id, odometer_hours=9000.0)
    assert r.status_code == 201, r.text
    r = _log_fuel(
        client, hdr, eq.id, project.id,
        logged_date="2026-08-21T00:00:00Z", odometer_hours=9001.5,
    )
    assert r.status_code == 201, r.text

    stored = db.query(models.FuelLog).filter(models.FuelLog.equipment_id == eq.id).all()
    assert len(stored) == 3, [(s.logged_date, float(s.odometer_hours or -1)) for s in stored]
