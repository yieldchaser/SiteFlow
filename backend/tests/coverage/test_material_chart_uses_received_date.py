"""Dashboard "Last 7 days material received" counted stock rows by the day
they were typed in. Receipts entered later all piled onto the entry day
(21 lines on one bar, nothing on the days the trucks actually came). A GRN
row is now dated by the GRN's received date."""
import datetime
import uuid

from app import models


def test_material_chart_buckets_grn_rows_by_received_date(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"Mat Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    db.add(project)
    db.flush()
    today = datetime.datetime.utcnow().replace(hour=10, minute=0, second=0, microsecond=0)
    received = today - datetime.timedelta(days=3)
    grn = models.GoodsReceiptNote(id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
                                  grn_number="GRN-1", received_date=received)
    db.add(grn)
    db.flush()
    for name in ("Cement", "Sand"):
        db.add(models.MaterialTransaction(id=uuid.uuid4(), project_id=project.id, material_name=name, qty=10,
                                          type="received", source_ref_id=grn.id, created_at=today))
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}/operational", headers=hdr)
    assert r.status_code == 200, r.text
    by_day = {d["date"]: d["count"] for d in r.json()["material_series"]}
    assert by_day[received.strftime("%Y-%m-%d")] == 2, by_day
    assert by_day[today.strftime("%Y-%m-%d")] == 0, by_day
