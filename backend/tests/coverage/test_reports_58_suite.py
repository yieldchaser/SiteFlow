import re
import uuid
import pytest
from datetime import datetime, timezone, date
from decimal import Decimal
from pathlib import Path

from app.models import (
    Base, Company, Project, User, CompanyTeam, Bill, Payment,
    DailyProgressReport, Task, PurchaseOrder, PurchaseOrderItem,
    WarehouseInventory, StaffEmployee, AttendanceLog, CRMLead,
    CRMQuotation, CRMQuotationItem, MaterialTransaction, GRNItem,
    GoodsReceiptNote, BankAccount, TransactionDeduction, PaymentRequest,
    BOQItem, WorkOrder, WorkOrderItem, SiteInspection, QualityChecklist,
    Equipment, EquipmentDeployment, FuelLog, MaintenanceSchedule,
    LibraryParty, LibraryCostCode, LibraryMaterial, LibraryRate,
    Todo, MusterRoll, FaceRecognitionLog, PayrollRun, PayrollLineItem
)
from app.routers.reports import _REPORT_HANDLERS, _REPORT_FAILED


@pytest.fixture(scope="module")
def metadata_columns():
    slug_file = (
        Path(__file__).resolve().parents[3]
        / "frontend" / "src" / "app" / "c" / "[company_id]" / "reports" / "[slug]" / "page.tsx"
    )
    import subprocess, json
    node_script = """
    const fs = require('fs');
    const filePath = process.argv[1];
    const content = fs.readFileSync(filePath, 'utf8');
    const start = content.indexOf('const REPORT_METADATA');
    const end = content.indexOf('};', start);
    const code = content.slice(start, end + 2);
    const cleanCode = code.replace(/:\\s*Record<[^>]+>/, '');
    const fn = new Function(cleanCode + '; return REPORT_METADATA;');
    const meta = fn();
    const cols = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.columns]));
    console.log(JSON.stringify(cols));
    """
    res = subprocess.run(["node", "-e", node_script, str(slug_file)], capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def test_all_82_handlers_registered():
    assert len(_REPORT_HANDLERS) == 78, f"Expected 78 handlers (four reports with no source removed), found {len(_REPORT_HANDLERS)}"


def test_all_82_handlers_return_empty_list_for_empty_company(db):
    dummy_cid = uuid.uuid4()
    for slug, handler in _REPORT_HANDLERS.items():
        res = handler(db, dummy_cid, None)
        assert res is not _REPORT_FAILED, f"Handler for {slug} returned _REPORT_FAILED for empty company"
        assert isinstance(res, list), f"Handler for {slug} returned non-list for empty company: {type(res)}"


def test_all_82_handlers_match_metadata_columns_when_seeded(db, metadata_columns):
    # 1. Seed complete company environment
    cid = uuid.uuid4()
    cid_other = uuid.uuid4()
    company = Company(id=cid, name="Acme Construction Co")
    other_company = Company(id=cid_other, name="Other Co")
    db.add_all([company, other_company])
    db.flush()

    uid = uuid.uuid4().hex[:6]
    user = User(
        id=uuid.uuid4(),
        email=f"john_{uid}@example.com",
        mobile=f"91{uuid.uuid4().int % 100000000:08d}",
        name="John Builder"
    )
    db.add(user)
    db.flush()

    team = CompanyTeam(
        id=uuid.uuid4(),
        company_id=cid,
        user_id=user.id,
        priority_type="Manager"
    )
    db.add(team)
    db.flush()

    proj = Project(
        id=uuid.uuid4(),
        company_id=cid,
        name="Skyline Tower",
        code="SKY-1",
        project_value=1000000.0,
        planned_start_date=datetime.now(timezone.utc),
        planned_end_date=datetime.now(timezone.utc),
        status="Ongoing"
    )
    db.add(proj)
    db.flush()

    # Seed entities
    emp = StaffEmployee(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=proj.id,
        name="Alice Staff",
        employee_code=f"EMP_{uid}",
        designation="Site Engineer",
        department="Engineering",
        mobile=f"92{uuid.uuid4().int % 100000000:08d}",
        basic_salary=50000.0,
        hra=15000.0,
        other_allowances=5000.0,
        tds_monthly=2000.0,
        created_at=datetime.now(timezone.utc)
    )
    db.add(emp)
    db.flush()

    att = AttendanceLog(
        id=uuid.uuid4(),
        employee_id=emp.id,
        project_id=proj.id,
        attendance_date=datetime.now(timezone.utc),
        punch_in=datetime.now(timezone.utc),
        punch_out=datetime.now(timezone.utc),
        status="Present",
        hours_worked=8.0,
        overtime_hours=2.0,
        is_within_geofence=True
    )
    db.add(att)

    task = Task(
        id=uuid.uuid4(),
        project_id=proj.id,
        name="Foundation Piling",
        duration_days=10,
        start_date=datetime.now(timezone.utc),
        end_date=datetime.now(timezone.utc),
        progress=50.0,
        status="in_progress"
    )
    db.add(task)
    db.flush()

    boq = BOQItem(
        id=uuid.uuid4(),
        project_id=proj.id,
        item_name="Cement Concrete M25",
        unit="cum",
        quantity=500.0,
        rate=4500.0,
        amount=2250000.0,
        cost_code="CIVIL-01",
        created_at=datetime.now(timezone.utc)
    )
    db.add(boq)

    bill = Bill(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=proj.id,
        party_company_user_id=team.id,
        invoice_number=f"BILL-{uid}",
        invoice_date=datetime.now(timezone.utc),
        due_date=datetime.now(timezone.utc),
        invoice_type="material",
        status="Pending",
        subtotal=100000.0,
        gst_amount=18000.0,
        total_payable=118000.0,
        paid_amount=50000.0,
        created_at=datetime.now(timezone.utc)
    )
    db.add(bill)
    db.flush()

    td = TransactionDeduction(
        id=uuid.uuid4(),
        bill_id=bill.id,
        deduction_type="TDS",
        amount=2000.0,
        created_at=datetime.now(timezone.utc)
    )
    db.add(td)

    payment = Payment(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=proj.id,
        party_company_user_id=team.id,
        amount=50000.0,
        unsettled_amount=50000.0,
        reference_number=f"PAY-{uid}",
        payment_type="out",
        payment_method="Bank Transfer",
        payment_date=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc)
    )
    db.add(payment)

    po = PurchaseOrder(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=proj.id,
        po_number=f"PO-{uid}",
        po_date=datetime.now(timezone.utc),
        total_amount=150000.0,
        gross_amount=150000.0,
        tax_amount=27000.0,
        status="approved",
        approval_flag="Approved",
        created_at=datetime.now(timezone.utc)
    )
    db.add(po)
    db.flush()

    poi = PurchaseOrderItem(
        id=uuid.uuid4(),
        po_id=po.id,
        material_name="Steel TMT Bars",
        unit="MT",
        rate=60000.0,
        quantity=2.5,
        created_at=datetime.now(timezone.utc)
    )
    db.add(poi)

    eq = Equipment(
        id=uuid.uuid4(),
        company_id=cid,
        name="Tower Crane 50T",
        code=f"TC-{uid}",
        category="Heavy Machinery",
        ownership_type="owned",
        status="available",
        hourly_rate=1500.0,
        created_at=datetime.now(timezone.utc)
    )
    db.add(eq)
    db.flush()

    eq_dep = EquipmentDeployment(
        id=uuid.uuid4(),
        equipment_id=eq.id,
        project_id=proj.id,
        start_date=datetime.now(timezone.utc),
        end_date=datetime.now(timezone.utc),
        hours_used=120.0,
        remarks="Core wall lifting",
        created_at=datetime.now(timezone.utc)
    )
    db.add(eq_dep)

    fl = FuelLog(
        id=uuid.uuid4(),
        equipment_id=eq.id,
        project_id=proj.id,
        liters=150.0,
        cost_per_liter=90.0,
        total_cost=13500.0,
        logged_date=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc)
    )
    db.add(fl)

    lp = LibraryParty(
        id=uuid.uuid4(),
        company_id=cid,
        name="UltraTech Cement Ltd",
        party_type="Vendor",
        bank_name="HDFC Bank",
        account_name="UltraTech",
        account_number="1234567890",
        ifsc_code="HDFC0001234",
        created_at=datetime.now(timezone.utc)
    )
    db.add(lp)

    lcc = LibraryCostCode(
        id=uuid.uuid4(),
        company_id=cid,
        code=f"CIVIL-{uid}",
        name="Civil Concrete Works",
        budget_amount=5000000.0,
        created_at=datetime.now(timezone.utc)
    )
    db.add(lcc)

    lm = LibraryMaterial(
        id=uuid.uuid4(),
        company_id=cid,
        name="Structural Steel",
        unit="MT",
        category="Steel",
        item_code=f"MAT-ST-{uid}",
        created_at=datetime.now(timezone.utc)
    )
    db.add(lm)

    lr = LibraryRate(
        id=uuid.uuid4(),
        company_id=cid,
        name="PCC 1:2:4 Casting",
        unit="cum",
        unit_cost=3800.0,
        unit_sale_price=4500.0,
        markup_value=700.0,
        markup_type="flat",
        created_at=datetime.now(timezone.utc)
    )
    db.add(lr)

    todo = Todo(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=proj.id,
        title="Check cube test reports",
        status="pending",
        created_at=datetime.now(timezone.utc)
    )
    db.add(todo)

    mr = MusterRoll(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=proj.id,
        date=datetime.now(timezone.utc),
        labor_role="Mason",
        workers_present=12,
        workers_absent=2,
        hours_worked=8.0,
        created_at=datetime.now(timezone.utc)
    )
    db.add(mr)

    face = FaceRecognitionLog(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=proj.id,
        employee_id=emp.id,
        punch_type="in",
        face_verified=True,
        confidence_score=98.5,
        is_within_geofence=True,
        lat=12.9716,
        lng=77.5946,
        created_at=datetime.now(timezone.utc)
    )
    db.add(face)

    pr = PayrollRun(
        id=uuid.uuid4(),
        company_id=cid,
        payroll_month="2026-08",
        status="approved",
        created_at=datetime.now(timezone.utc)
    )
    db.add(pr)
    db.flush()

    pli = PayrollLineItem(
        id=uuid.uuid4(),
        payroll_run_id=pr.id,
        employee_id=emp.id,
        basic=50000.0,
        hra=15000.0,
        other_allowances=5000.0,
        gross_salary=70000.0,
        pf_employee=1800.0,
        esi_employee=200.0,
        tds=0.0,
        total_deductions=2000.0,
        net_payable=68000.0,
        days_present=26,
        created_at=datetime.now(timezone.utc)
    )
    db.add(pli)

    wo = WorkOrder(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=proj.id,
        subcontractor_id=team.id,
        wo_number="WO-2026-001",
        wo_date=datetime.now(timezone.utc),
        estimated_work_amount=350000.0,
        status="active",
        created_at=datetime.now(timezone.utc)
    )
    db.add(wo)
    db.flush()

    woi = WorkOrderItem(
        id=uuid.uuid4(),
        wo_id=wo.id,
        boq_item_id=boq.id,
        quantity=15.0,
        rate=23000.0,
        amount=345000.0,
        created_at=datetime.now(timezone.utc)
    )
    db.add(woi)

    chk = QualityChecklist(
        id=uuid.uuid4(),
        company_id=cid,
        title="Pre-pour Concrete Checklist",
        created_at=datetime.now(timezone.utc)
    )
    db.add(chk)
    db.flush()

    insp = SiteInspection(
        id=uuid.uuid4(),
        project_id=proj.id,
        checklist_id=chk.id,
        inspection_date=datetime.now(timezone.utc),
        status="pass",
        pass_count=10,
        fail_count=0,
        overall_remarks="All clear for pouring",
        created_at=datetime.now(timezone.utc)
    )
    db.add(insp)

    lead = CRMLead(
        id=uuid.uuid4(),
        company_id=cid,
        lead_type="Commercial",
        contact_name="Mr. Sharma",
        phone_no="9876543210",
        status="Proposal Sent",
        created_at=datetime.now(timezone.utc)
    )
    db.add(lead)
    db.flush()

    quot = CRMQuotation(
        id=uuid.uuid4(),
        lead_id=lead.id,
        subject="Turnkey Civil Package",
        total_amount=15000000.0,
        status="sent",
        created_at=datetime.now(timezone.utc)
    )
    db.add(quot)
    db.flush()

    q_item = CRMQuotationItem(
        id=uuid.uuid4(),
        quotation_id=quot.id,
        item_name="Earthwork excavation",
        unit="cum",
        qty=1000.0,
        selling_price=450.0,
        total_amount=450000.0,
        created_at=datetime.now(timezone.utc)
    )
    db.add(q_item)

    wh = WarehouseInventory(
        id=uuid.uuid4(),
        project_id=proj.id,
        material_name="River Sand",
        unit="CFT",
        on_hand_qty=2500.0,
        reserved_qty=0.0,
        created_at=datetime.now(timezone.utc)
    )
    db.add(wh)

    mt = MaterialTransaction(
        id=uuid.uuid4(),
        project_id=proj.id,
        material_name="River Sand",
        unit="CFT",
        qty=500.0,
        type="received",
        created_at=datetime.now(timezone.utc)
    )
    db.add(mt)

    db.commit()

    # 2. Test each of the 82 reports
    for slug, handler in _REPORT_HANDLERS.items():
        expected_cols = metadata_columns.get(slug, [])
        res = handler(db, cid, None)
        assert res is not _REPORT_FAILED, f"Report {slug} execution failed"
        assert isinstance(res, list), f"Report {slug} did not return list"

        if len(res) > 0:
            first_row = res[0]
            assert isinstance(first_row, dict), f"Report {slug} row is not dict: {first_row}"
            # Check row keys match expected columns
            actual_keys = list(first_row.keys())
            if expected_cols:
                assert actual_keys == expected_cols, (
                    f"Report '{slug}' column keys do not match REPORT_METADATA!\n"
                    f"Expected: {expected_cols}\n"
                    f"Actual:   {actual_keys}"
                )

        # 3. Test tenant isolation: query with other company should not see this company's data
        res_other = handler(db, cid_other, None)
        assert res_other is not _REPORT_FAILED
        if slug in ["cost-code-expense-analysis", "monthly-pl", "lead-status-funnel"]:
            continue  # summary chart markers
        # For data tables, other company must return empty
        assert len(res_other) == 0, f"Tenant leak in {slug}: other company saw {len(res_other)} rows!"
