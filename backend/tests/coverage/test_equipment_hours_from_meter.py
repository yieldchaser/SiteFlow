"""A returned machine is billed on its hour meter, not on wall-clock time.

Found driving the Equipment tab: the start and stop readings typed on site
went only into the remarks text, so returning a crane after four days billed
96 hours at the hourly rate whatever the meter said. Hours are now the meter
difference, and a stop reading below the start reading is refused.
"""
import datetime
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]


def test_return_bills_meter_hours_not_elapsed_time(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"EQM-{_SFX}", user_name="EQM",
                                mobile=f"+9175{_SFX}01", email=f"eqm-{_SFX}@test.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing")
    crane = models.Equipment(id=uuid.uuid4(), company_id=comp.id, name="Crawler crane", code=f"CR-{_SFX}",
                             category="Crane", ownership_type="Owned", hourly_rate=1000)
    db.add_all([project, crane])
    db.commit()

    start = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=4)
    r = client.post(f"/apis/v3/equipment/{crane.id}/deploy", headers=hdr, json={
        "project_id": str(project.id), "start_date": start.isoformat(),
        "hours_used": 0, "start_meter": 435,
    })
    assert r.status_code == 201, r.text
    dep_id = r.json()["id"]

    r = client.patch(f"/apis/v3/equipment/deployments/{dep_id}/return", headers=hdr,
                     json={"end_meter": 430})
    assert r.status_code == 400, r.text

    r = client.patch(f"/apis/v3/equipment/deployments/{dep_id}/return", headers=hdr,
                     json={"end_meter": 467.5})
    assert r.status_code == 200, r.text
    assert float(r.json()["hours_used"]) == 32.5
