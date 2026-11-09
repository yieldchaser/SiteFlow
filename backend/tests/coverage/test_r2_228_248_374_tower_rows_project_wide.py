"""R2-228 / R2-248 / R2-374 — per-tower reports must not echo the whole project.

Gate: with towers present, GET /towers/{project_id}/consolidated-pnl and
GET /budget/committed/{project_id}/towers stamped project-wide totals on every
tower row, so an n-tower project reported its spend n times and each tower's
variance charged all project billing against that tower's budget alone.
No document carries a tower_id (CD-5), so per-tower attribution does not
exist; until the column exists the honest report is one "Overall Project" row,
the same construction the no-towers branch already used (R2-374).
"""
import datetime
import uuid

from app import models

_SUFFIX = uuid.uuid4().hex[:8]


def _mob(t):
    return f"+9190{_SUFFIX}{t:02d}"


def _mail(t):
    return f"r228-{t}-{_SUFFIX}@test.com"


def _mk_po(db, comp, project, amount, tag, status):
    po = models.PurchaseOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        vendor_id=None,
        po_number=f"PO-R228-{tag}-{_SUFFIX}",
        po_date=datetime.datetime(2026, 1, 1),
        status=status,
        gross_amount=amount, tax_amount=0.0, total_amount=amount,
        approval_flag="approved",
    )
    db.add(po)
    db.commit()
    return po


def _mk_bill(db, comp, project, team, inv_type, amount, tag, cancelled=False):
    b = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=team.id, invoice_number=f"INV-R228-{tag}-{_SUFFIX}",
        invoice_date=datetime.datetime(2026, 1, 1),
        invoice_type=inv_type, subtotal=amount, total_payable=amount,
        approval_flag="approved",
        status="Cancelled" if cancelled else "Unpaid",
    )
    db.add(b)
    db.commit()
    return b


def _mk_wo(db, comp, project, team, amount):
    wo = models.WorkOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        subcontractor_id=team.id, wo_number=f"WO-R228-{_SUFFIX}",
        wo_date=datetime.datetime(2026, 1, 1), status="active",
        estimated_work_amount=amount,
    )
    db.add(wo)
    db.commit()
    return wo


def _seed_project_with_towers(db, comp, user, team, name):
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name=name, code=f"PRJ-{_SUFFIX}-{name}", status="Ongoing"
    )
    db.add(project)
    db.commit()
    towers = []
    for i, budget in enumerate((100000.0, 200000.0, 300000.0), start=1):
        t = models.ProjectTower(
            id=uuid.uuid4(), project_id=project.id,
            tower_name=f"{name} T{i}", tower_code=f"T{i}-{_SUFFIX}", budget=budget,
        )
        db.add(t)
        towers.append(t)
    db.commit()
    return project, towers


def test_consolidated_pnl_single_overall_row_not_project_per_tower(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(
        company_name="R228", user_name="U228", mobile=_mob(1), email=_mail(1)
    )
    hdr = auth_headers(user, comp)
    project, towers = _seed_project_with_towers(db, comp, user, team, "P228")

    # Project-wide truth: one live PO, one revenue bill, one cancelled bill
    # that must stay out, one work order.
    _mk_po(db, comp, project, 1000.0, "live", "received")
    _mk_bill(db, comp, project, team, "sale", 118000.0, "sale")
    _mk_bill(db, comp, project, team, "purchase", 999.0, "cxled", cancelled=True)
    _mk_wo(db, comp, project, team, 5000.0)

    r = client.get(f"/apis/v3/towers/{project.id}/consolidated-pnl", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()

    # Three towers exist; the report must not return three echoed copies of
    # the project (which would read 354000 billed instead of 118000).
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["tower_id"] is None, row
    assert row["tower_name"] == "Overall Project", row
    assert row["tower_code"] == "ALL", row
    assert row["total_po_value"] == 1000.0, row
    assert row["total_billed"] == 118000.0, row
    assert row["total_wo_value"] == 5000.0, row
    # Budget is the sum of the towers' own budgets, not any single tower's.
    assert row["budget"] == 600000.0, row
    # Variance is the cost budget left after committed POs and WOs, not
    # budget minus revenue billed.
    assert row["variance"] == row["budget"] - row["total_po_value"] - row["total_wo_value"], row

    # No returned row wears a real tower's identity: drilling into Tower A
    # cannot dress project figures up as Tower A figures.
    r = client.get(f"/apis/v3/towers/{project.id}/consolidated-pnl?tower_id={towers[0].id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1, rows
    assert rows[0]["tower_code"] == "ALL", rows
    assert rows[0]["total_billed"] == 118000.0, rows


def test_committed_towers_single_overall_row_not_project_per_tower(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(
        company_name="R248", user_name="U248", mobile=_mob(2), email=_mail(2)
    )
    hdr = auth_headers(user, comp)
    project, towers = _seed_project_with_towers(db, comp, user, team, "P248w")

    _mk_po(db, comp, project, 100.0, "sent", "sent")
    _mk_po(db, comp, project, 200.0, "partial", "partial")
    _mk_po(db, comp, project, 300.0, "draft", "draft")
    _mk_bill(db, comp, project, team, "purchase", 1000.0, "mat")
    _mk_bill(db, comp, project, team, "sale", 118000.0, "sale-noise")

    r = client.get(f"/apis/v3/budget/committed/{project.id}/towers", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()

    # Two towers exist; the endpoint must not return two copies of the
    # project's committed/actual under their names.
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["tower_id"] is None, row
    assert row["tower_name"] == "Overall Project", row
    assert row["committed"] == 300.0, row
    assert row["actual"] == 1000.0, row
    assert row["budget"] == 600000.0, row
    assert row["variance"] == 600000.0 - 1000.0, row


def test_budget_overall_row_reconciles_to_project_budget_row(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(
        company_name="R374", user_name="U374", mobile=_mob(3), email=_mail(3)
    )
    hdr = auth_headers(user, comp)
    project, towers = _seed_project_with_towers(db, comp, user, team, "P374")

    # A project budget exists and disagrees with the sum of tower budgets;
    # like the no-towers branch, the report must reconcile against the
    # project's own budget.
    db.add(models.ProjectBudget(
        id=uuid.uuid4(), project_id=project.id,
        material_budget=900000.0, labour_budget=50000.0,
        subcon_budget=40000.0, equipment_budget=10000.0,
    ))
    db.commit()

    _mk_po(db, comp, project, 700.0, "sent", "sent")
    # Revenue-scope billed vs expense-scope actual are deliberately different
    # figures so each endpoint reconciles against its own ledger scope.
    _mk_bill(db, comp, project, team, "sale", 2000.0, "sale")
    _mk_bill(db, comp, project, team, "subcon", 3000.0, "sub")

    r = client.get(f"/apis/v3/towers/{project.id}/consolidated-pnl", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["tower_id"] is None, row
    assert row["tower_code"] == "ALL", row
    assert row["budget"] == 1000000.0, row
    assert row["total_billed"] == 2000.0, row
    # Variance is the cost budget left after committed POs and WOs, not
    # budget minus revenue billed.
    assert row["variance"] == row["budget"] - row["total_po_value"] - row["total_wo_value"], row

    r = client.get(f"/apis/v3/budget/committed/{project.id}/towers", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["committed"] == 700.0, row
    assert row["actual"] == 3000.0, row
    assert row["budget"] == 1000000.0, row
    assert row["variance"] == 1000000.0 - 3000.0, row
