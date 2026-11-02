"""Regression tests for Prompt 10 (low-priority polish / Theme F).

Covers the high-value new behaviours from the 13-item backlog:
  F1  debit note now created with approval_flag="pending"
  F2  duplicate invoice_number in same company rejected (400)
  F3  over-aggressive fixed-amount deductions never yield negative payable
  F4  partial GRN sets po.status="partial", full GRN sets "received"
  F5  three-way match variance vs GRN received value, not whole-PO total
  F6  updating a task whose project is missing (dangling FK) -> 404
  F7  moving a task's start_date out of window is rejected
  F9  creating a task with a cross-project parent_id -> 400
  F10 quality writes now require quality:edit (role w/o it -> 403;
      partner + empty-role stay fail-open)
"""
import datetime
import uuid

from app import models


# ── helpers ──────────────────────────────────────────────────────────────────

def _project(db, company):
    p = models.Project(
        id=uuid.uuid4(), company_id=company.id, name="PolishProj",
        code=uuid.uuid4().hex[:6], status="Ongoing", state="Karnataka",
    )
    db.add(p)
    db.commit()
    return p


def _employee(db, company, perms, auth_headers):
    """Employee-priority member with a custom role (mirrors rbac test helper)."""
    user = models.User(id=uuid.uuid4(), name="Emp", mobile=f"+919{uuid.uuid4().hex[:9]}")
    db.add(user)
    db.flush()
    role = models.CompanyRole(
        company_id=company.id, role_name=f"Role-{uuid.uuid4().hex[:6]}", permissions=perms,
    )
    db.add(role)
    db.flush()
    team = models.CompanyTeam(
        id=uuid.uuid4(), company_id=company.id, user_id=user.id,
        priority_type="employee", role_id=role.id,
    )
    db.add(team)
    db.commit()
    return user, auth_headers(user, company)


def _po(db, company, project, items):
    po = models.PurchaseOrder(
        company_id=company.id, project_id=project.id, vendor_id=None,
        po_number=f"PO-{uuid.uuid4().hex[:6]}", po_date=datetime.datetime.now(),
        status="sent", approval_flag="approved", gross_amount=0, tax_amount=0, total_amount=0,
    )
    db.add(po)
    db.flush()
    total = 0.0
    for mat, qty, rate in items:
        poi = models.PurchaseOrderItem(
            po_id=po.id, material_name=mat, quantity=qty, unit="unit", rate=rate,
        )
        db.add(poi)
        db.flush()
        poi.total_amount = qty * rate
        total += float(qty * rate)
    po.total_amount = total
    db.commit()
    return po


# ── F1: debit note requires approval ─────────────────────────────────────────

def test_debit_note_created_pending(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991001")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    r = client.post(
        "/apis/v3/billing/debit-notes",
        json={"project_id": str(proj.id), "company_id": str(comp.id),
              "party_company_user_id": str(team.id), "total_amount": 100.0},
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    assert r.json()["approval_flag"] == "pending"


# ── F2: duplicate invoice_number rejected ────────────────────────────────────

def test_duplicate_invoice_number_rejected(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991002")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    base = {
        "company_id": str(comp.id), "project_id": str(proj.id),
        "party_company_user_id": str(team.id), "invoice_number": "DUP-INV-1",
        "invoice_date": datetime.datetime.now().isoformat(), "invoice_type": "subcon",
        "subtotal": 1000.0, "gst_pct": 18.0,
    }
    r1 = client.post("/apis/v3/billing/bills", json=base, headers=hdr)
    assert r1.status_code == 201, r1.text
    r2 = client.post("/apis/v3/billing/bills", json=base, headers=hdr)
    assert r2.status_code == 400
    assert "already has a bill numbered DUP-INV-1" in r2.json()["detail"]


# ── F3: deductions never push payable negative ───────────────────────────────

def test_over_aggressive_deductions_no_negative_payable(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991003")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    payload = {
        "company_id": str(comp.id), "project_id": str(proj.id),
        "party_company_user_id": str(team.id), "invoice_number": "NEG-INV-1",
        "invoice_date": datetime.datetime.now().isoformat(), "invoice_type": "subcon",
        "subtotal": 1000.0, "gst_pct": 0.0,
        # Two fixed-amount deductions that individually exceed the base.
        "deductions": [
            {"deduction_type": "Retention", "amount": 800.0},
            {"deduction_type": "TDS", "amount": 800.0},
        ],
    }
    r = client.post("/apis/v3/billing/bills", json=payload, headers=hdr)
    assert r.status_code == 201, r.text
    # Deductions clamped to base -> total_payable can't go negative.
    assert r.json()["total_payable"] >= 0.0
    assert r.json()["total_payable"] <= 1000.0 + 1e-6


# ── F4: partial vs full GRN status ───────────────────────────────────────────

def test_partial_grn_sets_partial_status(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991004")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    po = _po(db, comp, proj, [("Cement", 100, 10.0), ("Sand", 100, 5.0)])
    # Fully receive only the first item.
    r = client.post(
        "/apis/v3/procurement/grns",
        json={"company_id": str(comp.id), "project_id": str(proj.id), "po_id": str(po.id),
              "grn_number": "GRN-P1", "received_date": datetime.datetime.now().isoformat(),
              "received_by": str(team.id),
              "items": [{"po_item_id": str(po_i.id), "received_qty": 100.0} for po_i in
                        db.query(models.PurchaseOrderItem).filter(models.PurchaseOrderItem.po_id == po.id).all()[:1]]},
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    db.refresh(po)
    assert po.status == "partial"


def test_full_grn_sets_received_status(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991005")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    po = _po(db, comp, proj, [("Cement", 100, 10.0), ("Sand", 100, 5.0)])
    po_items = db.query(models.PurchaseOrderItem).filter(models.PurchaseOrderItem.po_id == po.id).all()
    r = client.post(
        "/apis/v3/procurement/grns",
        json={"company_id": str(comp.id), "project_id": str(proj.id), "po_id": str(po.id),
              "grn_number": "GRN-F1", "received_date": datetime.datetime.now().isoformat(),
              "received_by": str(team.id),
              "items": [{"po_item_id": str(pi.id), "received_qty": float(pi.quantity)} for pi in po_items]},
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    db.refresh(po)
    assert po.status == "received"


# ── F5: three-way variance uses GRN received value ───────────────────────────

def test_three_way_variance_vs_grn_value(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991006")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    # PO total 1000 (100 @ 10). Receive only 50 @ 10 = 500 worth in the GRN.
    po = _po(db, comp, proj, [("Cement", 100, 10.0)])
    poi = db.query(models.PurchaseOrderItem).filter(models.PurchaseOrderItem.po_id == po.id).first()
    grn = models.GoodsReceiptNote(
        company_id=comp.id, project_id=proj.id, po_id=po.id, grn_number="GRN-3W",
        received_date=datetime.datetime.now(), received_by=team.id,
    )
    db.add(grn)
    db.flush()
    db.add(models.GRNItem(grn_id=grn.id, po_item_id=poi.id, received_qty=50.0))
    db.commit()

    # R2-349: the reconciled figure is the bill's stored total_payable, so the
    # payload identifies a vendor bill invoicing exactly the received value.
    bill = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=proj.id,
        party_company_user_id=team.id, invoice_number=f"INV-{uuid.uuid4().hex[:8]}",
        invoice_date=datetime.datetime.now(), invoice_type="purchase",
        subtotal=500.0, gst_amount=0.0, total_payable=500.0,
    )
    db.add(bill)
    db.commit()

    r = client.post(
        "/apis/v3/three-way",
        json={"company_id": str(comp.id), "project_id": str(proj.id),
              "po_id": str(po.id), "grn_id": str(grn.id),
              "invoice_id": str(bill.id)},
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    # R2-240: the baseline stays GRN-received-value-based (never the whole PO's
    # 1000) but is now capped at what remains authorised on the PO line and put
    # on a tax-inclusive basis like bill.total_payable: min(50, 100) @ 10 with
    # the line's default 18% GST = 590. An invoice of exactly 500 therefore
    # carries a -90 variance and must be flagged as a mismatch.
    assert body["po_amount"] == 590.0
    assert body["variance_amount"] == -90.0
    assert body["match_status"] == "mismatch"


# ── F6: update task with dangling project FK -> 404 ──────────────────────────

def test_update_task_missing_project_404(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991007")
    hdr = auth_headers(user, comp)
    # Build a Task row whose project_id points at a non-existent project.
    orphan = models.Task(
        id=uuid.uuid4(), project_id=uuid.uuid4(), name="Orphan", duration_days=5,
        start_date=datetime.datetime.now(), end_date=datetime.datetime.now() + datetime.timedelta(days=5),
    )
    db.add(orphan)
    db.commit()
    r = client.put(f"/apis/v3/planning/tasks/{orphan.id}", json={"name": "X"}, headers=hdr)
    assert r.status_code == 404
    assert "Project not found for this task" in r.json()["detail"]


# ── F7: moving start_date out of editing window is rejected ──────────────────

def test_update_task_out_of_window_start_date_rejected(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991008")
    proj = _project(db, comp)
    # Enable the editing-window restriction: nothing older than 0 days (same day).
    comp.restrict_entry_editing_enabled = True
    comp.restrict_entry_editing_days = 0
    db.commit()
    hdr = auth_headers(user, comp)

    start = datetime.datetime.now()
    task = models.Task(
        id=uuid.uuid4(), project_id=proj.id, name="T", duration_days=5,
        start_date=start, end_date=start + datetime.timedelta(days=5),
    )
    db.add(task)
    db.commit()

    # Move start_date to 30 days in the past -> must be rejected.
    new_start = (datetime.datetime.now() - datetime.timedelta(days=30))
    r = client.put(
        f"/apis/v3/planning/tasks/{task.id}",
        json={"start_date": new_start.isoformat(), "duration_days": 5},
        headers=hdr,
    )
    assert r.status_code == 400


# ── F9: cross-project parent_id rejected ─────────────────────────────────────

def test_create_task_cross_project_parent_rejected(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991009")
    proj_a = _project(db, comp)
    proj_b = _project(db, comp)
    hdr = auth_headers(user, comp)
    parent = models.Task(
        id=uuid.uuid4(), project_id=proj_b.id, name="Parent", duration_days=2,
        start_date=datetime.datetime.now(), end_date=datetime.datetime.now() + datetime.timedelta(days=2),
    )
    db.add(parent)
    db.commit()
    start = datetime.datetime.now()
    r = client.post(
        "/apis/v3/planning/tasks",
        json={"project_id": str(proj_a.id), "parent_id": str(parent.id), "name": "Child",
              "duration_days": 3, "start_date": start.isoformat(), "priority": "medium"},
        headers=hdr,
    )
    assert r.status_code == 400
    assert "same project" in r.json()["detail"]


# ── F10: quality write requires quality:edit ─────────────────────────────────

def test_quality_ncr_denied_without_quality_edit(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991010")
    proj = _project(db, comp)
    _, hdr = _employee(db, comp, {"quality:view": True}, auth_headers)
    r = client.post(
        "/apis/v3/quality/ncr",
        json={"project_id": str(proj.id), "ncr_number": "NCR-T1", "title": "Crack", "description": "x",
              "raised_by": str(team.id), "severity": "Major", "status": "open"},
        headers=hdr,
    )
    assert r.status_code == 403


def test_quality_ncr_allowed_with_quality_edit(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991011")
    proj = _project(db, comp)
    _, hdr = _employee(db, comp, {"quality:edit": True}, auth_headers)
    r = client.post(
        "/apis/v3/quality/ncr",
        json={"project_id": str(proj.id), "ncr_number": "NCR-T1", "title": "Crack", "description": "x",
              "raised_by": str(team.id), "severity": "Major", "status": "open"},
        headers=hdr,
    )
    assert r.status_code == 201, r.text


def test_quality_ncr_fail_open_partner(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991012")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)  # partner member
    r = client.post(
        "/apis/v3/quality/ncr",
        json={"project_id": str(proj.id), "ncr_number": "NCR-T1", "title": "Crack", "description": "x",
              "raised_by": str(team.id), "severity": "Major", "status": "open"},
        headers=hdr,
    )
    assert r.status_code == 201, r.text


def test_quality_ncr_fail_open_empty_role(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919889991013")
    proj = _project(db, comp)
    _, hdr = _employee(db, comp, {}, auth_headers)  # un-migrated role -> fail-open
    r = client.post(
        "/apis/v3/quality/ncr",
        json={"project_id": str(proj.id), "ncr_number": "NCR-T1", "title": "Crack", "description": "x",
              "raised_by": str(team.id), "severity": "Major", "status": "open"},
        headers=hdr,
    )
    assert r.status_code == 201, r.text
