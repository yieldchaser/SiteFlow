"""Regression tests for PROMPT_9 (Theme E) domain/formula fixes:
E1 billing TDS/Retention on GST-exclusive base, E2 payroll approved-leave days,
E3 leave FK + name collision, E4 BI budget-variance crash + labour/equipment,
E5 analytics completed_area fallback removed, E6 analytics on-time definition,
E7 Tally durable per-company voucher sequence.

NOTE: the coverage suite shares one session-scoped SQLite DB; users.email /
users.mobile are UNIQUE, so every tenant identity is suffixed with a per-module
random tag to avoid collisions with other test modules.
"""
import datetime
import uuid
from datetime import timezone
from decimal import Decimal

from app import models

_SUFFIX = uuid.uuid4().hex[:8]


def _mob(tag: int) -> str:
    return f"+9188{_SUFFIX}{tag:02d}"


def _mail(tag: int) -> str:
    return f"dom-{tag}-{_SUFFIX}@test.com"


def _utc(y, m, d, h=0, mi=0):
    return datetime.datetime(y, m, d, h, mi, tzinfo=timezone.utc)


def _mk_project(db, comp):
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="Proj", code="PRJ-1", status="Ongoing",
        state="Maharashtra",
    )
    db.add(project)
    db.commit()
    return project


# ── E1: TDS computed on GST-exclusive subtotal (both deduction-order paths) ──
def test_bill_tds_on_gst_exclusive_base_both_paths(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="E1", user_name="UE1", mobile=_mob(20), email=_mail(20))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    def make(pre_tax):
        r = client.post(
            "/apis/v3/billing/bills",
            json={
                "company_id": str(comp.id),
                "project_id": str(project.id),
                "party_company_user_id": str(team.id),
                "invoice_number": f"INV-E1-{pre_tax}",
                "invoice_date": "2026-01-01T00:00:00",
                "invoice_type": "purchase",
                "subtotal": 1000.0,
                "gst_pct": 18.0,
                "deductions": [{"deduction_type": "TDS", "percentage": 10.0, "amount": 0.0}],
                "pre_tax_deductions": pre_tax,
            },
            headers=hdr,
        )
        assert r.status_code == 201, r.text
        return r.json()

    # Post-Tax presentation (pre_tax_deductions=False): TDS on 1000 = 100,
    # GST on 1000 = 180, total = 1000 - 100 + 180 = 1080.
    r_false = make(False)
    tds_false = r_false["deductions"][0]["amount"]
    assert tds_false == 100.0, tds_false
    assert r_false["gst_amount"] == 180.0
    assert r_false["total_payable"] == 1080.0

    # Pre-Tax presentation (pre_tax_deductions=True): TDS on 1000 = 100 (same
    # GST-exclusive base), GST on (1000 - 100) = 162, total = 1062.
    r_true = make(True)
    tds_true = r_true["deductions"][0]["amount"]
    assert tds_true == 100.0, tds_true
    assert r_true["gst_amount"] == 162.0
    assert r_true["total_payable"] == 1062.0


# ── E2: payroll adds approved paid-leave days to days_present ───────────────
def test_payroll_includes_approved_leave_days(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="E2", user_name="UE2", mobile=_mob(21), email=_mail(21))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, name="Emp E2",
        status="active", basic_salary=1000.0, hra=0.0, other_allowances=0.0,
        pf_employee_pct=0.0, pf_employer_pct=0.0, esi_employee_pct=0.0,
        esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False,
    )
    db.add(emp)
    db.commit()

    for d in (3, 8):
        db.add(models.AttendanceLog(
            id=uuid.uuid4(), employee_id=emp.id, project_id=project.id,
            attendance_date=_utc(2026, 1, d, 9), status="Present",
        ))
    db.add(models.LeaveRequest(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, employee_id=emp.id,
        employee_name=emp.name, leave_type="Casual", start_date=_utc(2026, 1, 10),
        end_date=_utc(2026, 1, 15), days_count=3.0, status="Approved",
    ))
    db.commit()

    r = client.post(
        "/apis/v3/hr/payroll/run",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "payroll_month": "2026-01", "days_in_month": 30,
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    slip = next(p for p in r.json()["payslips"] if p["employee_id"] == str(emp.id))
    # 2 real punches + 3 approved paid-leave days = 5.
    assert slip["days_present"] == 5.0


# ── E3: same-name employees no longer merge leave once employee_id is set ────
def test_leave_balances_fk_path_not_merged(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E3a", user_name="UE3a", mobile=_mob(22), email=_mail(22))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    e1 = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
                              name="Same Name", status="active")
    e2 = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
                              name="Same Name", status="active")
    db.add_all([e1, e2])
    db.commit()

    db.add(models.LeaveRequest(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, employee_id=e1.id,
        employee_name="Same Name", leave_type="Casual", start_date=_utc(2026, 1, 1),
        end_date=_utc(2026, 1, 2), days_count=2.0, status="Approved"))
    db.add(models.LeaveRequest(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, employee_id=e2.id,
        employee_name="Same Name", leave_type="Casual", start_date=_utc(2026, 1, 1),
        end_date=_utc(2026, 1, 2), days_count=5.0, status="Approved"))
    db.commit()

    r = client.get(f"/apis/v3/hr/leave-balances/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    by_emp = {str(e["employee_id"]): e for e in r.json()["employees"]}
    assert by_emp[str(e1.id)]["casual"]["used"] == 2.0
    assert by_emp[str(e2.id)]["casual"]["used"] == 5.0


def test_leave_balances_legacy_name_fallback(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E3b", user_name="UE3b", mobile=_mob(23), email=_mail(23))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    e1 = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
                              name="Same Name", status="active")
    e2 = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
                              name="Same Name", status="active")
    db.add_all([e1, e2])
    db.commit()

    # Legacy rows: employee_id NULL, only employee_name (used before the FK existed).
    db.add(models.LeaveRequest(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, employee_id=None,
        employee_name="Same Name", leave_type="Casual", start_date=_utc(2026, 1, 1),
        end_date=_utc(2026, 1, 2), days_count=2.0, status="Approved"))
    db.add(models.LeaveRequest(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, employee_id=None,
        employee_name="Same Name", leave_type="Casual", start_date=_utc(2026, 1, 1),
        end_date=_utc(2026, 1, 2), days_count=5.0, status="Approved"))
    db.commit()

    r = client.get(f"/apis/v3/hr/leave-balances/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    # Legacy name-fallback: usage still matched by name and therefore merged.
    for e in r.json()["employees"]:
        assert e["casual"]["used"] == 7.0


# ── E4: budget-variance feed no longer 500s; includes labour/equipment ──────
def test_budget_variance_feed_live_with_actuals(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E4", user_name="UE4", mobile=_mob(24), email=_mail(24))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    db.add(models.ProjectBudget(
        id=uuid.uuid4(), project_id=project.id, material_budget=0, labour_budget=0,
        subcon_budget=0, equipment_budget=0))
    db.add(models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=user.id, invoice_number="MAT", invoice_date=_utc(2026, 1, 1),
        invoice_type="purchase", subtotal=1000.0, total_payable=1000.0))
    db.add(models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=user.id, invoice_number="SUB", invoice_date=_utc(2026, 1, 1),
        invoice_type="subcon", subtotal=500.0, total_payable=500.0))

    run = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
                            payroll_month="2026-01", status="finalized")
    db.add(run)
    db.flush()
    db.add(models.PayrollLineItem(
        id=uuid.uuid4(), payroll_run_id=run.id, employee_id=user.id, days_present=10,
        days_in_month=30, gross_salary=2000.0, basic=0.0, hra=0.0, other_allowances=0.0,
        overtime_amount=0.0, pf_employee=0.0, pf_employer=0.0, esi_employee=0.0,
        esi_employer=0.0, tds=0.0, advance_recovery=0.0, other_deductions=0.0,
        total_deductions=0.0, net_payable=Decimal("2000")))

    eq = models.Equipment(id=uuid.uuid4(), company_id=comp.id, name="Exc", code="X",
                          category="Plant", ownership_type="own", status="active", hourly_rate=10.0)
    db.add(eq)
    db.flush()
    db.add(models.EquipmentDeployment(
        id=uuid.uuid4(), equipment_id=eq.id, project_id=project.id,
        start_date=_utc(2026, 1, 1, 0), end_date=_utc(2026, 1, 1, 10)))
    db.add(models.FuelLog(
        id=uuid.uuid4(), equipment_id=eq.id, project_id=project.id, logged_date=_utc(2026, 1, 1),
        liters=5.0, cost_per_liter=10.0, total_cost=50.0))
    db.commit()

    # Create a BI API key (end-to-end) and call the feed live.
    k = client.post(
        f"/apis/v3/integrations/bi/companies/{comp.id}/keys",
        json={"label": "test"}, headers=hdr)
    assert k.status_code == 200, k.text
    raw_key = k.json()["key"]

    r = client.get(
        f"/apis/v3/integrations/bi/feed/{comp.id}/budget-variance?fmt=json",
        headers={"X-API-Key": raw_key})
    assert r.status_code == 200, r.text
    row = r.json()[0]
    assert row["material_actual"] == 1000.0
    assert row["subcon_actual"] == 500.0
    assert row["labour_actual"] == 2000.0
    assert row["equipment_actual"] == 150.0  # 10h * 10 + 50 fuel
    assert row["total_actual"] == 3650.0


# ── E5: analytics completed_area is 0 when nothing is completed ─────────────
def test_analytics_completed_area_zero_with_no_completed_task(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E5", user_name="UE5", mobile=_mob(25), email=_mail(25))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    boq = models.BOQItem(id=uuid.uuid4(), project_id=project.id, section_name="S",
                         item_name="Area", unit="m2", quantity=100.0)
    db.add(boq)
    db.flush()
    db.add(models.Task(
        id=uuid.uuid4(), project_id=project.id, name="T", status="in_progress",
        duration_days=5, start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 10),
        boq_item_id=boq.id))
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["labour_productivity"]["completed_area_m2"] == 0.0


# ── E6: on-time only counts paid bills with a real due date ─────────────────
def test_analytics_on_time_only_paid_with_due_date(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="E6", user_name="UE6", mobile=_mob(26), email=_mail(26))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    db.add(models.WorkOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        subcontractor_id=team.id, wo_number="WO1", wo_date=_utc(2026, 1, 1), status="active"))

    base = dict(company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
                invoice_type="subcon", subtotal=100.0, total_payable=100.0)
    bills = [
        # Paid, due in future -> on-time
        models.Bill(id=uuid.uuid4(), invoice_number="B1", invoice_date=_utc(2026, 1, 1),
                    status="Paid", due_date=_utc(2026, 12, 31), **base),
        # Paid, due in past -> late
        models.Bill(id=uuid.uuid4(), invoice_number="B2", invoice_date=_utc(2026, 1, 1),
                    status="Paid", due_date=_utc(2026, 1, 1), **base),
        # Unpaid, due in future -> excluded from denominator
        models.Bill(id=uuid.uuid4(), invoice_number="B3", invoice_date=_utc(2026, 1, 1),
                    status="Unpaid", due_date=_utc(2026, 12, 31), **base),
        # Paid, no due date -> excluded from denominator
        models.Bill(id=uuid.uuid4(), invoice_number="B4", invoice_date=_utc(2026, 1, 1),
                    status="Paid", due_date=None, **base),
    ]
    db.add_all(bills)
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    sc = next(s for s in r.json()["subcontractor_scorecard"] if s["subcontractor_id"] == str(team.id))
    assert sc["bill_count"] == 4
    assert sc["on_time_rate"] == 50.0  # 1 on-time of 2 in-scope (paid + due date)
    assert sc["late_bills"] == 1


# ── E7: Tally voucher numbers never repeat across partial syncs ─────────────
def test_tally_voucher_sequence_durable(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="E7", user_name="UE7", mobile=_mob(27), email=_mail(27))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    conn = models.TallyConnection(
        id=uuid.uuid4(), company_id=comp.id, tally_company_name="E7 Co",
        registered_mobile="9999999999", sync_window_start_date=_utc(2025, 1, 1),
        voucher_number_template="SF-{year}-{number}")
    db.add(conn)
    db.commit()

    def add_bill(n):
        b = models.Bill(
            id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
            party_company_user_id=team.id, invoice_number=n, invoice_date=_utc(2026, 1, 1),
            invoice_type="purchase", subtotal=100.0, total_payable=100.0,
            tally_synced=False)
        db.add(b)
        db.commit()
        return b

    b1, b2, b3 = add_bill("num-101"), add_bill("num-102"), add_bill("num-103")
    db.expire_all()

    def conn_seq():
        db.expire_all()
        return db.query(models.TallyConnection).filter_by(id=conn.id).first().last_voucher_seq

    # R2-369: export HOLDS the sequence — it renders preview numbers from
    # last_voucher_seq without consuming them, so the counter stays at its
    # initial value across any number of downloads.
    url = f"/apis/v3/tally/export?company_id={comp.id}"
    ex1 = client.get(url, headers=hdr)
    assert ex1.status_code == 200, ex1.text
    assert conn_seq() == 0

    # Re-downloading the same queue is byte-identical and consumes nothing:
    # the held sequence keeps every preview number stable until confirmation.
    ex1b = client.get(url, headers=hdr)
    assert ex1b.status_code == 200, ex1b.text
    assert ex1b.content == ex1.content
    assert conn_seq() == 0

    # /pending is a read-only preview and must NOT consume the sequence either,
    # and it renders the exact numbers the export carries on every call.
    for _ in range(3):
        r = client.get(f"/apis/v3/tally/pending?company_id={comp.id}", headers=hdr)
        assert r.status_code == 200, r.text
        assert len(r.json()["vouchers"]) == 3
        assert {v["number"] for v in r.json()["vouchers"]} == {"num-101", "num-102", "num-103"}
    assert conn_seq() == 0

    # Confirming 2 of the original bills is what consumes their numbers: the
    # counter jumps past the confirmed count even though exports never touched it.
    ms = client.post(
        "/apis/v3/tally/mark-synced",
        json={"bill_ids": [str(b1.id), str(b2.id)], "payment_ids": []}, headers=hdr)
    assert ms.status_code == 200, ms.text
    assert ms.json()["marked_bills"] == 2
    assert conn_seq() == 2

    add_bill("num-104")
    add_bill("num-105")
    db.expire_all()

    # /pending now shows 3 unsynced vouchers (remaining original #3 + 2 new).
    rp = client.get(f"/apis/v3/tally/pending?company_id={comp.id}", headers=hdr)
    assert rp.status_code == 200, rp.text
    assert len(rp.json()["vouchers"]) == 3

    # Second export is still read-only: the high-water mark stays at 2, so the
    # fresh vouchers number from 3 onward and never repeat the confirmed 1..2.
    ex2 = client.get(url, headers=hdr)
    assert ex2.status_code == 200, ex2.text
    assert conn_seq() == 2

    ex2b = client.get(url, headers=hdr)
    assert ex2b.status_code == 200, ex2b.text
    assert ex2b.content == ex2.content
    assert conn_seq() == 2


def test_analytics_wastage_suppressed_without_consumption(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E8", user_name="UE8", mobile=_mob(28), email=_mail(28))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    po = models.PurchaseOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        po_number="PO-1", po_date=_utc(2026, 1, 1), status="received",
        gross_amount=Decimal("100.00"), tax_amount=Decimal("0.00"),
        total_amount=Decimal("100.00"))
    db.add(po)
    db.flush()
    db.add(models.PurchaseOrderItem(
        id=uuid.uuid4(), po_id=po.id, material_name="Cement",
        quantity=Decimal("100"), unit="bags", rate=Decimal("10.00"),
        tax_pct=Decimal("0.00")))
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    mw = r.json()["material_wastage"]
    assert mw["ordered_qty"] == 100.0
    assert mw["consumed_qty"] == 0.0
    assert mw["wastage_pct"] is None
    assert mw["wastage_qty"] == 0.0


def test_project_progress_reads_task_progress(client, db, make_tenant, auth_headers, monkeypatch):
    comp, user, _ = make_tenant(company_name="E9a", user_name="UE9a", mobile=_mob(29), email=_mail(29))
    hdr = auth_headers(user, comp)
    p1 = _mk_project(db, comp)

    db.add(models.Task(
        id=uuid.uuid4(), project_id=p1.id, name="T1", status="not_started",
        duration_days=10, progress=Decimal("75"),
        start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 11)))
    db.commit()

    r = client.get(f"/apis/v3/projects/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    by_id = {str(p["id"]): p for p in r.json()}
    assert by_id[str(p1.id)]["progress"] == 75.0

    import types
    from app.routers import projects as projects_mod
    class _StubTask:
        def __init__(self, duration_days, progress, status):
            self.duration_days = duration_days
            self.progress = progress
            self.status = status
    stub_db = types.SimpleNamespace(query=lambda m: types.SimpleNamespace(
        filter=lambda *a, **k: types.SimpleNamespace(
            all=lambda: [_StubTask(10, None, "completed")])))
    assert projects_mod._project_progress(stub_db, p1.id) == 100.0


def test_analytics_spend_excludes_sales(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E10", user_name="UE10", mobile=_mob(31), email=_mail(31))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    base = dict(company_id=comp.id, project_id=project.id, party_company_user_id=user.id,
                invoice_date=_utc(2026, 1, 1))
    db.add_all([
        models.Bill(id=uuid.uuid4(), invoice_number="SALE-1", invoice_type="sale",
                    subtotal=Decimal("118000"), total_payable=Decimal("118000"), **base),
        models.Bill(id=uuid.uuid4(), invoice_number="PUR-1", invoice_type="purchase",
                    subtotal=Decimal("23600"), total_payable=Decimal("23600"), **base),
    ])
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["projects"][0]["spend"] == 23600.0
    assert data["total_spend"] == 23600.0
    assert data["total_spend"] != 141600.0
    jan_burn = next(b for b in data["budget_burn_series"] if b["label"].startswith("Jan"))
    assert jan_burn["spend"] == 23600.0
    assert jan_burn["spend"] != 141600.0


def test_task_status_derives_from_progress(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E11", user_name="UE11", mobile=_mob(32), email=_mail(32))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    task = models.Task(
        id=uuid.uuid4(), project_id=project.id, name="T", status="not_started",
        duration_days=10, progress=Decimal("0"),
        start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 11))
    db.add(task)
    db.commit()

    def put(body):
        r = client.put(f"/apis/v3/planning/tasks/{task.id}", json=body, headers=hdr)
        assert r.status_code == 200, r.text

    def status_of():
        r = client.get(f"/apis/v3/planning/tasks?project_id={project.id}", headers=hdr)
        assert r.status_code == 200, r.text
        return next(t for t in r.json() if t["id"] == str(task.id))["status"]

    put({"progress": 75})
    assert status_of() == "in_progress"
    put({"progress": 100})
    assert status_of() == "completed"
    put({"progress": 0})
    assert status_of() == "not_started"
    put({"progress": 50, "status": "completed"})
    assert status_of() == "completed"


def test_zoho_duplicate_vendor_searches_all_contact_types(monkeypatch):
    import requests
    from app.routers.zoho_books import _find_or_create_vendor

    class _Resp:
        def __init__(self, status_code, text, data=None):
            self.status_code = status_code
            self.text = text
            self._data = data

        def json(self):
            return self._data

    get_params = []

    def fake_get(url, headers=None, params=None, timeout=None):
        get_params.append(params)
        if params and "contact_type" in params:
            return _Resp(200, "", {"contacts": []})
        return _Resp(200, "", {"contacts": [{"contact_id": "ZOHO-999"}]})

    def fake_post(url, headers=None, params=None, json=None, timeout=None):
        return _Resp(400, '{"code": 3062, "message": "a vendor with this name already exists"}')

    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(requests, "post", fake_post)

    contact_id = _find_or_create_vendor("tok", "org", name="Acme", email=None, phone=None, gstin=None)
    assert contact_id == "ZOHO-999"
    assert any(p is not None and "contact_type" not in p for p in get_params)


def test_committed_costs_labour_and_equipment_actuals(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E12", user_name="UE12", mobile=_mob(33), email=_mail(33))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    run = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
                            payroll_month="2026-01", status="finalized")
    db.add(run)
    db.flush()
    db.add(models.PayrollLineItem(
        id=uuid.uuid4(), payroll_run_id=run.id, employee_id=user.id, days_present=10,
        days_in_month=30, gross_salary=Decimal("5000"), basic=Decimal("5000"), hra=0.0, other_allowances=0.0,
        overtime_amount=0.0, pf_employee=Decimal("600"), pf_employer=0.0, esi_employee=0.0,
        esi_employer=0.0, tds=0.0, advance_recovery=0.0, other_deductions=0.0,
        total_deductions=Decimal("600"), net_payable=Decimal("4400")))
    db.add(models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=user.id, invoice_number="EQ-1", invoice_date=_utc(2026, 1, 1),
        invoice_type="equipment", subtotal=Decimal("3000"), total_payable=Decimal("3000"),
        approval_flag="approved"))
    db.commit()

    r = client.get(f"/apis/v3/budget/committed/{project.id}", headers=hdr)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["labour_actual"] == 5000.0
    assert data["equipment_actual"] == 3000.0


def test_punch_location_verified_derived_from_geofence(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E13", user_name="UE13", mobile=_mob(34), email=_mail(34))
    hdr = auth_headers(user, comp)
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="Geofence Proj", code="GF-1",
        status="Ongoing", location="12.9716,77.5946", attendance_radius_meters=500,
    )
    db.add(project)
    db.commit()

    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, name="Emp E13",
        status="active", basic_salary=1000.0, hra=0.0, other_allowances=0.0,
        pf_employee_pct=0.0, pf_employer_pct=0.0, esi_employee_pct=0.0,
        esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False,
    )
    emp2 = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, name="Emp2 E13",
        status="active", basic_salary=1000.0, hra=0.0, other_allowances=0.0,
        pf_employee_pct=0.0, pf_employer_pct=0.0, esi_employee_pct=0.0,
        esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False,
    )
    db.add_all([emp, emp2])
    db.commit()

    inside = client.post(
        "/apis/v3/hr/attendance/punch",
        json={
            "employee_id": str(emp.id),
            "project_id": str(project.id),
            "lat": 12.9716, "lng": 77.5946,
            "punch_type": "in", "shift_multiplier": 1.0,
            "location_verified": False,
        },
        headers=hdr,
    )
    assert inside.status_code == 201, inside.text
    assert inside.json()["location_verified"] is True

    outside = client.post(
        "/apis/v3/hr/attendance/punch",
        json={
            "employee_id": str(emp2.id),
            "project_id": str(project.id),
            "lat": 28.6, "lng": 77.2,
            "punch_type": "in", "shift_multiplier": 1.0,
            "location_verified": True,
        },
        headers=hdr,
    )
    assert outside.status_code == 201, outside.text
    assert outside.json()["location_verified"] is False


def test_party_balance_nets_receivables_and_payables(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E14", user_name="UE14", mobile=_mob(35), email=_mail(35))
    hdr = auth_headers(user, comp)

    lp = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name="Party E14")
    db.add(lp)
    db.flush()
    team = models.CompanyTeam(
        id=uuid.uuid4(), company_id=comp.id, user_id=None,
        library_party_id=lp.id, priority_type="vendor",
    )
    db.add(team)
    db.flush()

    base = dict(company_id=comp.id, project_id=uuid.uuid4(), party_company_user_id=team.id,
                invoice_date=_utc(2026, 1, 1))
    db.add_all([
        models.Bill(id=uuid.uuid4(), invoice_number="SALE-14", invoice_type="sale",
                    subtotal=Decimal("118000"), total_payable=Decimal("118000"),
                    paid_amount=Decimal("40000"), **base),
        models.Bill(id=uuid.uuid4(), invoice_number="PUR-14A", invoice_type="purchase",
                    subtotal=Decimal("15000"), total_payable=Decimal("15000"), **base),
        models.Bill(id=uuid.uuid4(), invoice_number="PUR-14B", invoice_type="purchase",
                    subtotal=Decimal("8600"), total_payable=Decimal("8600"), **base),
    ])
    db.commit()

    r = client.get(f"/apis/v3/finance/parties/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    party = next(p for p in r.json() if p["id"] == str(lp.id))
    assert party["balance"] == 54400.0
    assert party["status"] == "To Receive"
    assert party["balance"] != -101600.0


def test_party_pid_generator_bumps_past_used_ids(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E15", user_name="UE15", mobile=_mob(36), email=_mail(36))
    hdr = auth_headers(user, comp)

    for pid in ("PID-1", "PID-2"):
        db.add(models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name=f"Party {pid}",
                                   party_id_custom=pid))
    db.add(models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name="Party Gap",
                               party_id_custom="PID-4"))
    db.commit()

    r = client.post(
        "/apis/v3/library/parties",
        json={"company_id": str(comp.id), "name": "Party New"},
        headers=hdr,
    )
    assert r.status_code == 200, r.text
    assert r.json()["party_id_custom"] == "PID-5"

    all_pids = [p.party_id_custom for p in db.query(models.LibraryParty)
                .filter(models.LibraryParty.company_id == comp.id).all()]
    assert all_pids.count("PID-5") == 1



def test_planning_discriminator_fields_validated(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E40", user_name="UE40", mobile=_mob(41), email=_mail(41))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    base = dict(project_id=str(project.id), name="M", milestone_date="2026-01-01T00:00:00")
    r = client.post("/apis/v3/planning/milestones", json={**base, "type": "bogus", "status": "upcoming"}, headers=hdr)
    assert r.status_code == 422
    r = client.post("/apis/v3/planning/milestones", json={**base, "type": "start", "status": "bogus"}, headers=hdr)
    assert r.status_code == 422
    r = client.post("/apis/v3/planning/milestones", json={**base, "type": "payment", "status": "achieved"}, headers=hdr)
    assert r.status_code == 201, r.text

    task_a = models.Task(
        id=uuid.uuid4(), project_id=project.id, name="A", status="not_started",
        duration_days=2, progress=Decimal("0"),
        start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 3))
    task_b = models.Task(
        id=uuid.uuid4(), project_id=project.id, name="B", status="not_started",
        duration_days=2, progress=Decimal("0"),
        start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 3))
    db.add_all([task_a, task_b])
    db.commit()

    r = client.post(
        f"/apis/v3/planning/tasks/{task_b.id}/predecessors",
        json={"predecessor_id": str(task_a.id), "type": "start_to_start"},
        headers=hdr,
    )
    assert r.status_code == 422
    r = client.post(
        f"/apis/v3/planning/tasks/{task_b.id}/predecessors",
        json={"predecessor_id": str(task_a.id), "type": "finish_to_start"},
        headers=hdr,
    )
    assert r.status_code == 201, r.text

# -- W11 R2-255: negative task duration rejected ------------------------------

def test_task_duration_bounds_enforced(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E41", user_name="UE41", mobile=_mob(42), email=_mail(42))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    r = client.post(
        "/apis/v3/planning/tasks",
        json={
            "project_id": str(project.id), "name": "Neg", "duration_days": -3,
            "start_date": "2026-01-01T00:00:00",
        },
        headers=hdr,
    )
    assert r.status_code == 422

    task = models.Task(
        id=uuid.uuid4(), project_id=project.id, name="T", status="not_started",
        duration_days=3, progress=Decimal("0"),
        start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 4))
    db.add(task)
    db.commit()

    r = client.put(f"/apis/v3/planning/tasks/{task.id}", json={"duration_days": -3}, headers=hdr)
    assert r.status_code == 422

# -- W11 R2-461: task end_date is inclusive of the start day ------------------

def test_task_end_date_inclusive_of_start_day(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E42", user_name="UE42", mobile=_mob(45), email=_mail(45))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    r = client.post(
        "/apis/v3/planning/tasks",
        json={
            "project_id": str(project.id), "name": "FiveDay", "duration_days": 5,
            "start_date": "2026-01-01T00:00:00",
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    task = r.json()
    assert task["end_date"].startswith("2026-01-05"), task["end_date"]
    assert task["baseline_end"].startswith("2026-01-05"), task["baseline_end"]

    r = client.put(f"/apis/v3/planning/tasks/{task['id']}", json={"duration_days": 3}, headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["end_date"].startswith("2026-01-03"), r.json()["end_date"]

    task_b = models.Task(
        id=uuid.uuid4(), project_id=project.id, name="B", status="not_started",
        duration_days=3, progress=Decimal("0"),
        start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 3))
    db.add(task_b)
    db.commit()

    r = client.post(
        f"/apis/v3/planning/tasks/{task_b.id}/predecessors",
        json={"predecessor_id": task["id"]},
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    r = client.get(f"/apis/v3/planning/tasks?project_id={project.id}", headers=hdr)
    assert r.status_code == 200, r.text
    b = next(t for t in r.json() if t["id"] == str(task_b.id))
    assert b["start_date"].startswith("2026-01-03"), b["start_date"]
    assert b["end_date"].startswith("2026-01-05"), b["end_date"]

# -- W11 R2-566: task create honors the client's status -----------------------

def test_task_create_honors_client_status(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="E43", user_name="UE43", mobile=_mob(46), email=_mail(46))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    r = client.post(
        "/apis/v3/planning/tasks",
        json={
            "project_id": str(project.id), "name": "Pending", "duration_days": 2,
            "start_date": "2026-01-01T00:00:00", "status": "pending",
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "not_started", r.json()["status"]  # pending is the old word for not started

    r = client.post(
        "/apis/v3/planning/tasks",
        json={
            "project_id": str(project.id), "name": "Default", "duration_days": 2,
            "start_date": "2026-01-01T00:00:00",
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "not_started", r.json()["status"]

# -- W15 R2-277: drawing pins bounded and actor-derived -----------------------

def test_drawing_pin_bounds_and_actor_derived(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="E44", user_name="UE44", mobile=_mob(47), email=_mail(47))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    drawing = models.Drawing(id=uuid.uuid4(), project_id=project.id, name="D", category="2D Layout")
    db.add(drawing)
    db.commit()
    revision = models.DrawingRevision(
        id=uuid.uuid4(), drawing_id=drawing.id, version_code="V1",
        file_url="/f.pdf", approval_status="pending",
    )
    db.add(revision)
    db.commit()

    r = client.post(
        f"/apis/v3/drawings/revisions/{revision.id}/pins",
        json={"x_coordinate": 99999, "y_coordinate": 10, "comment": "ZZ off"},
        headers=hdr,
    )
    assert r.status_code == 422

    r = client.post(
        f"/apis/v3/drawings/revisions/{revision.id}/pins",
        json={"x_coordinate": 10, "y_coordinate": -5, "comment": "ZZ neg"},
        headers=hdr,
    )
    assert r.status_code == 422

    r = client.post(
        f"/apis/v3/drawings/revisions/{revision.id}/pins",
        json={"x_coordinate": 10, "y_coordinate": 10, "comment": "ZZ ok", "created_by": "not-a-uuid"},
        headers=hdr,
    )
    assert r.status_code == 200, r.text
    assert r.json()["created_by"] == str(team.id)

# -- W15 R2-373: indent approval guard, approver and rejection endpoint --------

def test_indent_approval_guard_approver_and_rejection(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="E45", user_name="UE45", mobile=_mob(48), email=_mail(48))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    indent = models.MaterialIndent(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        requested_by=team.id, indent_number="IND-W15-1", status="pending",
    )
    db.add(indent)
    db.commit()

    r = client.post(f"/apis/v3/procurement/indents/{indent.id}/approve", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "approved"
    assert body["approved_by"] == str(team.id)
    assert body["approved_at"] is not None

    r = client.post(f"/apis/v3/procurement/indents/{indent.id}/approve", headers=hdr)
    assert r.status_code == 400

    r = client.post(f"/apis/v3/procurement/indents/{indent.id}/reject", headers=hdr)
    assert r.status_code == 400

    indent2 = models.MaterialIndent(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        requested_by=team.id, indent_number="IND-W15-2", status="pending",
    )
    db.add(indent2)
    db.commit()

    r = client.post(f"/apis/v3/procurement/indents/{indent2.id}/reject", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rejected"

# -- W15 R2-411: tally export uses Alter ledger masters and carries reference --

def test_tally_envelope_ledger_alter_and_reference():
    from app.tally_xml import build_tally_envelope

    xml = build_tally_envelope(
        "TestCo",
        [{
            "vchtype": "Purchase",
            "voucher_type_name": "Purchase",
            "voucher_number": "ONS-2026-1",
            "reference": "INV-42",
            "date": "20260801",
            "party_ledger_name": "Vendor Ledger",
            "narration": "SiteFlow purchase invoice INV-42.",
            "entries": [
                {"ledger": "Purchase A/c", "amount": 100.0, "debit": True, "ledger_type": "purchase"},
                {"ledger": "Vendor Ledger", "amount": 100.0, "debit": False, "ledger_type": "party_creditor"},
            ],
        }],
        auto_create=True,
    )
    assert 'ACTION="Alter"' in xml
    assert "<ALTERID>" in xml
    assert "<REFERENCE>INV-42</REFERENCE>" in xml

# -- W17 R2-578: send_message stamps the real sender, never the client --------

def test_chat_message_sender_stamped_not_client_supplied(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="E60", user_name="UE60", mobile=_mob(61), email=_mail(61))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    r = client.post(
        "/apis/v3/chat/groups",
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "name": "ZZ W17 Stamp",
            "group_type": "general",
            "created_by": str(user.id),
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    group_id = r.json()["id"]

    r = client.post(
        "/apis/v3/chat/messages",
        json={
            "group_id": group_id,
            "message_text": "forged sender",
            "user_id": str(uuid.uuid4()),
            "user_name": "Not Me",
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["user_id"] == str(team.id)
    assert body["user_name"] == user.name

    r = client.get(f"/apis/v3/chat/messages/{group_id}", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()[0]["user_name"] == user.name

# -- W17 R2-147: message poll cursor, capped load, GROUP BY member_count ------

def test_chat_message_poll_cursor_and_capped_load(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="E61", user_name="UE61", mobile=_mob(62), email=_mail(62))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    r = client.post(
        "/apis/v3/chat/groups",
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "name": "ZZ W17 Cursor",
            "group_type": "general",
            "created_by": str(user.id),
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    group_id = r.json()["id"]

    sent_ids = []
    for text in ["one", "two", "three"]:
        r = client.post(
            "/apis/v3/chat/messages",
            json={"group_id": group_id, "message_text": text},
            headers=hdr,
        )
        assert r.status_code == 201, r.text
        sent_ids.append(r.json()["id"])

    r = client.get(f"/apis/v3/chat/messages/{group_id}", headers=hdr)
    assert r.status_code == 200, r.text
    assert {m["message_text"] for m in r.json()} == {"one", "two", "three"}

    r = client.get(f"/apis/v3/chat/messages/{group_id}?since_id={sent_ids[-1]}", headers=hdr)
    assert r.status_code == 200, r.text
    poll_ids = [m["id"] for m in r.json()]
    assert sent_ids[-1] not in poll_ids

    r = client.post(
        "/apis/v3/chat/messages",
        json={"group_id": group_id, "message_text": "four"},
        headers=hdr,
    )
    assert r.status_code == 201, r.text

    r = client.get(f"/apis/v3/chat/messages/{group_id}?since_id={sent_ids[-1]}", headers=hdr)
    assert r.status_code == 200, r.text
    after = r.json()
    assert any(m["message_text"] == "four" for m in after)
    assert len(after) == len({m["id"] for m in after})

    r = client.get(f"/apis/v3/chat/messages/{group_id}?limit=1", headers=hdr)
    assert r.status_code == 200, r.text
    assert len(r.json()) == 1

    r = client.get(f"/apis/v3/chat/messages/{group_id}?limit=0", headers=hdr)
    assert r.status_code == 422

    r = client.post(
        "/apis/v3/chat/groups",
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "name": "ZZ W17 Empty",
            "group_type": "general",
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text

    r = client.get(f"/apis/v3/chat/groups/{project.id}", headers=hdr)
    assert r.status_code == 200, r.text
    by_id = {g["id"]: g["member_count"] for g in r.json()}
    assert by_id[group_id] == 1
    assert all(mc >= 1 for mc in by_id.values())


# ── W83 / R2-206: wastage_type enumerated; reporter + value server-derived ──
def test_wastage_derives_reporter_and_value_and_rejects_unknown_type(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="W83", user_name="UW83", mobile=_mob(71), email=_mail(71))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    po = models.PurchaseOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        po_number="PO-W83", po_date=_utc(2026, 1, 1), status="received",
        gross_amount=Decimal("8200.00"), tax_amount=Decimal("0.00"),
        total_amount=Decimal("8200.00"))
    db.add(po)
    db.flush()
    db.add(models.PurchaseOrderItem(
        id=uuid.uuid4(), po_id=po.id, material_name="Cement",
        quantity=Decimal("20"), unit="bags", rate=Decimal("410.00"),
        tax_pct=Decimal("0.00")))
    db.add(models.WarehouseInventory(
        id=uuid.uuid4(), project_id=project.id, material_name="Cement",
        on_hand_qty=Decimal("22"), reserved_qty=Decimal("0"), unit="bags"))
    db.commit()

    bad = client.post(
        "/apis/v3/wastage",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "material_name": "Cement", "wastage_type": "NOT_A_REAL_TYPE",
            "quantity": 20, "unit": "bags",
        },
        headers=hdr,
    )
    assert bad.status_code == 422, bad.text

    r = client.post(
        "/apis/v3/wastage",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "material_name": "Cement", "wastage_type": "damaged",
            "quantity": 20, "unit": "bags",
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["estimated_value"] == 8200.0
    assert body["reported_by"] == str(team.id)

    r2 = client.post(
        "/apis/v3/wastage",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "material_name": "Cement", "wastage_type": "theft",
            "quantity": 2, "unit": "bags",
            "estimated_value": 999.0, "estimated_value_override": True,
        },
        headers=hdr,
    )
    assert r2.status_code == 201, r2.text
    assert r2.json()["estimated_value"] == 999.0
    assert r2.json()["reported_by"] == str(team.id)


# ── W83 / R2-207: recipe wastage_pct is applied to batch consumption ──────
def test_production_batch_applies_recipe_wastage_pct(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="W83b", user_name="UW83b", mobile=_mob(72), email=_mail(72))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    db.add(models.WarehouseInventory(
        id=uuid.uuid4(), project_id=project.id, material_name="Cement",
        on_hand_qty=Decimal("200"), reserved_qty=Decimal("0"), unit="bags"))
    db.commit()

    r = client.post(
        "/apis/v3/production/recipes",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "recipe_code": "REC-W83", "product_name": "M25", "mix_type": "Site Mix",
            "unit": "m3", "target_output_qty": 1.0, "wastage_pct": 5.0,
            "materials": [{"material_name": "Cement", "planned_qty": 8, "unit": "bags", "is_optional": False}],
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    recipe = r.json()

    b = client.post(
        "/apis/v3/production/batches",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "recipe_id": recipe["id"], "batch_number": "B-W83",
            "actual_output_qty": 2.0, "status": "completed",
        },
        headers=hdr,
    )
    assert b.status_code == 201, b.text
    batch = b.json()
    cement = next(m for m in batch["materials"] if m["material_name"] == "Cement")
    assert abs(cement["actual_qty"] - 16.8) < 1e-9
    assert abs(batch["actual_material_qty"] - 16.8) < 1e-9

    inv = db.query(models.WarehouseInventory).filter(
        models.WarehouseInventory.project_id == project.id,
        models.WarehouseInventory.material_name == "Cement",
    ).first()
    assert float(inv.on_hand_qty) == 183.2


# -- W08 / R2-305: wastage reads the MaterialWastage log; stock gap separate --

def test_analytics_wastage_reads_records_and_keeps_negative_variance(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="H-R2305", user_name="U-H305", mobile=_mob(81), email=_mail(81))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    po = models.PurchaseOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        po_number="PO-R2305", po_date=_utc(2026, 1, 1), status="received",
        gross_amount=Decimal("1000.00"), tax_amount=Decimal("0.00"),
        total_amount=Decimal("1000.00"))
    db.add(po)
    db.flush()
    db.add(models.PurchaseOrderItem(
        id=uuid.uuid4(), po_id=po.id, material_name="Cement",
        quantity=Decimal("100"), unit="bags", rate=Decimal("10.00"),
        tax_pct=Decimal("0.00")))
    # 150 consumed against 100 ordered: the old formula clamped this to 0 waste.
    db.add(models.MaterialTransaction(
        id=uuid.uuid4(), project_id=project.id, material_name="Cement",
        qty=Decimal("150"), type="used", unit="bags"))
    db.add(models.MaterialWastage(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        material_name="Cement", wastage_type="damaged", quantity=Decimal("5"),
        unit="bags"))
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    mw = r.json()["material_wastage"]
    assert mw["wastage_qty"] == 5.0           # recorded wastage, not a stock gap
    assert mw["wastage_pct"] == 5.0           # 5 of 100 ordered
    assert mw["stock_variance_qty"] == -50.0  # over-consumption surfaced, never clamped


# -- W08 / R2-329: reconciliation computed per material and per unit ----------

def test_analytics_reconciliation_per_material_and_unit(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="H-R2329", user_name="U-H329", mobile=_mob(82), email=_mail(82))
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)

    po = models.PurchaseOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        po_number="PO-R2329", po_date=_utc(2026, 1, 1), status="received",
        gross_amount=Decimal("2000.00"), tax_amount=Decimal("0.00"),
        total_amount=Decimal("2000.00"))
    db.add(po)
    db.flush()
    db.add_all([
        models.PurchaseOrderItem(
            id=uuid.uuid4(), po_id=po.id, material_name="Cement",
            quantity=Decimal("100"), unit="bags", rate=Decimal("10.00"),
            tax_pct=Decimal("0.00")),
        models.PurchaseOrderItem(
            id=uuid.uuid4(), po_id=po.id, material_name="Steel",
            quantity=Decimal("10"), unit="tonnes", rate=Decimal("100.00"),
            tax_pct=Decimal("0.00")),
        # Cement over-consumed in bags; Steel fine in tonnes. One mixed-unit
        # scalar (110 ordered vs 152 consumed) cannot tell these apart.
        models.MaterialTransaction(
            id=uuid.uuid4(), project_id=project.id, material_name="Cement",
            qty=Decimal("150"), type="used", unit="bags"),
        models.MaterialTransaction(
            id=uuid.uuid4(), project_id=project.id, material_name="Steel",
            qty=Decimal("2"), type="used", unit="tonnes"),
    ])
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()["material_reconciliation"]
    cement = next(row for row in rows if row["material_name"] == "Cement")
    steel = next(row for row in rows if row["material_name"] == "Steel")
    assert cement["unit"] == "bags"
    assert cement["over_consumed"] is True
    assert cement["variance_qty"] == -50.0
    assert steel["unit"] == "tonnes"
    assert steel["over_consumed"] is False
    assert steel["variance_qty"] == 8.0



