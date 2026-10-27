"""Three demo-day defects on the analytics page and the Item Wise Sales report.

1. Material usage logged without a unit stood alone as a line with nothing
   ordered, so every such material was flagged "over-consumed".
2. Labour productivity read 0 because BOQs measured in sqft were ignored; with
   no finished area-measured work it is unknown, not zero.
3. Item Wise Sales showed the quotation's raw creation timestamp as the
   invoice date instead of the linked bill's invoice date.
"""
import datetime
import uuid
from datetime import timezone
from decimal import Decimal

from app import models

_SUFFIX = uuid.uuid4().hex[:8]


def _utc(y, m, d, h=0, mi=0):
    return datetime.datetime(y, m, d, h, mi, tzinfo=timezone.utc)


def _tenant(make_tenant, auth_headers, tag):
    comp, user, team = make_tenant(
        company_name=f"AU-{tag}-{_SUFFIX}", user_name=f"U-{tag}",
        mobile=f"+9177{_SUFFIX}{tag:02d}", email=f"au-{tag}-{_SUFFIX}@test.com",
    )
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Proj", status="Ongoing")
    return comp, team, project, auth_headers(user, comp)


def test_usage_without_unit_matches_the_ordered_unit(client, db, make_tenant, auth_headers):
    comp, _team, project, hdr = _tenant(make_tenant, auth_headers, 1)
    db.add(project)
    db.flush()
    po = models.PurchaseOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, po_number="PO-1",
        po_date=_utc(2026, 1, 1), status="received", gross_amount=Decimal("100"),
        tax_amount=Decimal("0"), total_amount=Decimal("100"))
    db.add(po)
    db.flush()
    db.add(models.PurchaseOrderItem(
        id=uuid.uuid4(), po_id=po.id, material_name="Cement", quantity=Decimal("100"),
        unit="bag", rate=Decimal("1"), tax_pct=Decimal("0")))
    db.add(models.MaterialTransaction(
        id=uuid.uuid4(), project_id=project.id, material_name="Cement", qty=30, unit=None, type="used"))
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rec = r.json()["material_reconciliation"]
    assert [row for row in rec if row["over_consumed"]] == [], rec
    cement = [row for row in rec if row["material_name"] == "Cement"]
    assert cement == [{"material_name": "Cement", "unit": "bag", "ordered_qty": 100.0,
                       "consumed_qty": 30.0, "variance_qty": 70.0, "over_consumed": False}], rec


def test_productivity_counts_sqft_and_is_unknown_without_area(client, db, make_tenant, auth_headers):
    comp, _team, project, hdr = _tenant(make_tenant, auth_headers, 2)
    db.add(project)
    db.flush()
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, name="Mason",
        status="active", basic_salary=1000.0, hra=0.0, other_allowances=0.0,
        pf_employee_pct=0.0, pf_employer_pct=0.0, esi_employee_pct=0.0,
        esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False)
    db.add(emp)
    db.flush()
    for d in (1, 2):
        db.add(models.AttendanceLog(
            id=uuid.uuid4(), employee_id=emp.id, project_id=project.id,
            attendance_date=_utc(2026, 1, d, 9), status="Present", hours_worked=8))
    db.commit()

    # Labour logged but nothing area-measured finished: unknown, not 0.
    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["labour_productivity"]["productivity_m2_per_labour_day"] is None

    boq = models.BOQItem(id=uuid.uuid4(), project_id=project.id, section_name="S",
                         item_name="Plaster", unit="sqft", quantity=1000.0)
    db.add(boq)
    db.flush()
    db.add(models.Task(
        id=uuid.uuid4(), project_id=project.id, name="Plaster", status="completed",
        duration_days=2, start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 2),
        boq_item_id=boq.id))
    db.commit()

    lp = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr).json()["labour_productivity"]
    assert lp["completed_area_m2"] == 92.9  # 1000 sqft
    assert lp["labour_days"] == 2.0
    assert lp["productivity_m2_per_labour_day"] == 46.45


def test_productivity_counts_each_boq_line_once(client, db, make_tenant, auth_headers):
    comp, _team, project, hdr = _tenant(make_tenant, auth_headers, 4)
    db.add(project)
    db.flush()
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, name="Mason",
        status="active", basic_salary=1000.0, hra=0.0, other_allowances=0.0,
        pf_employee_pct=0.0, pf_employer_pct=0.0, esi_employee_pct=0.0,
        esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False)
    db.add(emp)
    db.flush()
    db.add(models.AttendanceLog(
        id=uuid.uuid4(), employee_id=emp.id, project_id=project.id,
        attendance_date=_utc(2026, 1, 1, 9), status="Present", hours_worked=8))
    raft = models.BOQItem(id=uuid.uuid4(), project_id=project.id, section_name="S",
                          item_name="Raft", unit="sqm", quantity=100.0)
    slab = models.BOQItem(id=uuid.uuid4(), project_id=project.id, section_name="S",
                          item_name="Slab", unit="sqm", quantity=200.0)
    db.add_all([raft, slab])
    db.flush()

    def task(name, item, status, progress):
        db.add(models.Task(
            id=uuid.uuid4(), project_id=project.id, name=name, status=status, progress=progress,
            duration_days=1, start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 2), boq_item_id=item.id))

    # Two finished tower tasks share one 100 sqm raft: 100, not 200.
    task("Raft A", raft, "completed", 100)
    task("Raft B", raft, "completed", 100)
    # A 200 sqm slab split over two floors, one finished, one at 0: 100, not 200.
    task("Slab L1", slab, "completed", 100)
    task("Slab L2", slab, "not_started", 0)
    db.commit()

    lp = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr).json()["labour_productivity"]
    assert lp["completed_area_m2"] == 200.0, lp
    assert lp["productivity_m2_per_labour_day"] == 200.0, lp


def test_item_wise_sales_uses_the_bill_invoice_date(client, db, make_tenant, auth_headers):
    comp, team, project, hdr = _tenant(make_tenant, auth_headers, 3)
    db.add(project)
    lead = models.CRMLead(id=uuid.uuid4(), company_id=comp.id, lead_type="New Project",
                          contact_name="Lead", client_company_name="Client", phone_no="9999999999")
    db.add(lead)
    db.flush()
    quot = models.CRMQuotation(id=uuid.uuid4(), lead_id=lead.id, subject="Q",
                               created_at=_utc(2026, 10, 26, 10, 20))
    db.add(quot)
    db.flush()
    db.add(models.CRMQuotationItem(id=uuid.uuid4(), quotation_id=quot.id, item_name=f"Slab-{_SUFFIX}",
                                   qty=1, unit="LS", selling_price=100, total_amount=100))
    # 15 Oct 2026 00:30 IST is still 14 Oct in UTC.
    db.add(models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
        quotation_id=quot.id, invoice_number=f"INV-{_SUFFIX}", invoice_date=_utc(2026, 10, 14, 19, 0),
        invoice_type="sale", subtotal=100.0, total_payable=100.0, status="Unpaid"))
    db.commit()

    r = client.get(f"/apis/v3/reports/data/item-wise-sales?company_id={comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = [x for x in r.json()["rows"] if x["Item Name"] == f"Slab-{_SUFFIX}"]
    assert len(rows) == 1, r.json()
    assert rows[0]["Invoice Date"] == "2026-10-15", rows[0]
