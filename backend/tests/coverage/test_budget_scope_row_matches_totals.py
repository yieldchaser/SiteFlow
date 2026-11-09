"""The budget page's scope row agrees with the totals above it.

GET /budget/committed/{id}/towers counted only purchase orders as
committed and only bills as actual, while the totals on the same page
also counted work orders, payroll, wastage and equipment running cost. On
the demo project the row read Rs 2.85 Cr committed against a Rs 5.56 Cr
total.
"""
import datetime
import uuid

from app import models

_TAG = uuid.uuid4().hex[:8]


def test_scope_row_counts_work_orders_like_the_totals(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"BSR-{_TAG}", user_name="BSR",
                                   mobile="+9173" + str(int(_TAG, 16))[-8:], email=f"bsr-{_TAG}@test.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"BSR-{_TAG}", status="Ongoing")
    db.add(project)
    db.commit()
    db.add(models.ProjectBudget(id=uuid.uuid4(), project_id=project.id, material_budget=1000000.0,
                                labour_budget=0.0, subcon_budget=500000.0, equipment_budget=0.0))
    db.add(models.PurchaseOrder(id=uuid.uuid4(), company_id=comp.id, project_id=project.id, vendor_id=None,
                                po_number=f"PO-BSR-{_TAG}", po_date=datetime.datetime(2026, 1, 1), status="sent",
                                gross_amount=1000.0, tax_amount=0.0, total_amount=1000.0, approval_flag="approved"))
    db.add(models.WorkOrder(id=uuid.uuid4(), company_id=comp.id, project_id=project.id, subcontractor_id=team.id,
                            wo_number=f"WO-BSR-{_TAG}", wo_date=datetime.datetime(2026, 1, 1), status="active",
                            estimated_work_amount=5000.0))
    db.commit()

    totals = client.get(f"/apis/v3/budget/committed/{project.id}", headers=hdr)
    assert totals.status_code == 200, totals.text
    rows = client.get(f"/apis/v3/budget/committed/{project.id}/towers", headers=hdr)
    assert rows.status_code == 200, rows.text
    row = rows.json()[0]
    assert row["committed"] == 6000.0, row
    assert row["committed"] == totals.json()["total_committed"]
    assert row["actual"] == totals.json()["total_actual"]
    assert row["budget"] == totals.json()["total_budget"]
