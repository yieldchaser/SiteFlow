from uuid import UUID
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user, verify_company_access, verify_project_access
from app.models import PurchaseOrder, VendorPerformance, CompanyTeam
from app.party_names import resolve_party_name
from pydantic import BaseModel

router = APIRouter(
    prefix="/procurement",
    tags=["Vendor Performance & Duplicate Checks"],
    dependencies=[Depends(get_current_user)]
)


class VendorPerformanceResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    vendor_id: Optional[UUID] = None
    vendor_name: str
    total_pos: int
    total_grns: int
    on_time_deliveries: int
    overdue_orders: int = 0
    quality_issues: int
    avg_delay_days: float
    last_updated: datetime

    class Config:
        from_attributes = True


class DuplicatePOCheckResponse(BaseModel):
    is_duplicate: bool
    po_number: str
    existing_po_ids: List[str] = []
    message: str


def _aware(d):
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _compute_vendor_performance(db: Session, project_id: UUID, company_id: UUID) -> dict:
    """Per vendor on a project: orders, deliveries, on-time deliveries, orders
    past their delivery date with goods still to come, and days late.

    Cancelled orders and cancelled receipts are left out. An order past its
    expected date with goods still to come counts as late by the days it is
    overdue today; before, a vendor who never delivered showed 0 days late."""
    from app.models import PurchaseOrder, GoodsReceiptNote, PurchaseOrderItem, GRNItem, NCR, MaterialTransaction
    pos = db.query(PurchaseOrder).filter(
        PurchaseOrder.project_id == project_id,
        PurchaseOrder.company_id == company_id
    ).all()
    today = datetime.now(timezone.utc)

    vendor_map = {}
    for po in pos:
        if (po.status or "").lower() in ("cancelled", "draft", "rejected"):
            continue
        vendor_id = po.vendor_id
        if vendor_id not in vendor_map:
            vendor_map[vendor_id] = {
                "vendor_name": resolve_party_name(db, vendor_id, fallback=f"Vendor-{str(vendor_id)[:8]}"),
                "total_pos": 0,
                "total_grns": 0,
                "on_time_deliveries": 0,
                "overdue_orders": 0,
                "late_days": [],
            }
        vm = vendor_map[vendor_id]
        vm["total_pos"] += 1
        baseline = _aware(po.expected_delivery_date or po.po_date)

        live = []
        for grn in db.query(GoodsReceiptNote).filter(GoodsReceiptNote.po_id == po.id).all():
            cancelled = db.query(MaterialTransaction.id).filter(
                MaterialTransaction.source_ref_id == grn.id,
                MaterialTransaction.type == "grn_cancellation",
            ).first() is not None
            if not cancelled:
                live.append(grn)
        for grn in live:
            vm["total_grns"] += 1
            received = _aware(grn.received_date)
            delay_days = max(0, (received - baseline).days) if (baseline and received) else 0
            if delay_days <= 0:
                vm["on_time_deliveries"] += 1
            else:
                vm["late_days"].append(delay_days)

        if (po.status or "").lower() in ("closed", "received") or not baseline or baseline >= today:
            continue
        ordered = sum(float(i.quantity or 0) for i in db.query(PurchaseOrderItem).filter(PurchaseOrderItem.po_id == po.id).all())
        got = 0.0
        if live:
            got = sum(float(q or 0) for (q,) in db.query(GRNItem.received_qty).filter(
                GRNItem.grn_id.in_([g.id for g in live])).all())
        if got + 1e-9 < ordered:
            vm["overdue_orders"] += 1
            vm["late_days"].append((today - baseline).days)

    ncr_counts = {}
    for row in (
        db.query(NCR.vendor_id, func.count(NCR.id))
        .filter(NCR.project_id == project_id, NCR.vendor_id.isnot(None))
        .group_by(NCR.vendor_id)
        .all()
    ):
        ncr_counts[row[0]] = int(row[1])
    for vendor_id, vm in vendor_map.items():
        vm["quality_issues"] = ncr_counts.get(vendor_id, 0)
        vm["avg_delay_days"] = round(sum(vm["late_days"]) / len(vm["late_days"]), 2) if vm["late_days"] else 0.0
    return vendor_map


def refresh_vendor_performance(db: Session, project_id: UUID, company_id: UUID):
    vendor_map = _compute_vendor_performance(db, project_id, company_id)
    for vendor_id, vm in vendor_map.items():
        existing = db.query(VendorPerformance).filter(
            VendorPerformance.project_id == project_id,
            VendorPerformance.vendor_id == vendor_id
        ).first()
        if existing is None:
            existing = VendorPerformance(company_id=company_id, project_id=project_id,
                                         vendor_id=vendor_id, vendor_name=vm["vendor_name"])
            db.add(existing)
        existing.total_pos = vm["total_pos"]
        existing.total_grns = vm["total_grns"]
        existing.on_time_deliveries = vm["on_time_deliveries"]
        existing.quality_issues = vm["quality_issues"]
        existing.avg_delay_days = vm["avg_delay_days"]
        existing.last_updated = datetime.utcnow()
    db.commit()
    return vendor_map


def _live_rows(db: Session, project_id: UUID) -> list:
    from app.models import Project
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    computed = refresh_vendor_performance(db, project_id, project.company_id)
    rows = []
    for v in db.query(VendorPerformance).filter(VendorPerformance.project_id == project_id).all():
        vm = computed.get(v.vendor_id)
        if vm is None:
            continue  # a vendor whose only orders were cancelled
        rows.append(VendorPerformanceResponse(
            id=v.id, company_id=v.company_id, project_id=v.project_id, vendor_id=v.vendor_id,
            vendor_name=v.vendor_name, total_pos=vm["total_pos"], total_grns=vm["total_grns"],
            on_time_deliveries=vm["on_time_deliveries"], overdue_orders=vm["overdue_orders"],
            quality_issues=vm["quality_issues"], avg_delay_days=vm["avg_delay_days"],
            last_updated=v.last_updated,
        ))
    return rows


@router.get("/vendors/performance/{project_id}", response_model=List[VendorPerformanceResponse])
def get_vendor_performance(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    # Worked out on every open: an overdue order gets later each day, so
    # figures saved at the last receipt went stale.
    return _live_rows(db, project_id)


@router.post("/vendors/performance/{project_id}/refresh", response_model=List[VendorPerformanceResponse])
def refresh_project_vendor_performance(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    return _live_rows(db, project_id)


@router.get("/duplicate-po-check", response_model=DuplicatePOCheckResponse)
def check_duplicate_po(
    company_id: UUID,
    po_number: str = Query(..., description="PO number to check"),
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access)
):
    # Blank means "give me the next number", which create_po assigns, so it
    # cannot clash. Matching it against old unnumbered POs blocked every save.
    if not po_number.strip():
        return DuplicatePOCheckResponse(
            is_duplicate=False, po_number=po_number, existing_po_ids=[],
            message="The next PO number will be assigned.",
        )
    existing = db.query(PurchaseOrder).filter(
        PurchaseOrder.company_id == company_id,
        func.lower(func.trim(PurchaseOrder.po_number)) == func.lower(func.trim(po_number))
    ).all()
    if existing:
        return DuplicatePOCheckResponse(
            is_duplicate=True,
            po_number=po_number,
            existing_po_ids=[str(p.id) for p in existing],
            message=f"Duplicate PO number found. {len(existing)} existing record(s)."
        )
    return DuplicatePOCheckResponse(
        is_duplicate=False,
        po_number=po_number,
        existing_po_ids=[],
        message="No duplicate PO found. Number is available."
    )
