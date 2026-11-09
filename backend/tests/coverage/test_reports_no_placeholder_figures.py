"""Reports printed made-up figures: every task 100 units, every BOQ line 0
done, every work order 0 billed, payroll net = gross minus TDS only. These
check each report against figures worked out by hand from seeded records."""
import datetime
import uuid

from app import models
from app.routers.reports import _REPORT_HANDLERS

_TAG = uuid.uuid4().hex[:8]


def _setup(db, make_tenant):
    tag = uuid.uuid4().hex[:8]
    comp, _user, team = make_tenant(
        company_name=f"RPF-{tag}", user_name=f"RPF-{tag}",
        mobile="+917" + str(int(tag, 16))[-8:], email=f"rpf-{tag}@test.com",
    )
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower Site", code=f"TS-{_TAG}", status="Ongoing")
    db.add(p)
    db.flush()
    boq = models.BOQItem(id=uuid.uuid4(), project_id=p.id, section_name="RCC", item_name="M25 slab concrete",
                         unit="cum", quantity=200, rate=6000, amount=None, supply_tax_pct=18)
    db.add(boq)
    db.flush()
    day = datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc)
    t = models.Task(id=uuid.uuid4(), project_id=p.id, name="Slab L5", duration_days=5, start_date=day,
                    end_date=day + datetime.timedelta(days=5), boq_item_id=boq.id, progress=40)
    db.add(t)
    db.flush()
    wo = models.WorkOrder(id=uuid.uuid4(), project_id=p.id, company_id=comp.id, subcontractor_id=team.id,
                          wo_number=f"WO-{_TAG}", wo_date=day, estimated_work_amount=500000, status="active")
    db.add(wo)
    db.flush()
    db.add(models.WorkOrderItem(id=uuid.uuid4(), wo_id=wo.id, task_id=t.id, quantity=100, rate=5000, amount=500000))
    db.add(models.Bill(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, party_company_user_id=team.id,
                       wo_id=wo.id, invoice_number=f"RA-{_TAG}", invoice_date=day, invoice_type="subcon",
                       subtotal=150000, total_payable=150000))
    db.add(models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, name=f"Ravi {_TAG}", status="active",
        basic_salary=20000, hra=8000, other_allowances=2000,
        pf_employee_pct=12, pf_employer_pct=12, esi_employee_pct=0.75, esi_employer_pct=3.25,
        tds_monthly=0, is_esi_applicable=True, pt_applicable=False,
        date_of_joining=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)))
    db.commit()
    return comp, p


def test_boq_task_and_work_order_reports_use_recorded_progress(db, make_tenant):
    comp, p = _setup(db, make_tenant)

    boq_row = _REPORT_HANDLERS["boq-item"](db, comp.id, p.id)[0]
    assert float(boq_row["% Done"]) == 40.0
    assert float(boq_row["Done Quantity"]) == 80.0            # 200 x 40%
    assert float(boq_row["Amount w/o Tax"]) == 1200000.0      # 200 x 6000
    assert float(boq_row["Total Amount"]) == 1416000.0        # + 18%
    assert "Billed Qty" not in boq_row

    task_row = _REPORT_HANDLERS["task-boq-billed-unbilled"](db, comp.id, p.id)[0]
    assert float(task_row["Estimated Qty"]) == 200.0
    assert float(task_row["Done Qty"]) == 80.0
    assert float(task_row["Remaining Qty"]) == 120.0
    assert float(task_row["Work Done Value"]) == 480000.0

    wo_row = _REPORT_HANDLERS["boq-workorder-summary"](db, comp.id, p.id)[0]
    assert float(wo_row["Work Done Amount"]) == 200000.0      # 5,00,000 x 40%
    assert float(wo_row["Billed Amount"]) == 150000.0
    assert float(wo_row["Done but Not Billed"]) == 50000.0
    assert float(wo_row["Left to Bill on Order"]) == 350000.0
    assert float(wo_row["% Work Done"]) == 40.0


def test_payroll_library_net_and_ctc_include_pf_and_esi(db, make_tenant):
    comp, _p = _setup(db, make_tenant)
    row = _REPORT_HANDLERS["payroll-library"](db, comp.id, None)[0]
    assert "Shift Hours" not in row
    assert float(row["Gross Salary"]) == 30000.0
    # PF 12% of basic capped at 15,000 = 1,800. Gross 30,000 is above the
    # 21,000 ESI limit, so no ESI. Net = 30,000 - 1,800.
    assert float(row["Net Salary"]) == 28200.0
    assert float(row["Monthly CTC"]) == 31800.0               # + employer PF 1,800
    assert float(row["Yearly CTC"]) == 381600.0
