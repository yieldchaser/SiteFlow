import re
import uuid
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from app.database import get_db
from app.auth import get_current_user, verify_project_access, get_company_membership
from app.models import ChatGroup, ChatMessage, ChatGroupMember, User, CompanyTeam, ProjectFile

router = APIRouter(prefix="/chat", tags=["Chat & MOM"], dependencies=[Depends(get_current_user)])

CHAT_GROUP_ROLE_PATTERN = "^(admin|member|viewer)$"

# Group icons and message photos are files uploaded to the group's own project.
PROJECT_FILE_PATH = re.compile(r"^/apis/v3/files/file/([0-9a-fA-F-]{36})$")


def check_project_file_url(db: Session, url: str, project_id: uuid.UUID) -> str:
    """Accept only a path to a file stored in this project (or, for older
    messages, an absolute https link). Anything else is refused so a group
    cannot point its members' browsers at an arbitrary address."""
    url = url.strip()
    m = PROJECT_FILE_PATH.match(url)
    if m:
        f = db.query(ProjectFile.id).filter(
            ProjectFile.id == uuid.UUID(m.group(1)), ProjectFile.project_id == project_id
        ).first()
        if f is None:
            raise HTTPException(status_code=400, detail="That file does not belong to this project")
        return url
    if url.lower().startswith("https://"):
        return url
    raise HTTPException(status_code=400, detail="Pictures must be uploaded files")


def company_team_for(db: Session, company_id: uuid.UUID, current_user: User) -> Optional[CompanyTeam]:
    # Every chat identity check must run in the company_team ID space: the
    # member/message user_id columns are foreign keys to company_team.id, not
    # users.id. This lookup is the single resolver for the caller's team row.
    return db.query(CompanyTeam).filter(
        CompanyTeam.company_id == company_id,
        CompanyTeam.user_id == current_user.id
    ).first()


def verify_group_membership(db: Session, current_user: User, group_id: uuid.UUID):
    group = db.query(ChatGroup).filter(ChatGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Chat group not found")
    team = company_team_for(db, group.company_id, current_user)
    caller_ids = [current_user.id]
    if team:
        caller_ids.append(team.id)
    membership = db.query(ChatGroupMember).filter(
        ChatGroupMember.group_id == group_id,
        ChatGroupMember.user_id.in_(caller_ids)
    ).first()
    if not membership:
        raise HTTPException(status_code=403, detail="Not a member of this chat group")
    return membership


def require_group_admin(db: Session, current_user: User, group_id: uuid.UUID):
    membership = verify_group_membership(db, current_user, group_id)
    if membership.role != "admin":
        raise HTTPException(status_code=403, detail="Group admin role required")
    return membership


def ensure_not_last_admin(db: Session, group_id: uuid.UUID, member: ChatGroupMember, new_role: Optional[str] = None):
    if member.role != "admin" or new_role == "admin":
        return
    admin_count = db.query(func.count(ChatGroupMember.id)).filter(
        ChatGroupMember.group_id == group_id,
        ChatGroupMember.role == "admin"
    ).scalar()
    if (admin_count or 0) <= 1:
        raise HTTPException(status_code=400, detail="Cannot remove or demote the last admin of the group")


class ChatGroupCreate(BaseModel):
    company_id: uuid.UUID
    project_id: uuid.UUID
    name: str
    group_type: str = "general"
    icon_url: Optional[str] = None
    created_by: Optional[uuid.UUID] = None


class ChatGroupUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    # Empty string removes the icon.
    icon_url: Optional[str] = None



class ChatGroupResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: uuid.UUID
    name: str
    group_type: str
    created_by: Optional[uuid.UUID]
    is_archived: bool
    created_at: datetime
    icon_url: Optional[str] = None
    member_count: int = 0
    unread_count: int = 0
    last_message: Optional[str] = None
    last_sender: Optional[str] = None
    last_message_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ChatMessageCreate(BaseModel):
    group_id: uuid.UUID
    message_text: Optional[str] = None
    image_urls: List[str] = []
    is_mom: bool = False
    mom_date: Optional[datetime] = None


class ChatMessageResponse(BaseModel):
    id: uuid.UUID
    group_id: uuid.UUID
    user_id: Optional[uuid.UUID]
    user_name: Optional[str]
    message_text: Optional[str]
    image_urls: List[str]
    is_mom: bool
    mom_date: Optional[datetime]
    created_at: datetime
    is_mine: bool = False

    class Config:
        from_attributes = True

    @classmethod
    def from_attributes(cls, obj):
        data = {
            "id": obj.id,
            "group_id": obj.group_id,
            "user_id": obj.user_id,
            "user_name": obj.user_name,
            "message_text": obj.message_text,
            "image_urls": obj.image_urls or [],
            "is_mom": obj.is_mom,
            "mom_date": obj.mom_date,
            "created_at": obj.created_at,
        }
        return cls(**data)


class ChatGroupMemberCreate(BaseModel):
    group_id: uuid.UUID
    user_id: uuid.UUID
    role: str = Field("member", pattern=CHAT_GROUP_ROLE_PATTERN)  # admin, member, viewer


class ChatGroupMemberResponse(BaseModel):
    id: uuid.UUID
    group_id: uuid.UUID
    user_id: uuid.UUID
    role: str
    joined_at: datetime
    name: Optional[str] = None
    is_me: bool = False

    class Config:
        from_attributes = True


@router.post("/groups", response_model=ChatGroupResponse, status_code=status.HTTP_201_CREATED)
def create_group(payload: ChatGroupCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    creator = company_team_for(db, payload.company_id, current_user)
    if creator is None:
        raise HTTPException(status_code=403, detail="Not a member of this company team")
    data = payload.model_dump()
    data.pop("created_by", None)
    if data.get("icon_url"):
        data["icon_url"] = check_project_file_url(db, data["icon_url"], payload.project_id)
    else:
        data["icon_url"] = None
    group = ChatGroup(**data)
    group.created_by = creator.id
    db.add(group)
    db.flush()
    db.add(ChatGroupMember(group_id=group.id, user_id=creator.id, role="admin"))
    db.commit()
    db.refresh(group)
    return group


@router.get("/groups/{project_id}", response_model=List[ChatGroupResponse])
def list_groups(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    groups = db.query(ChatGroup).filter(
        ChatGroup.project_id == project_id,
        ChatGroup.is_archived == False
    ).all()
    team_ids = [
        t.id for t in db.query(CompanyTeam.id).filter(
            CompanyTeam.user_id == current_user.id,
            CompanyTeam.company_id.in_([g.company_id for g in groups])
        ).all()
    ]
    caller_ids = [current_user.id] + team_ids
    member_group_ids = {
        m.group_id for m in db.query(ChatGroupMember.group_id).filter(
            ChatGroupMember.group_id.in_([g.id for g in groups]),
            ChatGroupMember.user_id.in_(caller_ids)
        ).all()
    }
    groups = [g for g in groups if g.id in member_group_ids]
    counts = dict(
        db.query(ChatGroupMember.group_id, func.count(ChatGroupMember.id))
        .filter(ChatGroupMember.group_id.in_([g.id for g in groups]))
        .group_by(ChatGroupMember.group_id)
        .all()
    )
    result = []
    for g in groups:
        ct = company_team_for(db, g.company_id, current_user)
        # R2-765: read watermark from DB (persisted), not from in-memory dict.
        # ct.id is the company_team foreign key used in chat_group_members.user_id.
        last_read = None
        if ct:
            member_row = db.query(ChatGroupMember).filter(
                ChatGroupMember.group_id == g.id,
                ChatGroupMember.user_id == ct.id,
            ).first()
            if member_row:
                last_read = member_row.last_read_at
        unread_q = db.query(func.count(ChatMessage.id)).filter(ChatMessage.group_id == g.id)
        if ct:
            unread_q = unread_q.filter(ChatMessage.user_id != ct.id)
        if last_read:
            unread_q = unread_q.filter(ChatMessage.created_at > last_read)
        unread_cnt = unread_q.scalar() or 0

        last = (
            db.query(ChatMessage, User.name)
            .join(CompanyTeam, CompanyTeam.id == ChatMessage.user_id, isouter=True)
            .join(User, User.id == CompanyTeam.user_id, isouter=True)
            .filter(ChatMessage.group_id == g.id)
            .order_by(ChatMessage.created_at.desc())
            .first()
        )
        last_text = last_sender = last_at = None
        if last:
            lm, lname = last
            last_text = lm.message_text or ("Photo" if lm.image_urls else None)
            last_sender = "You" if ct and lm.user_id == ct.id else (lname or lm.user_name)
            last_at = lm.created_at

        result.append(
            ChatGroupResponse(
                id=g.id,
                company_id=g.company_id,
                project_id=g.project_id,
                name=g.name,
                group_type=g.group_type,
                created_by=g.created_by,
                is_archived=g.is_archived,
                created_at=g.created_at,
                icon_url=g.icon_url,
                member_count=counts.get(g.id, 0),
                unread_count=unread_cnt,
                last_message=last_text,
                last_sender=last_sender,
                last_message_at=last_at,
            )
        )
    # Most recent conversation first, like any messenger.
    result.sort(key=lambda r: r.last_message_at or r.created_at, reverse=True)
    return result


@router.patch("/groups/{group_id}", response_model=ChatGroupResponse)
def update_group(group_id: uuid.UUID, payload: ChatGroupUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Rename a group or set / remove its icon. Group admins only."""
    group = db.query(ChatGroup).filter(ChatGroup.id == group_id, ChatGroup.is_archived == False).first()
    if not group:
        raise HTTPException(status_code=404, detail="Chat group not found")
    get_company_membership(db, current_user, group.company_id)
    require_group_admin(db, current_user, group.id)
    if payload.name is not None:
        group.name = payload.name.strip()
    if payload.icon_url is not None:
        group.icon_url = check_project_file_url(db, payload.icon_url, group.project_id) if payload.icon_url.strip() else None
    db.commit()
    db.refresh(group)
    count = db.query(func.count(ChatGroupMember.id)).filter(ChatGroupMember.group_id == group.id).scalar() or 0
    return ChatGroupResponse(
        id=group.id, company_id=group.company_id, project_id=group.project_id, name=group.name,
        group_type=group.group_type, created_by=group.created_by, is_archived=group.is_archived,
        created_at=group.created_at, icon_url=group.icon_url, member_count=count,
    )


@router.post("/groups/{group_id}/read")
def mark_group_as_read(
    group_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark all messages in a chat group as read for the authenticated user (Onsite Parity 14.9.4 #8).
    R2-765: watermark is persisted to ChatGroupMember.last_read_at, not a module-level dict."""
    membership = verify_group_membership(db, current_user, group_id)
    now = datetime.now(timezone.utc)
    # verify_group_membership returns the member row keyed by company_team id;
    # update it directly to avoid a second query.
    membership.last_read_at = now
    db.commit()
    return {"success": True, "group_id": group_id, "read_at": now.isoformat()}


@router.post("/messages", response_model=ChatMessageResponse, status_code=status.HTTP_201_CREATED)
def send_message(payload: ChatMessageCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    group = db.query(ChatGroup).filter(ChatGroup.id == payload.group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Chat group not found")
    get_company_membership(db, current_user, group.company_id)
    verify_group_membership(db, current_user, group.id)
    if not (payload.message_text or "").strip() and not payload.image_urls:
        raise HTTPException(status_code=400, detail="Write a message or attach a photo")
    data = payload.model_dump()
    data["image_urls"] = [check_project_file_url(db, u, group.project_id) for u in payload.image_urls if u.strip()]
    msg = ChatMessage(**data)
    # Stamp the real sender so names resolve on read. The server owns the
    # sender identity, not the client payload. user_id links to company_team.id.
    ct = company_team_for(db, group.company_id, current_user)
    if ct is None:
        raise HTTPException(status_code=403, detail="Not a member of this company team")
    msg.user_id = ct.id
    msg.user_name = current_user.name
    db.add(msg)
    db.commit()
    db.refresh(msg)
    out = ChatMessageResponse.from_attributes(msg)
    out.is_mine = True
    return out


@router.get("/messages/{group_id}", response_model=List[ChatMessageResponse])
def list_messages(
    group_id: uuid.UUID,
    since_id: Optional[uuid.UUID] = None,
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    group = db.query(ChatGroup).filter(ChatGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Chat group not found")
    get_company_membership(db, current_user, group.company_id)
    verify_group_membership(db, current_user, group.id)
    q = (
        db.query(ChatMessage, User.name)
        .join(CompanyTeam, CompanyTeam.id == ChatMessage.user_id, isouter=True)
        .join(User, User.id == CompanyTeam.user_id, isouter=True)
        .filter(ChatMessage.group_id == group_id)
    )
    rows = q.order_by(ChatMessage.created_at.desc()).limit(limit).all()
    if since_id is not None:
        anchor = db.query(ChatMessage.created_at).filter(ChatMessage.id == since_id).scalar()
        if anchor is not None:
            rows = [
                r for r in rows
                if r[0].created_at >= anchor and r[0].id != since_id
            ]
    rows = rows[::-1]
    me = company_team_for(db, group.company_id, current_user)
    result = []
    for msg, resolved_name in rows:
        data = {
            "id": msg.id,
            "group_id": msg.group_id,
            "user_id": msg.user_id,
            "user_name": resolved_name or msg.user_name or "—",
            "message_text": msg.message_text,
            "image_urls": msg.image_urls or [],
            "is_mom": msg.is_mom,
            "mom_date": msg.mom_date,
            "created_at": msg.created_at,
            "is_mine": bool(me and msg.user_id == me.id),
        }
        result.append(ChatMessageResponse(**data))
    return result


@router.get("/groups/{group_id}/members", response_model=List[ChatGroupMemberResponse])
def list_members(group_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    group = db.query(ChatGroup).filter(ChatGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Chat group not found")
    get_company_membership(db, current_user, group.company_id)
    verify_group_membership(db, current_user, group.id)
    rows = (
        db.query(ChatGroupMember, User.name)
        .join(CompanyTeam, CompanyTeam.id == ChatGroupMember.user_id, isouter=True)
        .join(User, User.id == CompanyTeam.user_id, isouter=True)
        .filter(ChatGroupMember.group_id == group_id)
        .all()
    )
    me = company_team_for(db, group.company_id, current_user)
    result = []
    for member, name in rows:
        result.append(ChatGroupMemberResponse(
            id=member.id,
            group_id=member.group_id,
            user_id=member.user_id,
            role=member.role,
            joined_at=member.joined_at,
            name=name,
            is_me=bool(me and member.user_id == me.id),
        ))
    return result


@router.post("/groups/{group_id}/members", response_model=ChatGroupMemberResponse, status_code=status.HTTP_201_CREATED)
def add_member(group_id: uuid.UUID, payload: ChatGroupMemberCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if payload.group_id != group_id:
        raise HTTPException(status_code=400, detail="Group ID mismatch")
    group = db.query(ChatGroup).filter(ChatGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Chat group not found")
    get_company_membership(db, current_user, group.company_id)
    member_count = db.query(func.count(ChatGroupMember.id)).filter(
        ChatGroupMember.group_id == group.id
    ).scalar() or 0
    if member_count == 0:
        # Bootstrap: a group with no members has nobody who could grant access,
        # so its recorded creator - resolved in both ID spaces, because rows
        # created before the created_by stamp was fixed may hold either -
        # may seed the first member. Once one exists the normal admin gate applies.
        team = company_team_for(db, group.company_id, current_user)
        caller_ids = [current_user.id] + ([team.id] if team else [])
        if group.created_by is None or group.created_by not in caller_ids:
            raise HTTPException(
                status_code=403,
                detail="Only the group creator can add the first member to an empty group",
            )
    else:
        require_group_admin(db, current_user, group.id)
    member = ChatGroupMember(**payload.model_dump())
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


@router.delete("/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_group(group_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    group = db.query(ChatGroup).filter(ChatGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Chat group not found")
    get_company_membership(db, current_user, group.company_id)
    require_group_admin(db, current_user, group.id)
    group.is_archived = True
    db.commit()
    return None


@router.delete("/groups/{group_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(group_id: uuid.UUID, user_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    member = db.query(ChatGroupMember).filter(
        ChatGroupMember.group_id == group_id,
        ChatGroupMember.user_id == user_id
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    group = db.query(ChatGroup).filter(ChatGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Chat group not found")
    get_company_membership(db, current_user, group.company_id)
    require_group_admin(db, current_user, group.id)
    ensure_not_last_admin(db, group_id, member)
    from app.routers.delete_logs import log_deletion
    company_id = group.company_id if group else None
    log_deletion(db, company_id, "chat_group_member", member.id, f"Chat Group Member removed from: {group.name if group else group_id}", deleted_by=current_user.name)
    db.delete(member)
    db.commit()
    return None


@router.patch("/groups/{group_id}/members/{user_id}/role", response_model=ChatGroupMemberResponse)
def update_member_role(group_id: uuid.UUID, user_id: uuid.UUID, role: str = Query(..., pattern=CHAT_GROUP_ROLE_PATTERN), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    member = db.query(ChatGroupMember).filter(
        ChatGroupMember.group_id == group_id,
        ChatGroupMember.user_id == user_id
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    group = db.query(ChatGroup).filter(ChatGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Chat group not found")
    get_company_membership(db, current_user, group.company_id)
    require_group_admin(db, current_user, group.id)
    ensure_not_last_admin(db, group_id, member, new_role=role)
    member.role = role
    db.commit()
    db.refresh(member)
    return member
