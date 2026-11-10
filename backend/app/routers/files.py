import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from fastapi.responses import Response, RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database import get_db
from app.models import FileFolder, ProjectFile, Project
from app.auth import get_current_user, verify_project_access, get_company_membership, require_permission
from app import supabase_storage
from pydantic import BaseModel, Field

router = APIRouter(prefix="/files", tags=["Project Files"], dependencies=[Depends(get_current_user)])

# Reject oversized uploads before buffering the whole body in memory.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB

# Allowlist of content types the product actually needs (documents, images, CAD, archives).
ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/svg+xml",
    "application/dwg",
    "application/x-dwg",
    "application/dxf",
    "application/x-dxf",
    "application/zip",
    "application/x-rar-compressed",
    "application/x-7z-compressed",
    "application/gzip",
    "application/x-tar",
    # Voice notes recorded in the browser (Chrome/Edge webm, Firefox ogg,
    # Safari mp4) and phone recordings (mp3).
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
}


def _sniff_content_type(data: bytes) -> Optional[str]:
    if not data:
        return None
    head = data[:16]
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head[4:8] == b"ftyp":
        return "audio/mp4"
    if head.startswith(b"ID3") or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    if head.startswith(b"PK\x03\x04"):
        return "application/zip"
    if head.startswith(b"Rar!\x1a\x07"):
        return "application/x-rar-compressed"
    if head.startswith(b"\x37\x7a\xbc\xaf\x27\x1c"):
        return "application/x-7z-compressed"
    if head.startswith(b"\x1f\x8b"):
        return "application/gzip"
    if head.startswith(b"BM"):
        return "image/bmp"
    if head.startswith(b"MZ"):
        return "application/x-msdownload"
    if head.startswith(b"\x7fELF"):
        return "application/octet-stream"
    if head.startswith((b"AC10", b"AC1015", b"AC1018", b"AC1021", b"AC1024", b"AC1027", b"AC1032")):
        return "application/dwg"
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "application/vnd.ms-excel"
    if len(data) >= 262 and data[257:262] == b"ustar":
        return "application/x-tar"
    lower = data[:1024].lstrip().lower()
    if lower.startswith((b"<!doctype html", b"<html", b"<head", b"<body", b"<script", b"<!--")):
        return "text/html"
    if lower.startswith((b"<?xml", b"<svg")):
        return "image/svg+xml"
    if lower.startswith((b"0\nsection", b"0\r\nsection", b"0\nheader", b"0\r\nheader")):
        return "application/dxf"
    # Text / CSV detection: valid ASCII/UTF-8 with no null bytes in sample
    sample = data[:4096]
    if b"\x00" not in sample:
        try:
            decoded = sample.decode("utf-8")
            if decoded and all(c.isprintable() or c in "\r\n\t\f\b" for c in decoded):
                return "text/plain"
        except UnicodeDecodeError:
            pass
    return None


# ─── Schemas ───────────────────────────────────────────────────────────────────
class FolderCreateRequest(BaseModel):
    project_id: uuid.UUID
    parent_id: Optional[uuid.UUID] = None
    name: str = Field(..., min_length=1, max_length=255)


class FolderUpdateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


class FolderResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    parent_id: Optional[uuid.UUID] = None
    name: str
    created_at: datetime

    class Config:
        from_attributes = True


class FileMetaResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    folder_id: Optional[uuid.UUID] = None
    name: str
    original_filename: str
    content_type: Optional[str] = None
    size: int
    uploaded_at: datetime

    class Config:
        from_attributes = True


# ─── Helpers ────────────────────────────────────────────────────────────────────
def _require_project(project_id: uuid.UUID, db: Session) -> Project:
    proj = db.query(Project).filter(Project.id == project_id).first()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


def _require_folder_or_root(folder_id: Optional[uuid.UUID], project_id: uuid.UUID, db: Session) -> None:
    if folder_id is None:
        return
    f = db.query(FileFolder).filter(
        FileFolder.id == folder_id, FileFolder.project_id == project_id
    ).first()
    if not f:
        raise HTTPException(status_code=404, detail="Folder not found")


# ─── Endpoints ──────────────────────────────────────────────────────────────────
@router.post("/folders", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
def create_folder(req: FolderCreateRequest, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    # project_id arrives in the request body (not the URL), so the plain
    # verify_project_access dependency cannot bind to it. Load the project and
    # verify company membership inline, otherwise any logged-in user could create
    # folders inside another tenant's project by guessing its id.
    project = _require_project(req.project_id, db)
    get_company_membership(db, current_user, project.company_id)
    _require_folder_or_root(req.parent_id, req.project_id, db)

    existing = db.query(FileFolder).filter(
        FileFolder.project_id == req.project_id,
        FileFolder.parent_id == req.parent_id,
        FileFolder.name == req.name.strip(),
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Folder '{req.name.strip()}' already exists here")

    folder = FileFolder(
        id=uuid.uuid4(),
        project_id=req.project_id,
        parent_id=req.parent_id,
        name=req.name.strip(),
    )
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return FolderResponse(
        id=folder.id,
        project_id=folder.project_id,
        parent_id=folder.parent_id,
        name=folder.name,
        created_at=folder.created_at,
    )


@router.put("/folders/{folder_id}", response_model=FolderResponse)
def update_folder(folder_id: uuid.UUID, req: FolderUpdateRequest, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    folder = db.query(FileFolder).filter(FileFolder.id == folder_id).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    project = _require_project(folder.project_id, db)
    get_company_membership(db, current_user, project.company_id)

    new_name = req.name.strip()
    existing = db.query(FileFolder).filter(
        FileFolder.project_id == folder.project_id,
        FileFolder.parent_id == folder.parent_id,
        FileFolder.name == new_name,
        FileFolder.id != folder_id,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Folder '{new_name}' already exists here")

    folder.name = new_name
    db.commit()
    db.refresh(folder)
    return FolderResponse(
        id=folder.id,
        project_id=folder.project_id,
        parent_id=folder.parent_id,
        name=folder.name,
        created_at=folder.created_at,
    )


@router.get("/folders", response_model=List[FolderResponse])
def list_folders(project_id: uuid.UUID, parent_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    q = db.query(FileFolder).filter(FileFolder.project_id == project_id)
    if parent_id is None:
        q = q.filter(FileFolder.parent_id.is_(None))
    else:
        q = q.filter(FileFolder.parent_id == parent_id)
    return q.order_by(FileFolder.name).all()


@router.get("/files", response_model=List[FileMetaResponse])
def list_files(project_id: uuid.UUID, folder_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    q = db.query(ProjectFile).filter(ProjectFile.project_id == project_id)
    if folder_id is None:
        q = q.filter(ProjectFile.folder_id.is_(None))
    else:
        q = q.filter(ProjectFile.folder_id == folder_id)
    return q.order_by(ProjectFile.name).all()


@router.post("/upload", response_model=FileMetaResponse, status_code=status.HTTP_201_CREATED)
async def upload_file(
    project_id: uuid.UUID = Form(...),
    folder_id: Optional[uuid.UUID] = Form(None),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    # project_id here comes from multipart form data (not the URL path/query),
    # so it can't share a value with a plain Depends(verify_project_access)
    # sub-dependency; verify membership inline once the project is loaded instead.
    project = _require_project(project_id, db)
    get_company_membership(db, current_user, project.company_id)
    _require_folder_or_root(folder_id, project_id, db)

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit",
        )

    name = file.filename or "untitled"
    sniffed = _sniff_content_type(contents)
    if not sniffed or sniffed not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="File type not allowed. Upload documents, images, CAD files or archives.",
        )
    content_type = sniffed
    file_id = uuid.uuid4()

    storage_path = None
    data = None
    if supabase_storage.is_storage_configured():
        storage_path = f"{project_id}/{file_id}"
        supabase_storage.upload_bytes(
            supabase_storage.BUCKET_PROJECT_FILES, storage_path, contents, content_type
        )
    else:
        # Local-dev fallback: keep the bytes in the DB column.
        data = contents

    pf = ProjectFile(
        id=file_id,
        project_id=project_id,
        folder_id=folder_id,
        name=name,
        original_filename=name,
        content_type=content_type,
        size=len(contents),
        storage_path=storage_path,
        data=data,
    )
    db.add(pf)
    db.commit()
    db.refresh(pf)
    return FileMetaResponse(
        id=pf.id,
        project_id=pf.project_id,
        folder_id=pf.folder_id,
        name=pf.name,
        original_filename=pf.original_filename,
        content_type=pf.content_type,
        size=pf.size,
        uploaded_at=pf.uploaded_at,
    )


@router.get("/file/{file_id}")
def get_file(
    file_id: uuid.UUID,
    download: bool = False,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    # Tenant check: load the file's project and verify company membership.
    # (project_id is not in the URL, so we resolve it from the row.)
    pf = db.query(ProjectFile).filter(ProjectFile.id == file_id).first()
    if not pf:
        raise HTTPException(status_code=404, detail="File not found")
    project = db.query(Project).filter(Project.id == pf.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)

    # Prefer object storage; fall back to the DB BLOB for legacy rows.
    if pf.storage_path and supabase_storage.is_storage_configured():
        try:
            signed_url = supabase_storage.create_signed_url(
                supabase_storage.BUCKET_PROJECT_FILES, pf.storage_path
            )
            if download:
                sep = "&" if "?" in signed_url else "?"
                signed_url = f"{signed_url}{sep}download=true"
            return RedirectResponse(url=signed_url, status_code=307)
        except Exception:
            # Storage unavailable or signed-URL failed: fall through to BLOB.
            pass

    if pf.data:
        media_type = pf.content_type or "application/octet-stream"
        disposition = "attachment" if download else "inline"
        # Strip characters that could break out of the header value (CR/LF/quotes)
        # to prevent response-header injection via a crafted filename.
        safe_name = (pf.original_filename or "download").replace("\r", "").replace("\n", "").replace('"', "")
        headers = {
            "Content-Disposition": f'{disposition}; filename="{safe_name}"',
            "Content-Type": media_type,
            "Content-Length": str(pf.size),
            "Cache-Control": "no-store",
        }
        return Response(content=pf.data, media_type=media_type, headers=headers)

    raise HTTPException(status_code=404, detail="File not found")


@router.delete("/file/{file_id}")
def delete_file(
    file_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Delete an uploaded file: storage object, row, and a delete-log entry."""
    pf = db.query(ProjectFile).filter(ProjectFile.id == file_id).first()
    if not pf:
        raise HTTPException(status_code=404, detail="File not found")
    project = db.query(Project).filter(Project.id == pf.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "data:delete")

    if pf.storage_path:
        supabase_storage.delete_object(supabase_storage.BUCKET_PROJECT_FILES, pf.storage_path)

    from app.routers.delete_logs import log_deletion
    log_deletion(
        db,
        project.company_id,
        "project_file",
        pf.id,
        f"Project File: {pf.original_filename or pf.name}",
        deleted_by=current_user.name,
    )
    db.delete(pf)
    db.commit()
    return {"status": "success", "message": "File deleted successfully"}


@router.delete("/folders/{folder_id}")
def delete_folder(
    folder_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Delete an empty folder; refuses while it still contains files or subfolders."""
    folder = db.query(FileFolder).filter(FileFolder.id == folder_id).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    project = db.query(Project).filter(Project.id == folder.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "data:delete")

    has_files = db.query(ProjectFile.id).filter(ProjectFile.folder_id == folder_id).first() is not None
    has_subfolders = db.query(FileFolder.id).filter(FileFolder.parent_id == folder_id).first() is not None
    if has_files or has_subfolders:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Folder is not empty. Delete its files and subfolders first.",
        )

    from app.routers.delete_logs import log_deletion
    log_deletion(db, project.company_id, "file_folder", folder.id, f"File Folder: {folder.name}", deleted_by=current_user.name)
    db.delete(folder)
    db.commit()
    return {"status": "success", "message": "Folder deleted successfully"}
