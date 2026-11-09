"""The fuel efficiency report printed Mileage 5.0 and an "expected" 4 litres
per hour for every machine. Neither was ever entered anywhere. It now shows
only what was recorded: hours run, litres, cost and litres per hour, with
hours counted for the chosen project only."""
import datetime
import uuid

from app import models
from app.routers.reports import _REPORT_HANDLERS

_TAG = uuid.uuid4().hex[:8]


def test_fuel_report_uses_recorded_figures(db, make_tenant):
    comp, _user, _team = make_tenant(
        company_name=f"FUEL-{_TAG}", user_name=f"FUEL-{_TAG}",
        mobile="+917" + str(int(_TAG, 16))[-8:], email=f"fuel-{_TAG}@test.com",
    )
    p1 = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Site One", code=f"S1-{_TAG}", status="Ongoing")
    p2 = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Site Two", code=f"S2-{_TAG}", status="Ongoing")
    eq = models.Equipment(id=uuid.uuid4(), company_id=comp.id, name="JCB 3DX", code="MH12AB1234",
                          category="Excavator", ownership_type="Owned", hourly_rate=0)
    db.add_all([p1, p2, eq])
    db.flush()
    day = datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc)
    db.add_all([
        models.EquipmentDeployment(id=uuid.uuid4(), equipment_id=eq.id, project_id=p1.id, start_date=day, hours_used=40),
        models.EquipmentDeployment(id=uuid.uuid4(), equipment_id=eq.id, project_id=p2.id, start_date=day, hours_used=100),
        models.FuelLog(id=uuid.uuid4(), equipment_id=eq.id, project_id=p1.id, logged_date=day,
                       liters=200, cost_per_liter=95, total_cost=19000),
    ])
    db.commit()

    rows = _REPORT_HANDLERS["fuel-efficiency"](db, comp.id, p1.id)
    assert len(rows) == 1, rows
    row = rows[0]
    assert "Mileage" not in row and "Fuel Consumed (Expected)" not in row
    assert row["Project Name"] == "Site One"
    assert float(row["Hours Run"]) == 40.0          # Site Two's 100 hours not counted
    assert float(row["Fuel Added (Litres)"]) == 200.0
    assert float(row["Fuel Cost (INR)"]) == 19000.0
    assert float(row["Litres per Hour"]) == 5.0
