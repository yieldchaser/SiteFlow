"""The head office is a cost centre, not a site.

VCPL keeps "Head Office - Navi Mumbai" as a project so office staff have
somewhere to belong. It must not take site records, and its money must show
as head office overheads that come off the sites' profit. The dashboard's
project table counted bills only, so the head office (mostly salaries)
looked almost free and the company looked more profitable than it was.
"""
import datetime
import uuid

from app import models

_T = uuid.uuid4().hex[:8]


def _setup(db, make_tenant, n):
    comp, user, team = make_tenant(company_name=f"HOC{n}{_T}", user_name=f"HOC{n}",
                                   mobile="+9176" + str(int(_T, 16) + n)[-8:], email=f"hoc{n}-{_T}@test.com")
    site = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Paikdev Bridge", status="Ongoing")
    office = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Head Office - Navi Mumbai",
                            status="Ongoing", is_head_office=True)
    db.add_all([site, office])
    db.commit()
    return comp, user, team, site, office


def _bill(db, comp, project, team, amount, invoice_type):
    db.add(models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
        invoice_number=f"INV-{uuid.uuid4().hex[:10]}", invoice_date=datetime.datetime(2026, 10, 15),
        invoice_type=invoice_type, status="Unpaid", subtotal=amount, total_payable=amount,
    ))
    db.commit()


def test_site_records_are_refused_on_the_head_office(client, db, make_tenant, auth_headers):
    comp, user, team, site, office = _setup(db, make_tenant, 1)
    hdr = auth_headers(user, comp)
    when = "2026-11-11T06:30:00Z"
    attempts = {
        "task": client.post("/apis/v3/planning/tasks", headers=hdr, json={
            "project_id": str(office.id), "name": "Slab", "duration_days": 1, "start_date": when}),
        "dpr": client.post("/apis/v3/dpr", headers=hdr, json={
            "project_id": str(office.id), "reported_by": "x", "dpr_date": when, "executed_qty": 0,
            "workers_deployed": 0, "weather": "Clear", "notes": "", "issues": "",
            "materials_consumed": [], "photos": []}),
        "boq": client.post("/apis/v3/budgeting/boq-documents", headers=hdr, json={
            "project_id": str(office.id), "title": "BOQ"}),
        "work order": client.post("/apis/v3/billing/work-orders", headers=hdr, json={
            "company_id": str(comp.id), "project_id": str(office.id), "subcontractor_id": str(team.id),
            "wo_date": when, "items": []}),
        "client invoice": client.post("/apis/v3/billing/bills", headers=hdr, json={
            "company_id": str(comp.id), "project_id": str(office.id), "party_company_user_id": str(team.id),
            "invoice_date": when, "invoice_type": "sale", "subtotal": 1000}),
    }
    for what, r in attempts.items():
        assert r.status_code == 400 and "head office, not a site" in r.text, (what, r.status_code, r.text)

    # Office rent and purchases still belong on the head office.
    r = client.post("/apis/v3/billing/bills", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(office.id), "party_company_user_id": str(team.id),
        "invoice_date": when, "invoice_type": "expense", "subtotal": 1000})
    assert "head office, not a site" not in r.text, r.text

    # The same task on the site goes through.
    r = client.post("/apis/v3/planning/tasks", headers=hdr, json={
        "project_id": str(site.id), "name": "Slab", "duration_days": 1, "start_date": when})
    assert r.status_code == 201, r.text


def test_dashboard_counts_salaries_and_takes_head_office_off_company_profit(client, db, make_tenant, auth_headers):
    comp, user, team, site, office = _setup(db, make_tenant, 2)
    hdr = auth_headers(user, comp)
    _bill(db, comp, site, team, 100000.0, "sale")
    _bill(db, comp, site, team, 30000.0, "purchase")
    _bill(db, comp, office, team, 5000.0, "expense")          # office rent
    accountant = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, project_id=office.id, name="Accountant")
    db.add(accountant)
    run = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, project_id=None, payroll_month="2026-10",
                            status="finalized")
    db.add(run)
    db.commit()
    db.add(models.PayrollLineItem(id=uuid.uuid4(), payroll_run_id=run.id, employee_id=accountant.id,
                                  gross_salary=20000.0, pf_employer=1800.0, net_payable=20000.0))
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}/financial", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    rows = {p["project_name"]: p for p in body["project_summaries"]}
    # The head office costs its rent plus salary and employer PF, as the P&L counts it.
    assert rows["Head Office - Navi Mumbai"]["total_expense"] == 26800.0, rows
    assert rows["Head Office - Navi Mumbai"]["is_office"] is True
    assert rows["Paikdev Bridge"]["is_office"] is False
    assert body["totals"] == {
        "sites_sales": 100000.0, "sites_cost": 30000.0, "sites_margin": 70000.0,
        "head_office_cost": 26800.0, "company_profit": 43200.0,
    }, body["totals"]

    # P&L for the head office agrees with the dashboard row.
    pl = client.get(f"/apis/v3/finance/pl?project_id={office.id}", headers=hdr).json()
    assert round(sum(h["actual"] for h in pl if h["head"] != "Revenue (Billed)"), 2) == 26800.0


def test_portfolio_analytics_count_sites_only(client, db, make_tenant, auth_headers):
    comp, user, team, site, office = _setup(db, make_tenant, 3)
    hdr = auth_headers(user, comp)
    db.add(models.ProjectBudget(id=uuid.uuid4(), project_id=site.id, material_budget=100000.0,
                                labour_budget=0, subcon_budget=0, equipment_budget=0))
    db.commit()
    _bill(db, comp, site, team, 40000.0, "purchase")
    _bill(db, comp, office, team, 60000.0, "expense")

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_spend"] == 40000.0, body["total_spend"]
    assert body["burn_rate_pct"] == 40.0
    assert body["head_office_spend"] == 60000.0
    assert body["project_count"] == 1
    assert body["budget_burn_series"][-1]["spend"] == 40000.0
