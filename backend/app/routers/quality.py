"""
Phase 10 — Quality Control, Site Inspections & Snag Lists
Endpoints:
  POST   /quality/checklists                         — Create IS-code checklist template
  GET    /quality/checklists/{company_id}            — List checklists
  POST   /quality/checklists/{cl_id}/items           — Add item to checklist
  GET    /quality/checklists/{cl_id}/items           — Get checklist items
  POST   /quality/inspections                        — Start a site inspection
  GET    /quality/inspections/{project_id}           — List inspections for project
  PATCH  /quality/inspections/{insp_id}/respond      — Submit pass/fail responses
  POST   /quality/ncr                                — Raise NCR
  GET    /quality/ncr/{project_id}                   — List NCRs for project
  PATCH  /quality/ncr/{ncr_id}/review               — Move NCR to under_review
  PATCH  /quality/ncr/{ncr_id}/close                — Close NCR with resolution
  POST   /quality/material-tests                     — Log material test result
  GET    /quality/material-tests/{project_id}        — List material tests
"""

import uuid
from datetime import datetime, timezone
from typing import List, Optional
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, model_validator
from app.database import get_db
from app.auth import get_current_user, verify_company_access, verify_project_access, get_company_membership, require_permission
from app.models import (
    QualityChecklist, ChecklistItem, SiteInspection,
    InspectionResponse, NCR, MaterialTestResult, Project, User, Task
)
from app.workflow_controls import enforce_entry_creation_window
from app.routers.delete_logs import log_deletion

router = APIRouter(prefix="/quality", tags=["Quality Control & Inspections"], dependencies=[Depends(get_current_user)])


# ─── Schemas ─────────────────────────────────────────────────────────────────

class ChecklistCreate(BaseModel):
    company_id: uuid.UUID
    title: str
    category: Optional[str] = None
    is_code_reference: Optional[str] = None
    description: Optional[str] = None


class ChecklistUpdate(BaseModel):
    title: Optional[str] = None
    category: Optional[str] = None
    is_code_reference: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


class ChecklistResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    title: str
    category: Optional[str]
    is_code_reference: Optional[str]
    description: Optional[str]
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


class ChecklistItemCreate(BaseModel):
    sequence: int = 1
    description: str
    acceptable_criteria: Optional[str] = None
    is_mandatory: bool = True


class ChecklistItemResponse(BaseModel):
    id: uuid.UUID
    checklist_id: uuid.UUID
    sequence: int
    description: str
    acceptable_criteria: Optional[str]
    is_mandatory: bool

    class Config:
        from_attributes = True


class InspectionCreate(BaseModel):
    project_id: uuid.UUID
    checklist_id: uuid.UUID
    task_id: Optional[uuid.UUID] = None
    zone: Optional[str] = None
    inspection_date: datetime
    overall_remarks: Optional[str] = None


class InspectionResponse_(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    checklist_id: uuid.UUID
    task_id: Optional[uuid.UUID] = None
    zone: Optional[str]
    inspection_date: datetime
    status: str
    pass_count: int
    fail_count: int
    na_count: int
    overall_remarks: Optional[str]
    inspected_by: Optional[uuid.UUID] = None
    inspected_by_name: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ItemResponseCreate(BaseModel):
    checklist_item_id: uuid.UUID
    result: str = Field(..., pattern="^(Pass|Fail|NA)$")
    remarks: Optional[str] = None
    photo_url: Optional[str] = None


class BulkRespondRequest(BaseModel):
    responses: List[ItemResponseCreate]


class NCRCreate(BaseModel):
    project_id: uuid.UUID
    inspection_id: Optional[uuid.UUID] = None
    ncr_number: Optional[str] = None  # omit to auto-generate a sequential number
    title: str
    description: Optional[str] = None
    severity: str = Field("Major", pattern="^(Minor|Major|Critical)$")
    vendor_id: Optional[uuid.UUID] = None
    due_date: Optional[datetime] = None

    @model_validator(mode="after")
    def due_date_not_in_the_past(self):
        if self.due_date is not None:
            due = self.due_date if self.due_date.tzinfo else self.due_date.replace(tzinfo=timezone.utc)
            if due < datetime.now(timezone.utc):
                raise ValueError("due_date cannot be in the past")
        return self


class NCRResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    # The NCR already stores which inspection it came from; the response used to
    # omit it, so the tracker could not show the zone and printed the literal
    # string "Site Zone" on every card.
    inspection_id: Optional[uuid.UUID] = None
    ncr_number: str
    title: str
    severity: str
    status: str
    vendor_id: Optional[uuid.UUID] = None
    raised_by: Optional[uuid.UUID] = None
    assigned_to: Optional[uuid.UUID] = None
    reviewed_by: Optional[uuid.UUID] = None
    reviewed_at: Optional[datetime] = None
    due_date: Optional[datetime]
    resolution_notes: Optional[str]
    closed_at: Optional[datetime]
    closed_by: Optional[uuid.UUID] = None
    created_at: datetime

    class Config:
        from_attributes = True


class MaterialTestCreate(BaseModel):
    project_id: uuid.UUID
    test_type: str
    material: Optional[str] = None
    sample_ref: Optional[str] = None
    test_date: datetime
    result_value: float = Field(..., ge=0)
    unit: Optional[str] = None
    min_acceptable: Optional[float] = Field(None, ge=0)
    max_acceptable: Optional[float] = Field(None, ge=0)
    zone: Optional[str] = None
    remarks: Optional[str] = None

    @model_validator(mode="after")
    def acceptance_range_not_inverted(self):
        if self.min_acceptable is not None and self.max_acceptable is not None and self.min_acceptable > self.max_acceptable:
            raise ValueError("min_acceptable cannot exceed max_acceptable")
        return self


class MaterialTestUpdate(BaseModel):
    test_type: Optional[str] = None
    material: Optional[str] = None
    sample_ref: Optional[str] = None
    test_date: Optional[datetime] = None
    result_value: Optional[float] = None
    unit: Optional[str] = None
    min_acceptable: Optional[float] = None
    max_acceptable: Optional[float] = None
    zone: Optional[str] = None
    remarks: Optional[str] = None

    @model_validator(mode="after")
    def acceptance_range_not_inverted(self):
        if self.min_acceptable is not None and self.max_acceptable is not None and self.min_acceptable > self.max_acceptable:
            raise ValueError("min_acceptable cannot exceed max_acceptable")
        return self


class MaterialTestResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    test_type: str
    material: Optional[str]
    sample_ref: Optional[str]
    test_date: datetime
    result_value: float
    unit: Optional[str]
    min_acceptable: Optional[float]
    max_acceptable: Optional[float]
    is_pass: Optional[bool]
    zone: Optional[str]
    remarks: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


# ─── Checklists ───────────────────────────────────────────────────────────────

@router.post("/checklists", response_model=ChecklistResponse, status_code=status.HTTP_201_CREATED)
def create_checklist(payload: ChecklistCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, payload.company_id, "quality:edit")
    cl = QualityChecklist(**payload.model_dump())
    db.add(cl)
    db.commit()
    db.refresh(cl)
    return cl


@router.get("/checklists/{company_id}", response_model=List[ChecklistResponse])
def list_checklists(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(QualityChecklist).filter(
        QualityChecklist.company_id == company_id,
        QualityChecklist.is_active == True
    ).all()


@router.put("/checklists/{cl_id}", response_model=ChecklistResponse)
def update_checklist(cl_id: uuid.UUID, payload: ChecklistUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    cl = db.query(QualityChecklist).filter(QualityChecklist.id == cl_id).first()
    if not cl:
        raise HTTPException(status_code=404, detail="Checklist not found")
    get_company_membership(db, current_user, cl.company_id)
    require_permission(db, current_user, cl.company_id, "quality:edit")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(cl, k, v)
    db.commit()
    db.refresh(cl)
    return cl


@router.delete("/checklists/{cl_id}")
def delete_checklist(cl_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    cl = db.query(QualityChecklist).filter(QualityChecklist.id == cl_id).first()
    if not cl:
        raise HTTPException(status_code=404, detail="Checklist not found")
    get_company_membership(db, current_user, cl.company_id)
    require_permission(db, current_user, cl.company_id, "quality:edit")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, cl.company_id, "quality_checklist", cl.id, f"Checklist: {cl.title}", deleted_by=current_user.name)
    db.delete(cl)
    db.commit()
    return {"success": True}


@router.post("/checklists/{cl_id}/items", response_model=ChecklistItemResponse, status_code=status.HTTP_201_CREATED)
def add_checklist_item(cl_id: uuid.UUID, payload: ChecklistItemCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    cl = db.query(QualityChecklist).filter(QualityChecklist.id == cl_id).first()
    if not cl:
        raise HTTPException(status_code=404, detail="Checklist not found")
    get_company_membership(db, current_user, cl.company_id)
    require_permission(db, current_user, cl.company_id, "quality:edit")
    item = ChecklistItem(checklist_id=cl_id, **payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/checklists/{cl_id}/items", response_model=List[ChecklistItemResponse])
def get_checklist_items(cl_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    cl = db.query(QualityChecklist).filter(QualityChecklist.id == cl_id).first()
    if not cl:
        raise HTTPException(status_code=404, detail="Checklist not found")
    get_company_membership(db, current_user, cl.company_id)
    return db.query(ChecklistItem).filter(
        ChecklistItem.checklist_id == cl_id
    ).order_by(ChecklistItem.sequence).all()


# ─── Inspections ──────────────────────────────────────────────────────────────

@router.post("/inspections", response_model=InspectionResponse_, status_code=status.HTTP_201_CREATED)
def create_inspection(payload: InspectionCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")
    # Workflow Controls: Entry Controls (creation date window)
    enforce_entry_creation_window(db, project.company_id, payload.inspection_date)
    if payload.task_id:
        task = db.query(Task).filter(Task.id == payload.task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        if task.project_id != payload.project_id:
            raise HTTPException(status_code=400, detail="Task does not belong to this project")
    insp = SiteInspection(**payload.model_dump(), inspected_by=current_user.id)
    db.add(insp)
    db.commit()
    db.refresh(insp)
    return insp


@router.get("/inspections/{project_id}", response_model=List[InspectionResponse_])
def list_inspections(
    project_id: uuid.UUID,
    task_id: Optional[uuid.UUID] = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_project_access)
):
    query = db.query(SiteInspection).filter(SiteInspection.project_id == project_id)
    if task_id:
        query = query.filter(SiteInspection.task_id == task_id)
    rows = query.order_by(SiteInspection.inspection_date.desc()).all()
    # inspected_by is a user id; the register printed it raw as the inspector.
    user_ids = {r.inspected_by for r in rows if r.inspected_by}
    names = dict(db.query(User.id, User.name).filter(User.id.in_(user_ids)).all()) if user_ids else {}
    out = []
    for r in rows:
        item = InspectionResponse_.model_validate(r)
        item.inspected_by_name = names.get(r.inspected_by)
        out.append(item)
    return out


@router.get("/inspections/{insp_id}/responses")
def list_inspection_responses(insp_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    insp = db.query(SiteInspection).filter(SiteInspection.id == insp_id).first()
    if not insp:
        raise HTTPException(status_code=404, detail="Inspection not found")
    project = db.query(Project).filter(Project.id == insp.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    rows = db.query(InspectionResponse).filter(
        InspectionResponse.inspection_id == insp_id
    ).order_by(InspectionResponse.created_at.asc()).all()
    return [
        {
            "id": str(r.id),
            "inspection_id": str(r.inspection_id),
            "checklist_item_id": str(r.checklist_item_id),
            "result": r.result,
            "remarks": r.remarks,
            "photo_url": r.photo_url,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.patch("/inspections/{insp_id}/respond", response_model=InspectionResponse_)
def submit_inspection_responses(
    insp_id: uuid.UUID,
    payload: BulkRespondRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    insp = db.query(SiteInspection).filter(SiteInspection.id == insp_id).first()
    if not insp:
        raise HTTPException(status_code=404, detail="Inspection not found")
    project = db.query(Project).filter(Project.id == insp.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")

    valid_item_ids = {
        item.id
        for item in db.query(ChecklistItem).filter(ChecklistItem.checklist_id == insp.checklist_id).all()
    }

    pass_count = fail_count = na_count = 0

    for resp_data in payload.responses:
        if resp_data.checklist_item_id not in valid_item_ids:
            raise HTTPException(status_code=400, detail="Checklist item does not belong to this inspection's checklist")
        # Upsert: check if response for this item already exists
        existing = db.query(InspectionResponse).filter(
            InspectionResponse.inspection_id == insp_id,
            InspectionResponse.checklist_item_id == resp_data.checklist_item_id
        ).first()

        if existing:
            existing.result = resp_data.result
            existing.remarks = resp_data.remarks
            existing.photo_url = resp_data.photo_url
        else:
            resp = InspectionResponse(
                inspection_id=insp_id,
                **resp_data.model_dump()
            )
            db.add(resp)

    # R2-362: summarize from every stored response for this inspection,
    # never from the current payload alone. The session runs with
    # autoflush=False, so push the upserts above into the transaction before
    # counting.
    db.flush()
    stored_counts = dict(
        db.query(InspectionResponse.result, func.count(InspectionResponse.id))
        .filter(InspectionResponse.inspection_id == insp_id)
        .group_by(InspectionResponse.result)
        .all()
    )
    pass_count = stored_counts.get("Pass", 0)
    fail_count = stored_counts.get("Fail", 0)
    na_count = stored_counts.get("NA", 0)

    # Update inspection summary counts
    insp.pass_count = pass_count
    insp.fail_count = fail_count
    insp.na_count = na_count

    total = pass_count + fail_count
    if total == 0:
        insp.status = "pending"
    elif fail_count == 0:
        insp.status = "pass"
    elif pass_count == 0:
        insp.status = "fail"
    else:
        insp.status = "partial"

    db.commit()
    db.refresh(insp)
    return insp


# ─── NCR ──────────────────────────────────────────────────────────────────────

def _generate_ncr_number(db: Session, project_id: uuid.UUID) -> str:
    """Return the next sequential NCR number for the project.

    Produces NCR-NNNN where NNNN is the next integer past the current count.
    Bumps past any collision from concurrent creates, mirroring
    _generate_grn_number in procurement.py.
    """
    count = db.query(NCR).filter(NCR.project_id == project_id).count()
    candidate = f"NCR-{count + 1:04d}"
    while db.query(NCR).filter(
        NCR.project_id == project_id,
        NCR.ncr_number == candidate,
    ).first():
        count += 1
        candidate = f"NCR-{count + 1:04d}"
    return candidate


@router.post("/ncr", response_model=NCRResponse, status_code=status.HTTP_201_CREATED)
def raise_ncr(payload: NCRCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")
    # Auto-assign a sequential number when the caller omits it.
    ncr_number = payload.ncr_number or _generate_ncr_number(db, payload.project_id)
    # R2-386: ncr_number is unique per project. Answer a friendly conflict
    # before the database constraint (uq_ncrs_project_id_ncr_number) does.
    dup = db.query(NCR).filter(
        NCR.project_id == payload.project_id,
        NCR.ncr_number == ncr_number,
    ).first()
    if dup:
        raise HTTPException(
            status_code=409,
            detail=f"An NCR with number '{ncr_number}' already exists for this project. Use a unique NCR number.",
        )
    data = payload.model_dump()
    data["ncr_number"] = ncr_number
    ncr = NCR(**data, raised_by=current_user.id, assigned_to=current_user.id)
    db.add(ncr)
    db.commit()
    db.refresh(ncr)
    return ncr


@router.get("/ncr/{project_id}", response_model=List[NCRResponse])
def list_ncrs(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    return db.query(NCR).filter(
        NCR.project_id == project_id
    ).order_by(NCR.created_at.desc()).all()


@router.patch("/ncr/{ncr_id}/review", response_model=NCRResponse)
def ncr_under_review(ncr_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ncr = db.query(NCR).filter(NCR.id == ncr_id).first()
    if not ncr:
        raise HTTPException(status_code=404, detail="NCR not found")
    project = db.query(Project).filter(Project.id == ncr.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")
    if ncr.status != "open":
        raise HTTPException(status_code=400, detail="Only open NCRs can move to under_review")
    ncr.status = "under_review"
    ncr.reviewed_by = current_user.id
    ncr.reviewed_at = datetime.utcnow()
    db.commit()
    db.refresh(ncr)
    return ncr


class NCRCloseRequest(BaseModel):
    resolution_notes: str


@router.patch("/ncr/{ncr_id}/close", response_model=NCRResponse)
def close_ncr(ncr_id: uuid.UUID, payload: NCRCloseRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ncr = db.query(NCR).filter(NCR.id == ncr_id).first()
    if not ncr:
        raise HTTPException(status_code=404, detail="NCR not found")
    project = db.query(Project).filter(Project.id == ncr.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")
    if ncr.status == "closed":
        raise HTTPException(status_code=400, detail="NCR is already closed")
    if ncr.status != "under_review":
        raise HTTPException(status_code=400, detail="NCR must be reviewed before it can be closed")
    ncr.status = "closed"
    ncr.resolution_notes = payload.resolution_notes
    ncr.closed_at = datetime.utcnow()
    ncr.closed_by = current_user.id
    db.commit()
    db.refresh(ncr)
    return ncr


# ─── Material Tests ───────────────────────────────────────────────────────────

@router.post("/material-tests", response_model=MaterialTestResponse, status_code=status.HTTP_201_CREATED)
def log_material_test(payload: MaterialTestCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")
    data = payload.model_dump()

    # Auto-compute pass/fail from min/max bounds if provided
    is_pass = None
    val = data["result_value"]
    mn = data.get("min_acceptable")
    mx = data.get("max_acceptable")
    if mn is not None and mx is not None:
        is_pass = bool(mn <= val <= mx)
    elif mn is not None:
        is_pass = bool(val >= mn)
    elif mx is not None:
        is_pass = bool(val <= mx)

    # Convert floats to Decimal for Numeric columns
    for field in ("result_value", "min_acceptable", "max_acceptable"):
        if data.get(field) is not None:
            data[field] = Decimal(str(data[field]))

    test = MaterialTestResult(**data, is_pass=is_pass)
    db.add(test)
    db.commit()
    db.refresh(test)
    return test


@router.get("/material-tests/{project_id}", response_model=List[MaterialTestResponse])
def list_material_tests(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    return db.query(MaterialTestResult).filter(
        MaterialTestResult.project_id == project_id
    ).order_by(MaterialTestResult.test_date.desc()).all()


@router.put("/material-tests/{test_id}", response_model=MaterialTestResponse)
def update_material_test(test_id: uuid.UUID, payload: MaterialTestUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    test = db.query(MaterialTestResult).filter(MaterialTestResult.id == test_id).first()
    if not test:
        raise HTTPException(status_code=404, detail="Material test not found")
    project = db.query(Project).filter(Project.id == test.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")

    data = payload.model_dump(exclude_unset=True)
    val = data.get("result_value", float(test.result_value))
    mn = data.get("min_acceptable", float(test.min_acceptable) if test.min_acceptable is not None else None)
    mx = data.get("max_acceptable", float(test.max_acceptable) if test.max_acceptable is not None else None)

    is_pass = None
    if mn is not None and mx is not None:
        is_pass = bool(mn <= val <= mx)
    elif mn is not None:
        is_pass = bool(val >= mn)
    elif mx is not None:
        is_pass = bool(val <= mx)

    for k, v in data.items():
        if k in ("result_value", "min_acceptable", "max_acceptable") and v is not None:
            setattr(test, k, Decimal(str(v)))
        else:
            setattr(test, k, v)
    test.is_pass = is_pass

    db.commit()
    db.refresh(test)
    return test


@router.delete("/material-tests/{test_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_material_test(test_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    test = db.query(MaterialTestResult).filter(MaterialTestResult.id == test_id).first()
    if not test:
        raise HTTPException(status_code=404, detail="Material test not found")
    project = db.query(Project).filter(Project.id == test.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")

    log_deletion(
        db,
        company_id=project.company_id,
        entity_type="material_test",
        entity_id=test.id,
        summary=f"Material test: {test.test_type} ({test.material or 'General'})",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(test)
    db.commit()


@router.delete("/ncr/{ncr_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ncr(ncr_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void an NCR with audit log."""
    ncr = db.query(NCR).filter(NCR.id == ncr_id).first()
    if not ncr:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="NCR not found")
    project = db.query(Project).filter(Project.id == ncr.project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")
    log_deletion(
        db,
        company_id=project.company_id,
        entity_type="ncr",
        entity_id=ncr.id,
        summary=f"NCR {ncr.ncr_number}: {ncr.description}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(ncr)
    db.commit()


@router.delete("/inspections/{insp_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_inspection(insp_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void a Site Inspection and its responses with audit log."""
    insp = db.query(SiteInspection).filter(SiteInspection.id == insp_id).first()
    if not insp:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site inspection not found")
    project = db.query(Project).filter(Project.id == insp.project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "quality:edit")
    db.query(InspectionResponse).filter(InspectionResponse.inspection_id == insp.id).delete()
    log_deletion(
        db,
        company_id=project.company_id,
        entity_type="site_inspection",
        entity_id=insp.id,
        summary=f"Site inspection for zone {insp.zone or 'N/A'}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(insp)
    db.commit()

