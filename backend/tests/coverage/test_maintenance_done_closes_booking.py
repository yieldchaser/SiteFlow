"""Recording a planned service as done closes the booking.

Found driving the Maintenance tab: saving "Done" for an overdue planned
service added a second row and left the planned one open, so the row still
read Overdue, the servicing banner stayed up, and the next maintenance entry
put the machine back into "maintenance".
"""
import uuid

from app import models


def test_done_entry_closes_the_planned_booking(client, db, make_tenant, auth_headers):
    sfx = uuid.uuid4().hex[:6]
    comp, user, _ = make_tenant(company_name=f"Maint {sfx}", user_name="Owner",
                                email=f"maint-{sfx}@example.com")
    hdr = auth_headers(user, comp)
    eq = models.Equipment(id=uuid.uuid4(), company_id=comp.id, name="Crane", code=f"CR-{sfx}",
                          category="Crane", ownership_type="Owned", status="available", hourly_rate=1000.0)
    db.add(eq)
    db.commit()

    url = f"/apis/v3/equipment/{eq.id}/maintenance"
    body = {"service_type": "500-hour service", "scheduled_date": "2026-10-25T09:00:00",
            "cost": 18000, "status": "scheduled", "remarks": None}
    assert client.post(url, headers=hdr, json=body).status_code == 201
    assert client.post(url, headers=hdr, json={**body, "status": "completed", "cost": 17500}).status_code == 201

    rows = client.get(f"/apis/v3/equipment/maintenance-schedules/{eq.id}", headers=hdr).json()
    assert len(rows) == 1, rows
    assert rows[0]["status"] == "completed" and rows[0]["completed_date"] is not None
    assert rows[0]["cost"] == 17500

    # A later, unrelated future booking must not bring the old one back.
    assert client.post(url, headers=hdr, json={**body, "service_type": "Oil change",
                                               "scheduled_date": "2099-01-01T09:00:00"}).status_code == 201
    fleet = client.get(f"/apis/v3/equipment/{comp.id}", headers=hdr).json()
    assert [e for e in fleet if e["id"] == str(eq.id)][0]["status"] == "available"
