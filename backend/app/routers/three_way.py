import uuid
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from decimal import Decimal
from app.database import get_db
from app.auth import get_current_user, verify_company_access, get_company_membership, require_permission
from app.models import ThreeWayMatch, PurchaseOrder, PurchaseOrderItem, GoodsReceiptNote, GRNItem, User, Bill, MaterialTransaction
from app.routers.delete_logs import log_deletion

router = APIRouter(prefix="/three-way", tags=["3-Way Matching"], dependencies=[Depends(get_current_user)])

MATCH_TOLERANCE_PCT = 0.01
MATCH_TOLERANCE_MIN = 1.0


class ThreeWayMatchCreate(BaseModel):
    company_id: uuid.UUID
    project_id: uuid.UUID
    po_id: uuid.UUID
    grn_id: uuid.UUID
    # R2-349: the reconciled amount is read from the identified bill's
    # total_payable, never typed by the caller; invoice_id is therefore required.
    invoice_id: uuid.UUID
    variance_reason: Optional[str] = None
    # R2-241: match_status and matched_by are server-computed. The verdict is
    # derived from the variance, never accepted from the request body; the actor
    # is the authenticated user, not a caller-chosen UUID.


class ThreeWayMatchResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: uuid.UUID
    po_id: uuid.UUID
    grn_id: uuid.UUID
    invoice_id: Optional[uuid.UUID]
    match_status: str
    po_amount: float
    grn_qty: float
    invoiced_amount: float
    variance_amount: float
    # R2-240: the three numbers the control is named after, surfaced so an
    # approver can see the authorised quantity, what was actually received,
    # and the PO total alongside the computed baseline (po_amount).
    ordered_qty: Optional[float] = None
    received_qty: Optional[float] = None
    po_total: Optional[float] = None
    variance_reason: Optional[str]
    matched_by: Optional[uuid.UUID]
    matched_at: Optional[datetime]
    po_number: Optional[str] = None
    grn_number: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class PORef(BaseModel):
    id: uuid.UUID
    po_number: str
    total_amount: float
    vendor_id: Optional[uuid.UUID] = None

    class Config:
        from_attributes = True


class GRNRef(BaseModel):
    id: uuid.UUID
    grn_number: str
    po_id: Optional[uuid.UUID] = None
    created_at: datetime

    class Config:
        from_attributes = True


@router.post("", response_model=ThreeWayMatchResponse, status_code=status.HTTP_201_CREATED)
def create_match(payload: ThreeWayMatchCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "finance:edit")
    po_id = str(payload.po_id)
    grn_id = str(payload.grn_id)

    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
    grn = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.id == grn_id).first()
    if not po or not grn:
        raise HTTPException(status_code=404, detail="PO or GRN not found")
    if po.company_id != payload.company_id or po.project_id != payload.project_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="PO does not belong to the supplied company/project",
        )
    if grn.company_id != payload.company_id or grn.project_id != payload.project_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="GRN does not belong to the supplied company/project",
        )

    # R2-349: reconcile against the bill itself. The invoiced amount is the
    # bill's total_payable from the database, not a number typed in the request.
    bill = db.query(Bill).filter(Bill.id == str(payload.invoice_id)).first()
    if not bill:
        raise HTTPException(status_code=404, detail="Invoice (bill) not found")
    if bill.company_id != payload.company_id or bill.project_id != payload.project_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invoice does not belong to the supplied company/project",
        )
    # A match is the record that this bill pays for these goods on this
    # order. A receipt against some other PO, anything cancelled, or another
    # supplier's bill would put a wrong payable on the books, and the one
    # match allowed per PO/GRN pair would then block the right bill.
    if grn.po_id != po.id:
        raise HTTPException(status_code=422, detail=f"{grn.grn_number} was received against a different purchase order")
    if (po.status or "").lower() == "cancelled":
        raise HTTPException(status_code=422, detail=f"{po.po_number} is cancelled")
    if _grn_is_cancelled(db, grn.id):
        raise HTTPException(status_code=422, detail=f"{grn.grn_number} is cancelled")
    if (bill.status or "").lower() == "cancelled":
        raise HTTPException(status_code=422, detail=f"Bill {bill.invoice_number} is cancelled")
    if po.vendor_id is not None and bill.party_company_user_id != po.vendor_id:
        raise HTTPException(status_code=422, detail=f"Bill {bill.invoice_number} is from a different supplier than {po.po_number}")
    invoiced_amount = float(bill.total_payable)

    # R2-594: a PO/GRN pair carries exactly one reconciliation record, so
    # contradictory verdicts cannot coexist for the same receipt.
    existing = (
        db.query(ThreeWayMatch)
        .filter(ThreeWayMatch.po_id == po_id, ThreeWayMatch.grn_id == grn_id)
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A three-way match already exists for this PO/GRN pair",
        )

    grn_items = db.query(GRNItem).filter(GRNItem.grn_id == grn_id).all()
    total_received_qty = sum(float(item.received_qty) for item in grn_items)

    # Fairer variance baseline: compare the invoice against the value of the
    # goods this GRN was authorised to deliver, not the PO's entire grand
    # total. A PO can legitimately receive/ invoice in multiple phases;
    # comparing one invoice against the whole PO total would always
    # over-report "mismatch". Falls back to the whole-PO total only if a GRN
    # item can't be resolved to its PO item.
    # R2-240: receipt quantities are not gated upstream (R2-239), so the
    # baseline itself must be immune to over-receipt. Each line counts only
    # the quantity still authorised on its PO line after every earlier GRN on
    # this PO - min(received_qty, ordered - already received) x rate - so
    # receiving 150 bags against an order of 100 cannot raise what a vendor
    # may over-bill into a "match".
    # Tax basis: both branches below are tax-inclusive, matching the invoiced
    # figure (bill.total_payable includes tax). Before R2-240 the GRN branch
    # was exclusive while this fallback was inclusive, so the same invoice
    # produced two different variances depending on which branch ran.
    po_items_by_id = {pi.id: pi for pi in db.query(PurchaseOrderItem).filter(PurchaseOrderItem.po_id == po_id).all()}
    ordered_qty_total = sum(float(pi.quantity or 0) for pi in po_items_by_id.values())
    received_before_this_grn = {}
    prior_rows = (
        db.query(GRNItem.po_item_id, func.sum(GRNItem.received_qty))
        .join(GoodsReceiptNote, GoodsReceiptNote.id == GRNItem.grn_id)
        .filter(GoodsReceiptNote.po_id == po_id, GoodsReceiptNote.id != grn_id)
        .group_by(GRNItem.po_item_id)
        .all()
    )
    for po_item_id, prior_qty in prior_rows:
        received_before_this_grn[po_item_id] = float(prior_qty or 0)
    grn_received_value = 0.0
    grn_value_resolved = True
    for item in grn_items:
        pi = po_items_by_id.get(item.po_item_id)
        if pi is None or pi.rate is None:
            grn_value_resolved = False
            break
        still_authorised = max(float(pi.quantity or 0) - received_before_this_grn.get(item.po_item_id, 0.0), 0.0)
        counted_qty = min(float(item.received_qty), still_authorised)
        line_excl_tax = counted_qty * float(pi.rate)
        grn_received_value += line_excl_tax + line_excl_tax * float(pi.tax_pct or 0) / 100.0
    po_amount = grn_received_value if grn_value_resolved and grn_items else float(po.total_amount)

    variance = round(invoiced_amount - po_amount, 2)
    # R2-241: the verdict is always server-computed from the variance; the
    # caller cannot supply or override match_status.
    tolerance = max(MATCH_TOLERANCE_MIN, abs(po_amount) * MATCH_TOLERANCE_PCT)
    match_status = "matched" if abs(variance) <= tolerance else "mismatch"

    match = ThreeWayMatch(
        company_id=payload.company_id,
        project_id=payload.project_id,
        po_id=po_id,
        grn_id=grn_id,
        invoice_id=payload.invoice_id,
        match_status=match_status,
        po_amount=Decimal(str(po_amount)),
        grn_qty=Decimal(str(total_received_qty)),
        invoiced_amount=Decimal(str(invoiced_amount)),
        variance_amount=Decimal(str(variance)),
        variance_reason=payload.variance_reason,
        matched_by=current_user.id if match_status == "matched" else None,
        matched_at=datetime.now(timezone.utc) if match_status == "matched" else None,
    )
    db.add(match)
    db.commit()
    db.refresh(match)
    return ThreeWayMatchResponse(
        **{**match.__dict__},
        po_number=po.po_number,
        grn_number=grn.grn_number,
        ordered_qty=ordered_qty_total,
        received_qty=total_received_qty,
        po_total=float(po.total_amount),
    )


@router.get("/{company_id}", response_model=List[ThreeWayMatchResponse])
def list_matches(company_id: uuid.UUID, project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    query = db.query(ThreeWayMatch).filter(ThreeWayMatch.company_id == company_id)
    if project_id:
        query = query.filter(ThreeWayMatch.project_id == project_id)
    matches = query.order_by(ThreeWayMatch.created_at.desc()).all()
    # R2-240: resolve every listed match's authorised quantity in one batched
    # query so the approver sees ordered vs received vs PO total per row.
    po_ids = list({m.po_id for m in matches if m.po_id})
    grn_ids = list({m.grn_id for m in matches if m.grn_id})
    ordered_by_po = {}
    if po_ids:
        rows = (
            db.query(PurchaseOrderItem.po_id, func.sum(PurchaseOrderItem.quantity))
            .filter(PurchaseOrderItem.po_id.in_(po_ids))
            .group_by(PurchaseOrderItem.po_id)
            .all()
        )
        ordered_by_po = {pid: float(q or 0) for pid, q in rows}
    pos_by_id = {p.id: p for p in db.query(PurchaseOrder).filter(PurchaseOrder.id.in_(po_ids)).all()} if po_ids else {}
    grns_by_id = {g.id: g for g in db.query(GoodsReceiptNote).filter(GoodsReceiptNote.id.in_(grn_ids)).all()} if grn_ids else {}
    result = []
    for m in matches:
        po = pos_by_id.get(m.po_id)
        grn = grns_by_id.get(m.grn_id)
        result.append(ThreeWayMatchResponse(
            **{**m.__dict__},
            po_number=po.po_number if po else None,
            grn_number=grn.grn_number if grn else None,
            ordered_qty=ordered_by_po.get(m.po_id),
            received_qty=float(m.grn_qty or 0),
            po_total=float(po.total_amount) if po else None,
        ))
    return result


def _grn_is_cancelled(db: Session, grn_id) -> bool:
    # cancel_grn records the reversal as a grn_cancellation stock movement.
    return db.query(MaterialTransaction).filter(
        MaterialTransaction.source_ref_id == grn_id,
        MaterialTransaction.type == "grn_cancellation",
    ).first() is not None


@router.get("/pos/{company_id}", response_model=List[PORef])
def list_pos(company_id: uuid.UUID, project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    # Only what can still be matched: create_match refuses cancelled POs.
    query = db.query(PurchaseOrder).filter(PurchaseOrder.company_id == company_id, PurchaseOrder.status != "cancelled")
    if project_id:
        query = query.filter(PurchaseOrder.project_id == project_id)
    return query.order_by(PurchaseOrder.created_at.desc()).limit(100).all()


@router.get("/grns/{company_id}", response_model=List[GRNRef])
def list_grns(company_id: uuid.UUID, project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    cancelled = db.query(MaterialTransaction.source_ref_id).filter(MaterialTransaction.type == "grn_cancellation")
    query = db.query(GoodsReceiptNote).filter(
        GoodsReceiptNote.company_id == company_id, GoodsReceiptNote.id.notin_(cancelled))
    if project_id:
        query = query.filter(GoodsReceiptNote.project_id == project_id)
    return query.order_by(GoodsReceiptNote.created_at.desc()).limit(100).all()


def _ordered_qty_for(db: Session, po_id: str) -> float:
    # R2-240: the total quantity authorised across the PO's lines.
    total = db.query(func.sum(PurchaseOrderItem.quantity)).filter(PurchaseOrderItem.po_id == po_id).scalar()
    return float(total or 0)


@router.patch("/{match_id}/approve", response_model=ThreeWayMatchResponse)
def approve_match(match_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    match = db.query(ThreeWayMatch).filter(ThreeWayMatch.id == match_id).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
    get_company_membership(db, current_user, match.company_id)
    require_permission(db, current_user, match.company_id, "finance:approve")
    # R2-539: the approving actor is the authenticated user, never a
    # caller-supplied query parameter.
    match.match_status = "approved"
    match.matched_by = current_user.id
    match.matched_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(match)
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == match.po_id).first()
    grn = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.id == match.grn_id).first()
    return ThreeWayMatchResponse(
        **{**match.__dict__},
        po_number=po.po_number if po else None,
        grn_number=grn.grn_number if grn else None,
        ordered_qty=_ordered_qty_for(db, match.po_id),
        received_qty=float(match.grn_qty or 0),
        po_total=float(po.total_amount) if po else None,
    )


@router.patch("/{match_id}/reject", response_model=ThreeWayMatchResponse)
def reject_match(match_id: uuid.UUID, reason: Optional[str] = None, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    match = db.query(ThreeWayMatch).filter(ThreeWayMatch.id == match_id).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
    get_company_membership(db, current_user, match.company_id)
    require_permission(db, current_user, match.company_id, "finance:approve")
    # R2-539: a rejection records who refused and when, like an approval does.
    match.match_status = "rejected"
    match.matched_by = current_user.id
    match.matched_at = datetime.now(timezone.utc)
    match.variance_reason = reason or match.variance_reason
    db.commit()
    db.refresh(match)
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == match.po_id).first()
    grn = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.id == match.grn_id).first()
    return ThreeWayMatchResponse(
        **{**match.__dict__},
        po_number=po.po_number if po else None,
        grn_number=grn.grn_number if grn else None,
        ordered_qty=_ordered_qty_for(db, match.po_id),
        received_qty=float(match.grn_qty or 0),
        po_total=float(po.total_amount) if po else None,
    )


@router.delete("/{match_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_three_way_match(match_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void a three-way match record with audit log."""
    m = db.query(ThreeWayMatch).filter(ThreeWayMatch.id == match_id).first()
    if not m:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Three-way match not found")
    get_company_membership(db, current_user, m.company_id)
    require_permission(db, current_user, m.company_id, "billing:edit")
    log_deletion(
        db,
        company_id=m.company_id,
        entity_type="three_way_match",
        entity_id=m.id,
        summary=f"Three-way match PO {m.po_id} GRN {m.grn_id} Bill {m.invoice_id}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(m)
    db.commit()

