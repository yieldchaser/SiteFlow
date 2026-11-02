"""Cost, revenue and budget-vs-actual count a bill at its work value.

Found driving a piling project with one client invoice, one cement bill, one
subcontractor RA bill and one payroll run. Many screens added up
total_payable, which is after TDS and retention and with GST:

1. P&L, Budget and the BI feed booked a Rs 1,00,000 subcontract bill as
   Rs 1,11,000 of cost (GST added, TDS and retention taken off), and labour as
   net pay, leaving out employee PF/ESI/TDS and the employer's PF and ESI.
2. The project's Billed In/Out ("with GST") also took off TDS and retention.
3. The cost-code budget report gave every cost code the same actual: all of
   the company's bills, sales and cancelled ones included.
4. The party balance report looked for invoice type "material" (none exists),
   left equipment bills out, and showed a client who owed money as Settled.
5. A purchase bill was capped at the PO total with GST, so it could run 18%
   past the order before GST.
"""
import datetime
import json
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]
NOW = datetime.datetime(2026, 11, 2, tzinfo=datetime.timezone.utc)


def _world(db, make_tenant, auth_headers, tag):
    comp, user, _team = make_tenant(
        company_name=f"MVB-{tag}-{_SFX}", user_name=f"MVB-{tag}",
        mobile=f"+9176{_SFX}{tag:02d}", email=f"mvb-{tag}-{_SFX}@test.com",
    )
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing", state="Maharashtra")
    db.add(project)
    db.flush()
    teams = {}
    for key, kind in (("client", "Client"), ("cement", "Material Supplier"), ("piling", "Subcontractor"), ("crane", "Equipment")):
        lib = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name=f"{key} {_SFX}", party_type=kind)
        db.add(lib)
        db.flush()
        teams[key] = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id, user_id=None, library_party_id=lib.id)
        db.add(teams[key])
    db.commit()
    return comp, project, teams, auth_headers(user, comp)


def _bill(db, comp, project, party, invoice_type, subtotal, gst, payable, number, items=None, status="Unpaid"):
    b = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=party.id,
        invoice_number=f"{number}-{_SFX}", invoice_date=NOW, invoice_type=invoice_type, status=status,
        subtotal=subtotal, gst_amount=gst, total_payable=payable, approval_flag="approved",
        items_json=json.dumps(items) if items else None)
    db.add(b)
    db.commit()
    return b


def _standard_bills(db, comp, project, teams):
    _bill(db, comp, project, teams["client"], "sale", 200000, 36000, 236000, "INV-1")
    _bill(db, comp, project, teams["cement"], "purchase", 50000, 9000, 59000, "NMCD-1")
    # 1,00,000 of piling, 18% GST, 2% TDS and 5% retention: payable 1,11,000.
    _bill(db, comp, project, teams["piling"], "subcon", 100000, 18000, 111000, "KPW-RA-1")


def test_pnl_and_budget_count_work_value_and_full_labour_cost(client, db, make_tenant, auth_headers):
    comp, project, teams, hdr = _world(db, make_tenant, auth_headers, 1)
    _standard_bills(db, comp, project, teams)
    staff = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name="Rig operator")
    run = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, project_id=project.id, payroll_month="2026-10", status="finalized")
    db.add_all([staff, run])
    db.flush()
    db.add(models.PayrollLineItem(
        payroll_run_id=run.id, employee_id=staff.id, gross_salary=20000, basic=20000,
        pf_employee=2400, pf_employer=2400, esi_employee=150, esi_employer=650,
        total_deductions=2550, net_payable=17450))
    db.commit()

    pl = {r["head"]: r for r in client.get(f"/apis/v3/finance/pl?project_id={project.id}", headers=hdr).json()}
    assert pl["Revenue (Billed)"]["actual"] == 200000.0
    assert pl["Material Cost"]["actual"] == 50000.0
    assert pl["Subcontractor Cost"]["actual"] == 100000.0
    assert pl["Labour Cost"]["actual"] == 23050.0

    b = client.get(f"/apis/v3/budget/committed/{project.id}", headers=hdr).json()
    assert b["material_actual"] == 50000.0
    assert b["subcon_actual"] == 100000.0
    assert b["labour_actual"] == 23050.0


def test_billed_in_and_out_are_invoice_value_with_gst(client, db, make_tenant, auth_headers):
    comp, project, teams, hdr = _world(db, make_tenant, auth_headers, 2)
    _standard_bills(db, comp, project, teams)
    p = client.get(f"/apis/v3/projects/{project.id}", headers=hdr).json()
    assert p["cash_in"] == 236000.0
    assert p["cash_out"] == 59000.0 + 118000.0


def test_cost_code_report_books_each_line_to_its_own_code(client, db, make_tenant, auth_headers):
    comp, project, teams, hdr = _world(db, make_tenant, auth_headers, 3)
    cement = models.LibraryCostCode(id=uuid.uuid4(), company_id=comp.id, code=f"MAT-{_SFX}", name="Cement", budget_amount=40000)
    steel = models.LibraryCostCode(id=uuid.uuid4(), company_id=comp.id, code=f"STL-{_SFX}", name="Steel", budget_amount=10000)
    db.add_all([cement, steel])
    db.commit()
    _bill(db, comp, project, teams["cement"], "purchase", 50000, 9000, 59000, "MIX-1", items=[
        {"desc": "OPC", "cost_code_id": str(cement.id), "qty": 100, "rate": 300, "amount": 30000},
        {"desc": "TMT", "cost_code_id": str(steel.id), "qty": 1, "rate": 20000, "amount": 20000},
    ])
    _bill(db, comp, project, teams["client"], "sale", 900000, 0, 900000, "INV-9")
    _bill(db, comp, project, teams["cement"], "purchase", 70000, 0, 70000, "OLD-1", status="Cancelled", items=[
        {"desc": "OPC", "cost_code_id": str(cement.id), "qty": 1, "rate": 70000, "amount": 70000},
    ])

    r = client.get(f"/apis/v3/reports/data/budget-vs-actual-cost-code?company_id={comp.id}&project_id={project.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = {row["Cost Code"]: row for row in r.json()["rows"]}
    assert rows[cement.code]["Actual Amount (INR)"] == 30000.0
    assert rows[steel.code]["Actual Amount (INR)"] == 20000.0
    assert rows[steel.code]["Status"] == "Over Budget"


def test_party_balance_report_counts_materials_equipment_and_clients(client, db, make_tenant, auth_headers):
    comp, project, teams, hdr = _world(db, make_tenant, auth_headers, 4)
    _standard_bills(db, comp, project, teams)
    _bill(db, comp, project, teams["crane"], "equipment", 40000, 7200, 47200, "CRN-1")

    r = client.get(f"/apis/v3/reports/data/project-level-party-balance?company_id={comp.id}&project_id={project.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()["rows"]
    by_amount = {(row["Material Purchase"], row["Equipment Expense"], row["Sales Invoice"]): row for row in rows}
    cement = by_amount[(59000.0, 0.0, 0.0)]
    assert cement["Balance Type"] == "To Pay" and cement["Net Balance"] == 59000.0
    crane = by_amount[(0.0, 47200.0, 0.0)]
    assert crane["Balance Type"] == "To Pay" and crane["Net Balance"] == 47200.0
    port = by_amount[(0.0, 0.0, 236000.0)]
    assert port["Balance Type"] == "To Receive" and port["Net Balance"] == 236000.0


def test_purchase_bill_is_capped_at_the_po_value_before_gst(client, db, make_tenant, auth_headers):
    comp, project, teams, hdr = _world(db, make_tenant, auth_headers, 5)
    po = models.PurchaseOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, vendor_id=teams["cement"].id,
        po_number=f"PO-{_SFX}", po_date=NOW, status="sent", approval_flag="approved",
        gross_amount=100000, tax_amount=18000, total_amount=118000)
    db.add(po)
    db.commit()
    line = [{"desc": "OPC", "hsn_sac": "2523", "qty": 1, "rate": 110000, "amount": 110000}]
    r = client.post("/apis/v3/billing/bills", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "party_company_user_id": str(teams["cement"].id), "invoice_number": "NMCD-OVER",
        "invoice_date": NOW.isoformat(), "invoice_type": "purchase", "po_id": str(po.id),
        "subtotal": 110000, "gst_pct": 18, "items_json": json.dumps(line),
    })
    assert r.status_code == 422 and "exceeds PO" in r.json()["detail"], r.text
