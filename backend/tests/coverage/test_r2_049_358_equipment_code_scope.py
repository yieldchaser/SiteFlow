"""R2-049 + R2-358 - equipment code scope, and the zero hourly-rate silence.

R2-049 (CRITICAL): `Equipment.code` was unique at column level, i.e. unique
across every tenant. Company B could not register a code Company A already
held; equipment codes are short and conventional ("EXC-01", "JCB-1") so
collisions were near-certain, and the 400 disclosed to the caller that some
other tenant owned that code. Every other duplicate guard in the codebase is
company-scoped -- this was the sole exception.

R2-358 clause (a): `finance.py` guarded equipment costing with
`if eq and eq.hourly_rate:`, a truthiness test on a Numeric defaulting to 0.0.
A machine with no configured rate -- the ordinary case for a Hired machine
whose rate lives on the hire invoice -- contributed nothing to Plant &
Machinery forever, indistinguishable from a machine never deployed. The cost
is still zero (there is no rate to invent), but the omission must be reported
rather than swallowed.
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone

from app import models

EQUIPMENT = "/apis/v3/equipment"
FINANCE_LOGGER = "app.equipment_cost"


def _equipment_payload(company_id, code, rate=100.0):
    return {
        "company_id": str(company_id),
        "name": "Excavator",
        "code": code,
        "category": "Excavator",
        "ownership_type": "Owned",
        "hourly_rate": rate,
    }


# --- R2-049 ----------------------------------------------------------------

def test_two_companies_can_register_the_same_code(client, db, make_tenant, auth_headers):
    comp_a, user_a, _ = make_tenant(company_name="R049A", user_name="U049A")
    comp_b, user_b, _ = make_tenant(company_name="R049B", user_name="U049B")

    first = client.post(
        EQUIPMENT, json=_equipment_payload(comp_a.id, "EXC-01"), headers=auth_headers(user_a, comp_a)
    )
    assert first.status_code == 201, first.text

    second = client.post(
        EQUIPMENT, json=_equipment_payload(comp_b.id, "EXC-01"), headers=auth_headers(user_b, comp_b)
    )
    assert second.status_code == 201, (
        "a code held by another tenant must not block this company "
        "(equipment.code is globally unique)"
    )


def test_duplicate_code_within_one_company_still_rejected(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="R049C", user_name="U049C")
    hdr = auth_headers(user, comp)

    first = client.post(EQUIPMENT, json=_equipment_payload(comp.id, "EXC-02"), headers=hdr)
    assert first.status_code == 201, first.text

    dup = client.post(EQUIPMENT, json=_equipment_payload(comp.id, "EXC-02"), headers=hdr)
    assert dup.status_code == 400, dup.text


def test_constraint_is_company_scoped_not_global(client, db, make_tenant, auth_headers):
    """The guarantee lives in the schema, not only in the route guard."""
    from sqlalchemy import inspect

    uniques = [
        {"columns": set(c["column_names"])}
        for c in inspect(db.get_bind()).get_unique_constraints("equipment")
    ]
    assert {"company_id", "code"} in [u["columns"] for u in uniques], (
        "equipment has no (company_id, code) unique constraint"
    )


# --- R2-358 clause (a) -----------------------------------------------------

def test_zero_rate_machine_is_reported_not_silently_skipped(
    client, db, make_tenant, auth_headers, caplog
):
    comp, user, _ = make_tenant(company_name="R358A", user_name="U358A")
    hdr = auth_headers(user, comp)

    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="R358 Project", status="Ongoing"
    )
    db.add(project)
    db.flush()

    # An owned machine with no rate configured: numerically it costs nothing,
    # but it must not vanish from the statement without trace. (A hired
    # machine is costed by its hire bills, so it is skipped by design.)
    machine = models.Equipment(
        id=uuid.uuid4(),
        company_id=comp.id,
        name="Own Roller",
        code="R-01",
        category="Roller",
        ownership_type="Owned",
        hourly_rate=0.0,
    )
    db.add(machine)
    db.flush()

    db.add(models.EquipmentDeployment(
        id=uuid.uuid4(),
        equipment_id=machine.id,
        project_id=project.id,
        start_date=datetime.now(timezone.utc) - timedelta(days=2),
        end_date=datetime.now(timezone.utc),
        hours_used=10.0,
    ))
    db.commit()

    with caplog.at_level(logging.WARNING, logger=FINANCE_LOGGER):
        r = client.get(f"/apis/v3/finance/pl?project_id={project.id}", headers=hdr)

    assert r.status_code == 200, r.text
    assert any(
        "no hourly_rate configured" in rec.getMessage() for rec in caplog.records
    ), "a machine with no configured rate was skipped silently instead of reported"


def test_rated_machine_still_costs_and_logs_nothing(
    client, db, make_tenant, auth_headers, caplog
):
    """The happy path is unchanged: a rated machine is billed, no warning."""
    comp, user, _ = make_tenant(company_name="R358B", user_name="U358B")
    hdr = auth_headers(user, comp)

    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="R358B Project", status="Ongoing"
    )
    db.add(project)
    db.flush()

    machine = models.Equipment(
        id=uuid.uuid4(),
        company_id=comp.id,
        name="Owned Excavator",
        code="R-02",
        category="Excavator",
        ownership_type="Owned",
        hourly_rate=500.0,
    )
    db.add(machine)
    db.flush()

    db.add(models.EquipmentDeployment(
        id=uuid.uuid4(),
        equipment_id=machine.id,
        project_id=project.id,
        start_date=datetime.now(timezone.utc) - timedelta(days=1),
        end_date=datetime.now(timezone.utc),
        hours_used=3.0,
    ))
    db.commit()

    with caplog.at_level(logging.WARNING, logger=FINANCE_LOGGER):
        r = client.get(f"/apis/v3/finance/pl?project_id={project.id}", headers=hdr)

    assert r.status_code == 200, r.text
    plant = [row for row in r.json() if row["head"] == "Plant & Machinery"][0]
    assert plant["actual"] == 1500.0, plant

    assert not any(
        "no hourly_rate configured" in rec.getMessage() for rec in caplog.records
    ), "a rated machine must not be reported as unconfigured"
