"""One name, one library entry.

A double click on Save sent two requests and the library got two vendors
with the same name. Every library list now refuses a second entry whose name
matches an existing one, ignoring case and extra spaces. Some lists allow the
same name in a different group: a vendor and a client may share a name, a
sub category may repeat under another parent, a rate may repeat in another unit.

Two saves that arrive together are put in a queue on Postgres, so the second
one sees the first and is refused.
"""
from fastapi import HTTPException
from sqlalchemy import text

from app import models

# Fields that make the same name a different entry.
_SCOPE = {
    models.LibraryParty: ("party_type",),
    models.MaterialCategory: ("parent_id",),
    models.LibraryRate: ("unit",),
}

_WHAT = {
    models.LibraryParty: "party",
    models.LibraryAssetType: "asset type",
    models.LibraryDeduction: "deduction",
    models.LibraryProgress: "progress stage",
    models.LibraryWorkforce: "workforce type",
    models.LibraryMaterial: "material",
    models.LibraryRate: "rate card item",
    models.LibraryRetention: "retention",
    models.MaterialCategory: "category",
}


def norm_name(name) -> str:
    return " ".join(str(name or "").split()).lower()


def _lock(db, key: str) -> None:
    bind = db.get_bind()
    if bind is not None and bind.dialect.name == "postgresql":
        # Held until this request commits or rolls back.
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": key})


def refuse_same_name(db, model, company_id, name, exclude_id=None, **scope) -> None:
    key = norm_name(name)
    if not key:
        return
    fields = _SCOPE.get(model, ())
    scope = {f: scope.get(f) for f in fields}
    _lock(db, f"{model.__tablename__}:{company_id}:{key}:" + ":".join(norm_name(scope[f]) for f in fields))
    q = db.query(model).filter(model.company_id == company_id)
    for f, v in scope.items():
        col = getattr(model, f)
        q = q.filter(col.is_(None)) if v in (None, "") else q.filter(col == v)
    if exclude_id is not None:
        q = q.filter(model.id != exclude_id)
    for row in q.all():
        if norm_name(row.name) == key:
            what = (scope.get("party_type") or "").strip().lower() or _WHAT.get(model, "entry")
            where = f" in {scope['unit']}" if scope.get("unit") else ""
            raise HTTPException(
                status_code=409,
                detail=f"{row.name.strip()} is already in the library as a {what}{where}. "
                       f"Open it from the list instead of adding it again.",
            )


def refuse_same_name_on_create(db, model, payload) -> None:
    refuse_same_name(db, model, payload.company_id, payload.name,
                     **{f: getattr(payload, f, None) for f in _SCOPE.get(model, ())})


def refuse_same_name_on_update(db, item, payload) -> None:
    changes = payload.model_dump(exclude_unset=True)
    fields = ("name",) + _SCOPE.get(type(item), ())
    if not any(f in changes for f in fields):
        return
    new = {f: changes.get(f, getattr(item, f)) for f in fields}
    if all((norm_name(new[f]) if f == "name" else new[f]) == (norm_name(getattr(item, f)) if f == "name" else getattr(item, f)) for f in fields):
        return
    refuse_same_name(db, type(item), item.company_id, new.pop("name"), exclude_id=item.id, **new)
