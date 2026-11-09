# -*- coding: utf-8 -*-
"""
Phase 14 Integration Test -- Advanced Analytics Dashboard
Tests (isolated SQLite DB, port 8016):
  1. Seed a company with two projects and project budgets
  2. Seed tasks and BOQ items to drive S-curve and productivity metrics
  3. Seed attendance to compute labour days
  4. Seed procurement transactions to compute material wastage
  5. Seed subcontractor work orders, bills, and NCRs
  6. Fetch company analytics and assert key KPI calculations
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_ROOT = os.path.dirname(HERE)

import sys
import time
import uuid
import subprocess
import requests
from datetime import datetime

BASE = "http://127.0.0.1:8014/apis/v3"
DB_FILE = os.path.join(HERE, "test_phase14.db")


def start_server():
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite:///{DB_FILE}"
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "127.0.0.1", "--port", "8014", "--log-level", "error"],
        env=env,
        cwd=BACKEND_ROOT,
    )
    for _ in range(30):
        time.sleep(1)
        try:
            if requests.get("http://127.0.0.1:8014/").status_code == 200:
                return proc
        except Exception:
            pass
    proc.terminate()
    raise RuntimeError("Server failed to start within 30s")


def seed_db(company_obj, project_a_obj, project_b_obj):
    sys.path.append(BACKEND_ROOT)
    os.environ["DATABASE_URL"] = f"sqlite:///{DB_FILE}"

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    engine = create_engine(f"sqlite:///{DB_FILE}", connect_args={"check_same_thread": False})
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    from app import models

    models.Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    company = models.Company(id=company_obj, name="Analytics Build Co")
    db.add(company)
    db.commit()

    project_a = models.Project(id=project_a_obj, company_id=company.id, name="Alpha Tower", code="ALP-01")
    project_b = models.Project(id=project_b_obj, company_id=company.id, name="Harbor Plaza", code="HBR-02")
    db.add_all([project_a, project_b])
    db.commit()

    # All routers require auth (added after this script was written). A
    # dedicated caller user, distinct from the subcontractor/vendor party
    # records seeded further below.
    auth_user = models.User(id=uuid.uuid4(), name="Analytics Test User")
    db.add(auth_user)
    db.commit()
    db.add(models.CompanyTeam(
        id=uuid.uuid4(), company_id=company.id, user_id=auth_user.id, priority_type="employee"
    ))
    db.commit()

    db.add_all([
        models.ProjectBudget(
            project_id=project_a.id,
            material_budget=100000,
            labour_budget=50000,
            subcon_budget=25000,
            equipment_budget=25000,
        ),
        models.ProjectBudget(
            project_id=project_b.id,
            material_budget=80000,
            labour_budget=30000,
            subcon_budget=20000,
            equipment_budget=10000,
        ),
    ])
    db.commit()

    boq_a_1 = models.BOQItem(
        project_id=project_a.id,
        section_name="Civil",
        item_name="RCC slab area",
        unit="m2",
        quantity=120,
        rate=1500,
        amount=180000,
    )
    boq_a_2 = models.BOQItem(
        project_id=project_a.id,
        section_name="Civil",
        item_name="Beam area",
        unit="m2",
        quantity=180,
        rate=1200,
        amount=216000,
    )
    boq_a_3 = models.BOQItem(
        project_id=project_a.id,
        section_name="Finishes",
        item_name="Plaster area",
        unit="m2",
        quantity=90,
        rate=250,
        amount=22500,
    )
    boq_b_1 = models.BOQItem(
        project_id=project_b.id,
        section_name="Masonry",
        item_name="Blockwork area",
        unit="m2",
        quantity=70,
        rate=1100,
        amount=77000,
    )
    boq_b_2 = models.BOQItem(
        project_id=project_b.id,
        section_name="Finishes",
        item_name="Paint area",
        unit="m2",
        quantity=50,
        rate=300,
        amount=15000,
    )
    db.add_all([boq_a_1, boq_a_2, boq_a_3, boq_b_1, boq_b_2])
    db.commit()

    tasks = [
        models.Task(
            project_id=project_a.id,
            name="Foundation",
            duration_days=10,
            start_date=datetime(2026, 1, 1, 8, 0, 0),
            end_date=datetime(2026, 1, 11, 8, 0, 0),
            status="completed",
            priority="high",
            boq_item_id=boq_a_1.id,
        ),
        models.Task(
            project_id=project_a.id,
            name="Superstructure",
            duration_days=26,
            start_date=datetime(2026, 1, 12, 8, 0, 0),
            end_date=datetime(2026, 2, 7, 8, 0, 0),
            status="completed",
            priority="high",
            boq_item_id=boq_a_2.id,
        ),
        models.Task(
            project_id=project_a.id,
            name="Plaster",
            duration_days=14,
            start_date=datetime(2026, 2, 8, 8, 0, 0),
            end_date=datetime(2026, 2, 22, 8, 0, 0),
            status="in_progress",
            priority="medium",
            boq_item_id=boq_a_3.id,
        ),
        models.Task(
            project_id=project_b.id,
            name="Blockwork",
            duration_days=14,
            start_date=datetime(2026, 1, 5, 8, 0, 0),
            end_date=datetime(2026, 1, 19, 8, 0, 0),
            status="completed",
            priority="medium",
            boq_item_id=boq_b_1.id,
        ),
        models.Task(
            project_id=project_b.id,
            name="Painting",
            duration_days=10,
            start_date=datetime(2026, 2, 10, 8, 0, 0),
            end_date=datetime(2026, 2, 20, 8, 0, 0),
            status="not_started",
            priority="low",
            boq_item_id=boq_b_2.id,
        ),
    ]
    db.add_all(tasks)
    db.commit()

    employee_one = models.StaffEmployee(
        company_id=company.id,
        project_id=project_a.id,
        name="Ramesh Kumar",
        employee_code="EMP-01",
        designation="Site Engineer",
        basic_salary=25000,
        hra=5000,
        other_allowances=2000,
    )
    employee_two = models.StaffEmployee(
        company_id=company.id,
        project_id=project_b.id,
        name="Suresh Patel",
        employee_code="EMP-02",
        designation="Supervisor",
        basic_salary=22000,
        hra=4500,
        other_allowances=1500,
    )
    db.add_all([employee_one, employee_two])
    db.commit()

    db.add_all([
        models.AttendanceLog(
            employee_id=employee_one.id,
            project_id=project_a.id,
            attendance_date=datetime(2026, 6, 24, 8, 0, 0),
            punch_in=datetime(2026, 6, 24, 8, 0, 0),
            punch_out=datetime(2026, 6, 24, 16, 0, 0),
            hours_worked=8,
            status="Present",
        ),
        models.AttendanceLog(
            employee_id=employee_two.id,
            project_id=project_b.id,
            attendance_date=datetime(2026, 6, 24, 8, 0, 0),
            punch_in=datetime(2026, 6, 24, 8, 30, 0),
            punch_out=datetime(2026, 6, 24, 16, 30, 0),
            hours_worked=8,
            status="Present",
        ),
    ])
    db.commit()

    subcontractor_user = models.User(id=uuid.uuid4(), name="Zenith Contractors", mobile="+919900000001")
    vendor_user = models.User(id=uuid.uuid4(), name="Prime Sand Supplies", mobile="+919900000002")
    db.add_all([subcontractor_user, vendor_user])
    db.commit()

    subcontractor_team = models.CompanyTeam(
        company_id=company.id,
        user_id=subcontractor_user.id,
        priority_type="subcontractor",
    )
    vendor_team = models.CompanyTeam(
        company_id=company.id,
        user_id=vendor_user.id,
        priority_type="vendor",
    )
    db.add_all([subcontractor_team, vendor_team])
    db.commit()

    db.add(
        models.PurchaseOrder(
            company_id=company.id,
            project_id=project_a.id,
            vendor_id=vendor_team.id,
            po_number="PO-2026-001",
            po_date=datetime(2026, 6, 1, 10, 0, 0),
            status="sent",
            gross_amount=10000,
            tax_amount=1800,
            total_amount=11800,
            approval_flag="approved",
        )
    )
    db.commit()

    po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.po_number == "PO-2026-001").first()
    db.add(
        models.PurchaseOrderItem(
            po_id=po.id,
            material_name="River Sand",
            quantity=100,
            unit="m3",
            rate=100,
            tax_pct=18,
            total_amount=11800,
        )
    )
    db.commit()

    db.add(
        models.MaterialTransaction(
            project_id=project_a.id,
            material_name="River Sand",
            qty=82,
            type="used",
            source_ref_id=None,
        )
    )
    db.commit()

    db.add(
        models.WorkOrder(
            company_id=company.id,
            project_id=project_a.id,
            subcontractor_id=subcontractor_team.id,
            wo_number="WO-2026-001",
            wo_date=datetime(2026, 6, 5, 9, 0, 0),
            status="active",
            estimated_work_amount=50000,
        )
    )
    db.commit()

    db.add_all([
        models.Bill(
            company_id=company.id,
            project_id=project_a.id,
            party_company_user_id=subcontractor_team.id,
            invoice_number="RA-001",
            invoice_date=datetime(2026, 6, 10, 9, 0, 0),
            due_date=datetime(2026, 6, 30, 9, 0, 0),
            invoice_type="subcon",
            status="Paid",
            subtotal=50000,
            gst_amount=0,
            total_payable=50000,
            paid_amount=50000,
            approval_flag="approved",
            is_milestone_fixed_amount=False,
            updated_at=datetime(2026, 6, 15, 9, 0, 0),
        ),
        models.Bill(
            company_id=company.id,
            project_id=project_a.id,
            party_company_user_id=subcontractor_team.id,
            invoice_number="RA-002",
            invoice_date=datetime(2026, 5, 10, 9, 0, 0),
            due_date=datetime(2026, 5, 20, 9, 0, 0),
            invoice_type="subcon",
            status="Paid",
            subtotal=30000,
            gst_amount=0,
            total_payable=30000,
            paid_amount=30000,
            approval_flag="approved",
            is_milestone_fixed_amount=False,
            updated_at=datetime(2026, 5, 25, 9, 0, 0),
        ),
    ])
    db.commit()

    db.add(
        models.NCR(
            project_id=project_a.id,
            inspection_id=None,
            ncr_number="NCR-2026-001",
            vendor_id=subcontractor_team.id,
            title="Shuttering misalignment",
            description="Found at floor 3 grid C-D",
            severity="Major",
            raised_by=None,
            assigned_to=None,
            due_date=datetime(2026, 6, 18, 9, 0, 0),
            status="open",
        )
    )
    db.commit()
    auth_user_id = auth_user.id
    db.close()
    return auth_user_id


def assert_eq(label, actual, expected):
    assert actual == expected, f"[FAIL] {label}: expected {expected!r}, got {actual!r}"
    print(f"  [OK] {label} = {actual!r}")


def assert_close(label, actual, expected, tolerance=0.01):
    assert abs(actual - expected) <= tolerance, f"[FAIL] {label}: expected {expected!r}, got {actual!r}"
    print(f"  [OK] {label} = {actual!r}")


def ok(label, r, expected_status=200):
    assert r.status_code == expected_status, \
        f"[FAIL] {label}: HTTP {r.status_code} -- {r.text[:300]}"
    print(f"  [OK] {label}")
    return r.json()


def test_phase14():
    for _ in range(5):
        try:
            if os.path.exists(DB_FILE):
                os.remove(DB_FILE)
            break
        except Exception:
            time.sleep(1)

    company_obj = uuid.uuid4()
    project_a_obj = uuid.uuid4()
    project_b_obj = uuid.uuid4()

    auth_user_id = seed_db(company_obj, project_a_obj, project_b_obj)

    proc = start_server()
    try:
        s = requests.Session()
        from app.auth import create_access_token
        token = create_access_token({"sub": str(auth_user_id), "company_id": str(company_obj)})
        s.headers.update({"Authorization": f"Bearer {token}"})
        r = s.get(f"{BASE}/analytics/company/{company_obj}")
        payload = ok("Fetch company analytics", r)

        assert_eq("Company name", payload["company_name"], "Analytics Build Co")
        assert_eq("Project count", payload["project_count"], 2)
        assert_eq("Task completion %", payload["task_completion_pct"], 60.0)
        assert_eq("Total budget", payload["total_budget"], 340000.0)
        assert_eq("Total spend", payload["total_spend"], 80000.0)
        assert_eq("Budget variance", payload["budget_variance"], 260000.0)
        assert_eq("Burn rate %", payload["burn_rate_pct"], 23.53)

        labour = payload["labour_productivity"]
        assert_eq("Labour days", labour["labour_days"], 2.0)
        assert_eq("Completed area", labour["completed_area_m2"], 370.0)
        assert_eq("Productivity", labour["productivity_m2_per_labour_day"], 185.0)

        wastage = payload["material_wastage"]
        assert_eq("Ordered qty", wastage["ordered_qty"], 100.0)
        assert_eq("Consumed qty", wastage["consumed_qty"], 82.0)
        assert_eq("Wastage qty", wastage["wastage_qty"], 18.0)
        assert_eq("Wastage %", wastage["wastage_pct"], 18.0)

        s_curve = payload["s_curve"]
        assert len(s_curve) >= 2, f"[FAIL] Expected at least 2 S-curve points, got {len(s_curve)}"
        assert_eq("S-curve final planned", s_curve[-1]["planned_pct"], 100.0)
        assert_eq("S-curve final actual", s_curve[-1]["actual_pct"], 60.0)

        burn_series = payload["budget_burn_series"]
        assert len(burn_series) >= 2, f"[FAIL] Expected at least 2 burn series points, got {len(burn_series)}"
        assert_eq("Burn series final pct", burn_series[-1]["burn_pct"], 23.5)

        projects = payload["projects"]
        assert_eq("Project summaries", len(projects), 2)
        assert projects[0]["project_name"] in {"Alpha Tower", "Harbor Plaza"}

        scorecard = payload["subcontractor_scorecard"]
        assert_eq("Subcontractor scorecard count", len(scorecard), 1)
        assert_eq("Subcontractor on-time rate", scorecard[0]["on_time_rate"], 50.0)
        assert_eq("Subcontractor NCR count", scorecard[0]["ncr_count"], 1)

        print("\n=== All Phase 14 Tests Passed ===\n")

    finally:
        proc.terminate()
        time.sleep(1)
        for _ in range(5):
            try:
                if os.path.exists(DB_FILE):
                    os.remove(DB_FILE)
                break
            except Exception:
                time.sleep(1)


if __name__ == "__main__":
    test_phase14()
