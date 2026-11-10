import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.database import get_db
from app.auth import get_current_user, verify_company_access, get_company_membership, require_permission
from app.models import CustomField, CustomFieldValue, User, Project, Task, Bill, CRMLead
from app.routers.delete_logs import log_deletion

router = APIRouter(prefix="/custom-fields", tags=["Custom Fields"], dependencies=[Depends(get_current_user)])

CUSTOM_FIELD_ENTITY_TYPES = ("project", "task", "bill", "invoice", "lead", "vendor")
CUSTOM_FIELD_TYPES = ("text", "number", "date", "select", "multiselect", "checkbox")
CUSTOM_FIELD_ENTITY_TYPE_PATTERN = f"^({'|'.join(CUSTOM_FIELD_ENTITY_TYPES)})$"
CUSTOM_FIELD_TYPE_PATTERN = f"^({'|'.join(CUSTOM_FIELD_TYPES)})$"

CUSTOM_FIELD_ENTITY_MODELS = {
    "project": Project,
    "task": Task,
    "bill": Bill,
    "invoice": Bill,
    "lead": CRMLead,
}


class CustomFieldCreate(BaseModel):
    # R2-180: a typo'd field name must be a 422, not a silently dropped key
    # behind a 200 (extra="ignore" is the Pydantic default).
    model_config = ConfigDict(extra="forbid")

    company_id: uuid.UUID
    entity_type: str = Field(..., pattern=CUSTOM_FIELD_ENTITY_TYPE_PATTERN)
    field_name: str
    field_label: str
    field_type: str = Field(..., pattern=CUSTOM_FIELD_TYPE_PATTERN)
    is_required: bool = False
    options: List[str] = []
    display_order: int = 0
    default_value: Optional[str] = None
    set_default: bool = False

    @model_validator(mode="after")
    def _check(self):
        self.field_label = (self.field_label or "").strip()
        self.field_name = (self.field_name or "").strip() or self.field_label
        if not self.field_label:
            raise ValueError("Give the field a name")
        self.options = [o.strip() for o in self.options if o and o.strip()]
        if self.field_type in ("select", "multiselect") and not self.options:
            raise ValueError("Add the choices people can pick from")
        return self


class CustomFieldUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field_label: Optional[str] = None
    field_type: Optional[str] = Field(None, pattern=CUSTOM_FIELD_TYPE_PATTERN)
    is_required: Optional[bool] = None
    options: Optional[List[str]] = None
    display_order: Optional[int] = None
    default_value: Optional[str] = None
    set_default: Optional[bool] = None
    is_active: Optional[bool] = None


class CustomFieldResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    entity_type: str
    field_name: str
    field_label: str
    field_type: str
    is_required: bool
    options: List[str]
    display_order: int
    is_active: bool
    default_value: Optional[str] = None
    set_default: bool = False
    created_at: datetime

    class Config:
        from_attributes = True


class CustomFieldValueCreate(BaseModel):
    # R2-180: reject unknown keys (see CustomFieldCreate).
    model_config = ConfigDict(extra="forbid")

    company_id: uuid.UUID
    field_id: uuid.UUID
    entity_type: str = Field(..., pattern=CUSTOM_FIELD_ENTITY_TYPE_PATTERN)
    entity_id: uuid.UUID
    value_text: Optional[str] = None
    value_number: Optional[float] = None
    value_date: Optional[datetime] = None
    value_json: Optional[dict] = None


class CustomFieldValueResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    field_id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    value_text: Optional[str]
    value_number: Optional[float]
    value_date: Optional[datetime]
    value_json: Optional[Any]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class CustomFieldValueInput(BaseModel):
    """Generic {field_id, value} pair submitted alongside an entity create/update
    payload (e.g. from a Project or Sales Invoice form). `value` is intentionally
    untyped — its shape depends on the target CustomField.field_type and is
    normalized into value_text/value_number/value_date/value_json by
    `upsert_values_for_entity` below."""
    # R2-180: reject unknown keys (see CustomFieldCreate).
    model_config = ConfigDict(extra="forbid")

    field_id: uuid.UUID
    value: Optional[Any] = None


def _parse_field_date(value: Any) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    candidate = str(value).strip()
    if not candidate:
        return None
    normalized = candidate.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(candidate, fmt)
        except ValueError:
            continue
    return None


def upsert_values_for_entity(
    db: Session,
    company_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
    values: Optional[List[dict]],
) -> None:
    """Persist a batch of custom field values for a single entity record.

    `values` is a list of dict-like {"field_id": ..., "value": ...} pairs (the
    result of calling `.model_dump()` on a list of CustomFieldValueInput). Each
    field's `field_type` (looked up from CustomField) decides which physical
    column the value lands in:
      - text / select      -> value_text
      - number             -> value_number
      - date                -> value_date
      - multiselect         -> value_json (list)
      - checkbox            -> value_json (bool) — there is no dedicated
        boolean column on CustomFieldValue, so booleans are stored in the
        JSONB column rather than stringified into value_text.
    Rows are upserted (matched on field_id + entity_type + entity_id) so
    calling this again on an update simply overwrites the previous value.
    Does not commit — caller is expected to commit as part of its own
    create/update transaction.
    """
    if not values:
        return
    for item in values:
        field_id = item.get("field_id") if isinstance(item, dict) else getattr(item, "field_id", None)
        if not field_id:
            continue
        raw_value = item.get("value") if isinstance(item, dict) else getattr(item, "value", None)

        field = db.query(CustomField).filter(CustomField.id == field_id).first()
        # Only this company's fields for this kind of record.
        if not field or field.company_id != company_id or field.entity_type != entity_type:
            continue

        value_text = value_number = value_date = value_json = None
        if field.field_type == "number":
            if raw_value not in (None, ""):
                try:
                    value_number = Decimal(str(raw_value))
                except (InvalidOperation, ValueError, TypeError):
                    value_number = None
        elif field.field_type == "date":
            value_date = _parse_field_date(raw_value)
        elif field.field_type == "multiselect":
            if isinstance(raw_value, list):
                value_json = raw_value
            elif raw_value not in (None, ""):
                value_json = [raw_value]
            else:
                value_json = []
        elif field.field_type == "checkbox":
            value_json = bool(raw_value)
        else:  # text, select, and any unrecognized type default to text storage
            value_text = None if raw_value in (None, "") else str(raw_value)

        existing = db.query(CustomFieldValue).filter(
            CustomFieldValue.field_id == field_id,
            CustomFieldValue.entity_type == entity_type,
            CustomFieldValue.entity_id == entity_id,
        ).first()

        if existing:
            existing.value_text = value_text
            existing.value_number = value_number
            existing.value_date = value_date
            existing.value_json = value_json
        else:
            db.add(CustomFieldValue(
                company_id=company_id,
                field_id=field_id,
                entity_type=entity_type,
                entity_id=entity_id,
                value_text=value_text,
                value_number=value_number,
                value_date=value_date,
                value_json=value_json,
            ))


def enforce_required_custom_fields(
    db: Session,
    company_id: uuid.UUID,
    entity_type: str,
    values: Optional[List[dict]],
) -> None:
    # A required field counts as filled only with a value: it used to count as
    # soon as its id was sent, so a blank box passed.
    provided = set()
    for item in values or []:
        field_id = item.get("field_id") if isinstance(item, dict) else getattr(item, "field_id", None)
        value = item.get("value") if isinstance(item, dict) else getattr(item, "value", None)
        if isinstance(value, str):
            value = value.strip()
        if field_id and value not in (None, "", []):
            provided.add(str(field_id))
    missing = [
        f.field_label or f.field_name
        for f in db.query(CustomField).filter(
            CustomField.company_id == company_id,
            CustomField.entity_type == entity_type,
            CustomField.is_active == True,
            CustomField.is_required == True,
        ).all()
        if str(f.id) not in provided
    ]
    if missing:
        raise HTTPException(
            status_code=422,
            detail="Fill in: " + ", ".join(missing),
        )


@router.post("/fields", response_model=CustomFieldResponse, status_code=status.HTTP_201_CREATED)
def create_field(payload: CustomFieldCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, payload.company_id, "settings:manage")
    field = CustomField(**payload.model_dump())
    db.add(field)
    db.commit()
    db.refresh(field)
    return field


@router.get("/fields/{company_id}", response_model=List[CustomFieldResponse])
def list_fields(company_id: uuid.UUID, entity_type: Optional[str] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    query = db.query(CustomField).filter(
        CustomField.company_id == company_id,
        CustomField.is_active == True
    )
    if entity_type:
        query = query.filter(CustomField.entity_type == entity_type)
    return query.order_by(CustomField.display_order).all()


@router.post("/values", response_model=CustomFieldValueResponse, status_code=status.HTTP_201_CREATED)
def set_value(payload: CustomFieldValueCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, payload.company_id, "settings:manage")
    field = db.query(CustomField).filter(
        CustomField.id == payload.field_id,
        CustomField.company_id == payload.company_id
    ).first()
    if not field:
        raise HTTPException(status_code=404, detail="Custom field not found")
    entity_model = CUSTOM_FIELD_ENTITY_MODELS.get(payload.entity_type)
    if entity_model is None:
        raise HTTPException(
            status_code=422,
            detail=f"Custom field values cannot be attached to entity_type '{payload.entity_type}'",
        )
    entity = db.query(entity_model).filter(
        entity_model.id == payload.entity_id,
        entity_model.company_id == payload.company_id
    ).first()
    if not entity:
        raise HTTPException(status_code=404, detail=f"{payload.entity_type} not found in this company")

    label = field.field_label or field.field_name
    data = {
        "company_id": payload.company_id,
        "field_id": payload.field_id,
        "entity_type": payload.entity_type,
        "entity_id": payload.entity_id,
        "value_text": None,
        "value_number": None,
        "value_date": None,
        "value_json": None,
    }
    if field.field_type == "number":
        if payload.value_text not in (None, "") or payload.value_date is not None or payload.value_json is not None:
            raise HTTPException(status_code=422, detail=f"Field '{label}' expects a number value")
        if payload.value_number is not None:
            try:
                data["value_number"] = Decimal(str(payload.value_number))
            except InvalidOperation:
                raise HTTPException(status_code=422, detail=f"Field '{label}' expects a number value")
    elif field.field_type == "date":
        if payload.value_text not in (None, "") or payload.value_number is not None or payload.value_json is not None:
            raise HTTPException(status_code=422, detail=f"Field '{label}' expects a date value")
        data["value_date"] = payload.value_date
    elif field.field_type in ("multiselect", "checkbox"):
        if payload.value_text not in (None, "") or payload.value_number is not None or payload.value_date is not None:
            raise HTTPException(status_code=422, detail=f"Field '{label}' expects a {'list' if field.field_type == 'multiselect' else 'boolean'} value")
        if field.field_type == "checkbox" and payload.value_json is not None and not isinstance(payload.value_json, bool):
            raise HTTPException(status_code=422, detail=f"Field '{label}' expects a boolean value")
        data["value_json"] = payload.value_json
    else:
        if payload.value_number is not None or payload.value_date is not None or payload.value_json is not None:
            raise HTTPException(status_code=422, detail=f"Field '{label}' expects a text value")
        data["value_text"] = payload.value_text

    existing = db.query(CustomFieldValue).filter(
        CustomFieldValue.field_id == payload.field_id,
        CustomFieldValue.entity_type == payload.entity_type,
        CustomFieldValue.entity_id == payload.entity_id
    ).first()

    if existing:
        for k, v in data.items():
            setattr(existing, k, v)
        db.commit()
        db.refresh(existing)
        return existing

    value = CustomFieldValue(**data)
    db.add(value)
    db.commit()
    db.refresh(value)
    return value


@router.get("/values/{entity_type}/{entity_id}", response_model=List[CustomFieldValueResponse])
def get_values(entity_type: str, entity_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # R2-157: derive the tenant from the parent entity record, never from the
    # value rows — authorizing against values[0].company_id released a
    # multi-company row set to whichever company sorted first and answered an
    # unchecked empty list (an existence probe) for any UUID. The company filter
    # also keeps a stray foreign-company row out of another tenant's response.
    entity_model = CUSTOM_FIELD_ENTITY_MODELS.get(entity_type)
    if entity_model is None:
        raise HTTPException(
            status_code=422,
            detail=f"Custom field values cannot be attached to entity_type '{entity_type}'",
        )
    entity = db.query(entity_model).filter(entity_model.id == entity_id).first()
    if not entity:
        raise HTTPException(status_code=404, detail=f"{entity_type} not found")
    get_company_membership(db, current_user, entity.company_id)
    return db.query(CustomFieldValue).filter(
        CustomFieldValue.entity_type == entity_type,
        CustomFieldValue.entity_id == entity_id,
        CustomFieldValue.company_id == entity.company_id,
    ).all()


@router.put("/fields/{field_id}", response_model=CustomFieldResponse)
@router.put("/{field_id}", response_model=CustomFieldResponse)
def update_custom_field(field_id: uuid.UUID, payload: CustomFieldUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    cf = db.query(CustomField).filter(CustomField.id == field_id).first()
    if not cf:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom field not found")
    get_company_membership(db, current_user, cf.company_id)
    require_permission(db, current_user, cf.company_id, "settings:manage")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(cf, k, v)
    db.commit()
    db.refresh(cf)
    return cf


@router.delete("/fields/{field_id}", status_code=status.HTTP_204_NO_CONTENT)
@router.delete("/{field_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_custom_field(field_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void a custom field definition and its attached values with audit log."""
    cf = db.query(CustomField).filter(CustomField.id == field_id).first()
    if not cf:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom field not found")
    get_company_membership(db, current_user, cf.company_id)
    require_permission(db, current_user, cf.company_id, "settings:manage")

    db.query(CustomFieldValue).filter(CustomFieldValue.field_id == cf.id).delete()
    log_deletion(
        db,
        company_id=cf.company_id,
        entity_type="custom_field",
        entity_id=cf.id,
        summary=f"Custom field [{cf.entity_type}]: {cf.field_label} ({cf.field_name})",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(cf)
    db.commit()

