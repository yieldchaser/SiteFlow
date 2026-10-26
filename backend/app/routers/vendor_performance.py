from uuid import UUID
from datetime import datetime, timedelta
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


@router.get("/vendors/performance/{project_id}", response_model=List[VendorPerformanceResponse])
def get_vendor_performance(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    records = db.query(VendorPerformance).filter(
        VendorPerformance.project_id == project_id
    ).all()

    mapped = []
    for v in records:
        mapped.append(VendorPerformanceResponse(
            id=v.id,
            company_id=v.company_id,
            project_id=v.project_id,
            vendor_id=v.vendor_id,
            vendor_name=v.vendor_name,
            total_pos=v.total_pos,
            total_grns=v.total_grns,
            on_time_deliveries=v.on_time_deliveries,
            quality_issues=v.quality_issues,
            avg_delay_days=float(v.avg_delay_days),
            last_updated=v.last_updated,
        ))
    return mapped


def refresh_vendor_performance(db: Session, project_id: UUID, company_id: UUID):
    from app.models import PurchaseOrder, GoodsReceiptNote, PurchaseOrderItem, NCR
    pos = db.query(PurchaseOrder).filter(
        PurchaseOrder.project_id == project_id,
        PurchaseOrder.company_id == company_id
    ).all()

    vendor_map = {}
    for po in pos:
        vendor_id = po.vendor_id
        vendor_name = resolve_party_name(db, vendor_id, fallback=f"Vendor-{str(vendor_id)[:8]}")
        if vendor_id not in vendor_map:
            vendor_map[vendor_id] = {
                "company_id": company_id,
                "project_id": project_id,
                "vendor_id": vendor_id,
                "vendor_name": vendor_name,
                "total_pos": 0,
                "total_grns": 0,
                "on_time_deliveries": 0,
                "quality_issues": 0,
                "total_delay_days": 0.0,
                "grn_count_for_delay": 0,
            }
        vm = vendor_map[vendor_id]
        vm["total_pos"] += 1

        grns = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.po_id == po.id).all()
        for grn in grns:
            vm["total_grns"] += 1
            delay_days = 0
            baseline = po.expected_delivery_date or po.po_date
            if baseline and grn.received_date:
                delay_days = max(0, (grn.received_date - baseline).days)
            if delay_days <= 0:
                vm["on_time_deliveries"] += 1
            else:
                vm["total_delay_days"] += delay_days
                vm["grn_count_for_delay"] += 1

    ncr_counts = {}
    for row in (
        db.query(NCR.vendor_id, func.count(NCR.id))
        .filter(NCR.project_id == project_id, NCR.vendor_id.isnot(None))
        .group_by(NCR.vendor_id)
        .all()
    ):
        ncr_counts[row[0]] = int(row[1])

    for vendor_id, vm in vendor_map.items():
        existing = db.query(VendorPerformance).filter(
            VendorPerformance.project_id == project_id,
            VendorPerformance.vendor_id == vendor_id
        ).first()
        quality_issues = ncr_counts.get(vendor_id, 0)
        if existing:
            existing.total_pos = vm["total_pos"]
            existing.total_grns = vm["total_grns"]
            existing.on_time_deliveries = vm["on_time_deliveries"]
            existing.quality_issues = quality_issues
            existing.avg_delay_days = round(vm["total_delay_days"] / vm["grn_count_for_delay"], 2) if vm["grn_count_for_delay"] > 0 else 0.0
            existing.last_updated = datetime.utcnow()
        else:
            vp = VendorPerformance(
                company_id=vm["company_id"],
                project_id=vm["project_id"],
                vendor_id=vm["vendor_id"],
                vendor_name=vm["vendor_name"],
                total_pos=vm["total_pos"],
                total_grns=vm["total_grns"],
                on_time_deliveries=vm["on_time_deliveries"],
                quality_issues=quality_issues,
                avg_delay_days=round(vm["total_delay_days"] / vm["grn_count_for_delay"], 2) if vm["grn_count_for_delay"] > 0 else 0.0,
            )
            db.add(vp)
    db.commit()


@router.post("/vendors/performance/{project_id}/refresh", response_model=List[VendorPerformanceResponse])
def refresh_project_vendor_performance(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    from app.models import Project
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    refresh_vendor_performance(db, project_id, project.company_id)
    records = db.query(VendorPerformance).filter(
        VendorPerformance.project_id == project_id
    ).all()
    return [
        VendorPerformanceResponse(
            id=v.id,
            company_id=v.company_id,
            project_id=v.project_id,
            vendor_id=v.vendor_id,
            vendor_name=v.vendor_name,
            total_pos=v.total_pos,
            total_grns=v.total_grns,
            on_time_deliveries=v.on_time_deliveries,
            quality_issues=v.quality_issues,
            avg_delay_days=float(v.avg_delay_days),
            last_updated=v.last_updated,
        )
        for v in records
    ]


@router.get("/duplicate-po-check", response_model=DuplicatePOCheckResponse)
def check_duplicate_po(
    company_id: UUID,
    po_number: str = Query(..., description="PO number to check"),
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access)
):
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
