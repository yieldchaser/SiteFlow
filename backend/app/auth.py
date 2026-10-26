from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session
from app.config import settings
from app.database import get_db
from app import models
from app.permissions import has_permission, has_module_access, VIEWER_GRANTS

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token", auto_error=False)


def _set_rls_session_context(db: Session, user_id: uuid.UUID) -> None:
    """R2-739: pluggable RLS identity, behind flag RLS_SESSION_CONTEXT (default OFF).

    When the flag is enabled, sets `app.current_user_id` on the current DB
    transaction via `set_config(..., true)` which is equivalent to
    `SET LOCAL app.current_user_id = '<uid>'` -- transaction-scoped, pooler-safe.
    No DATABASE_URL change and no non-BYPASSRLS role is created here; RLS remains
    inert until explicit rollout (see migration 20260825_000007_rls_correctness).
    On SQLite (tests) this is a no-op because SQLite has no RLS/GUC.
    """
    if not getattr(settings, "RLS_SESSION_CONTEXT", False):
        return
    try:
        bind = db.get_bind() if hasattr(db, "get_bind") else getattr(db, "bind", None)
        if bind is not None:
            dialect = getattr(getattr(bind, "dialect", None), "name", "") or ""
            url_str = str(getattr(bind, "url", "") or "")
            if "sqlite" in dialect.lower() or "sqlite" in url_str.lower():
                return
    except Exception:
        return
    try:
        from sqlalchemy import text

        # is_local=true => SET LOCAL semantics (transaction-scoped, pooler-safe)
        db.execute(text("SELECT set_config('app.current_user_id', :uid, true)"), {"uid": str(user_id)})
    except Exception:
        import logging

        logging.getLogger(__name__).debug("RLS session context set failed", exc_info=True)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    now = datetime.now(timezone.utc)
    if expires_delta:
        expire = now + expires_delta
    else:
        expire = now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire, "iat": int(now.timestamp()), "jti": str(uuid.uuid4())})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> models.User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise credentials_exception
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise credentials_exception
        # SQLAlchemy's UUID type requires a uuid.UUID object on SQLite; coerce safely.
        if isinstance(user_id, str):
            try:
                user_id = uuid.UUID(user_id)
            except ValueError:
                raise credentials_exception
    except JWTError:
        raise credentials_exception
        
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise credentials_exception

    jti = payload.get("jti")
    if jti:
        revoked = db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first()
        if revoked:
            raise credentials_exception

    issued_at = payload.get("iat")
    tokens_revoked_at = user.tokens_revoked_at
    if isinstance(issued_at, (int, float)) and tokens_revoked_at is not None:
        if tokens_revoked_at.tzinfo is None:
            tokens_revoked_at = tokens_revoked_at.replace(tzinfo=timezone.utc)
        if datetime.fromtimestamp(issued_at, tz=timezone.utc) < tokens_revoked_at:
            raise credentials_exception

    # R2-739: when flag enabled, bind this DB transaction to the authenticated app user
    # for RLS (SET LOCAL / set_config is_local=true, pooler-safe). No-op on SQLite or when OFF.
    try:
        _set_rls_session_context(db, user.id)
    except Exception:
        pass
    return user


# Optional explicit dependency for routes that want to ensure RLS context is set
# even when they do not go through get_current_user (e.g., future anon + RLS).
# Usage: `_: None = Depends(set_rls_context)` alongside `current_user = Depends(get_current_user)`.
# Currently get_current_user already sets the context, so this is additive.
def set_rls_context(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
) -> None:
    _set_rls_session_context(db, current_user.id)

def get_company_membership(db: Session, user: models.User, company_id: uuid.UUID) -> models.CompanyTeam:
    """Verify the user actually belongs to the given company; raise 403 otherwise."""
    membership = db.query(models.CompanyTeam).filter(
        models.CompanyTeam.user_id == user.id,
        models.CompanyTeam.company_id == company_id,
    ).first()
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User is not a member of the requested company",
        )
    return membership


def verify_project_in_company(db: Session, project_id: uuid.UUID, company_id: uuid.UUID) -> models.Project:
    """Load project_id and assert it belongs to company_id. 404 if missing, 403 if it belongs to a different company."""
    project = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if project.company_id != company_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Project does not belong to this company",
        )
    return project


def empty_permissions_fail_closed(db: Session, company_id: uuid.UUID) -> bool:
    """D7 (R2-073/R2-113/R2-169) policy switch for unconfigured permissions.

    Returns True when an empty / missing role permission set must DENY instead
    of the legacy allow. Driven by settings.RBAC_EMPTY_PERMS_POLICY:
      - "open" (default): never closed. The pre-D7 behaviour everywhere and
        the rollback value; reverting is a config change, not a deploy.
      - "closed": closed for every tenant.
      - "per_company": closed only where companies.permissions_fail_closed is
        explicitly true (flipped per tenant by ops during rollout).
    """
    mode = (getattr(settings, "RBAC_EMPTY_PERMS_POLICY", "") or "open").strip().lower()
    if mode == "closed":
        return True
    if mode == "per_company":
        company = db.query(models.Company).filter(models.Company.id == company_id).first()
        return bool(company is not None and company.permissions_fail_closed is True)
    return False


def _resolve_rbac_target_perms(db: Session, membership: models.CompanyTeam) -> tuple:
    """Resolve what require_permission / require_module_view enforce against.

    Returns `(perms, fail_closed)`:
      - `perms` non-empty: enforce against it (identical under both policies,
        includes the superuser `all` flag).
      - `perms` empty and `fail_closed` False: legacy fail-open, callers ALLOW
        (RBAC_EMPTY_PERMS_POLICY="open", the default and rollback value).
      - `perms` empty and `fail_closed` True: callers DENY unless the grants
        say otherwise:
          * no resolvable role (role_id NULL or dangling) -> Viewer grants
            (D7 decision 4: defaulting, not rejecting);
          * a configured role whose stored dict is empty/unset -> {} i.e. NO
            permissions (D7 decision 3: empty means empty).

    Partners never reach this helper (failsafe 1 runs first in the callers).
    """
    fail_closed = empty_permissions_fail_closed(db, membership.company_id)
    resolved_role = None
    if membership.role_id is not None:
        resolved_role = db.query(models.CompanyRole).filter(
            models.CompanyRole.id == membership.role_id
        ).first()
    if resolved_role is not None:
        role_perms = resolved_role.permissions or {}
        if role_perms:
            return role_perms, fail_closed
        # A configured role whose permission dict was never filled.
        return {}, fail_closed
    # No role assigned (or dangling reference): D7 defaults to Viewer when the
    # tenant enforces fail-closed; legacy keeps it failing open.
    if fail_closed:
        return dict(VIEWER_GRANTS), True
    return {}, False


def _reject(permission_label: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"You do not have the required permission: {permission_label}",
    )


def require_permission(db: Session, current_user: models.User, company_id: uuid.UUID, permission_key: str) -> None:
    """PHASE 2 RBAC enforcement.

    Reuses the tenant guard (`get_company_membership`) and then denies unless the
    caller's role holds `permission_key`. Failsafes (SECURITY_rbac_design.md):
      - A `partner` member always passes (never lockable out).
      - An empty / null role permissions dict fails OPEN while
        RBAC_EMPTY_PERMS_POLICY is "open" (the default). Under the D7
        fail-closed policy an unconfigured non-partner resolves to Viewer
        grants and an empty configured dict allows nothing.
      - The `all` superuser flag bypasses every check (Owner / Admin).
    """
    membership = get_company_membership(db, current_user, company_id)

    # Failsafe 1: partners can never be locked out.
    if membership.priority_type == "partner":
        return

    role_perms, fail_closed = _resolve_rbac_target_perms(db, membership)

    # Failsafe 2 (legacy): un-migrated / empty permissions -> fail-open (allow).
    # Reachable by config (RBAC_EMPTY_PERMS_POLICY="open") for one release.
    if not role_perms and not fail_closed:
        return

    # Superuser flag bypasses every check.
    if role_perms.get("all") is True:
        return

    if not has_permission(role_perms, permission_key):
        raise _reject(permission_key)


def require_any_permission(db: Session, current_user: models.User, company_id: uuid.UUID, *permission_keys: str) -> None:
    """require_permission, passing when the caller holds any one of the keys."""
    for key in permission_keys[:-1]:
        try:
            require_permission(db, current_user, company_id, key)
            return
        except HTTPException:
            continue
    require_permission(db, current_user, company_id, permission_keys[-1])


def allowed_project_ids(db: Session, membership: Optional[models.CompanyTeam]) -> Optional[set]:
    """The projects this member may open, or None when they may open every one.

    A member is limited only when their project_scope is "assigned"; owners and
    full-access roles are never limited."""
    if membership is None or (membership.project_scope or "all") != "assigned":
        return None
    if is_owner_equivalent(db, membership):
        return None
    rows = db.query(models.ProjectMember.project_id).filter(
        models.ProjectMember.company_team_id == membership.id
    ).all()
    return {r[0] for r in rows}


def project_ids_for_user(db: Session, user: models.User, company_id: uuid.UUID) -> Optional[set]:
    membership = db.query(models.CompanyTeam).filter(
        models.CompanyTeam.user_id == user.id,
        models.CompanyTeam.company_id == company_id,
    ).first()
    return allowed_project_ids(db, membership)


def scope_projects(query, db: Session, user: models.User, company_id: uuid.UUID, column=None):
    """Narrow a query over a company's projects to the ones this user may open."""
    ids = project_ids_for_user(db, user, company_id)
    if ids is None:
        return query
    column = column if column is not None else models.Project.id
    return query.filter(column.in_(list(ids))) if ids else query.filter(False)


def _project_ids_in_request(request: Request, body) -> list:
    found = []
    raw = request.path_params.get("project_id")
    if raw:
        found.append(raw)
    found += request.query_params.getlist("project_id")
    if isinstance(body, dict) and body.get("project_id"):
        found.append(body["project_id"])
    out = []
    for value in found:
        try:
            out.append(uuid.UUID(str(value)))
        except ValueError:
            continue
    return out


async def enforce_project_scope(request: Request, db: Session = Depends(get_db)) -> None:
    """App-wide guard: a member limited to some projects cannot read or write
    any other project, whichever endpoint names it (path, query or JSON body).
    Requests without a valid token are left to the endpoint's own auth."""
    header = request.headers.get("authorization") or ""
    if not header.lower().startswith("bearer "):
        return
    try:
        payload = jwt.decode(header[7:], settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id = uuid.UUID(str(payload.get("sub")))
    except (JWTError, ValueError, TypeError):
        return
    body = None
    if request.method in ("POST", "PUT", "PATCH") and "application/json" in (request.headers.get("content-type") or ""):
        try:
            body = await request.json()
        except Exception:
            body = None
    for project_id in _project_ids_in_request(request, body):
        project = db.query(models.Project).filter(models.Project.id == project_id).first()
        if project is None:
            continue
        membership = db.query(models.CompanyTeam).filter(
            models.CompanyTeam.user_id == user_id,
            models.CompanyTeam.company_id == project.company_id,
        ).first()
        allowed = allowed_project_ids(db, membership)
        if allowed is not None and project_id not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This project is not one of yours. Ask your company owner or admin to add you to it.",
            )


def is_owner_equivalent(db: Session, membership: models.CompanyTeam) -> bool:
    """True for a partner or a member whose role carries the `all` flag.

    Only these members may hand out full access (Owner / Admin or any role with
    `all`), so a Manager holding team:manage cannot promote themselves.
    """
    if membership.priority_type == "partner":
        return True
    if membership.role_id is None:
        return False
    role = db.query(models.CompanyRole).filter(models.CompanyRole.id == membership.role_id).first()
    return bool(role is not None and (role.permissions or {}).get("all") is True)


def invite_never_claimed(user: Optional[models.User]) -> bool:
    """An account created by a team invite that has never been signed in to:
    no password, no verified email, no phone and no sign-in method on record.
    Phone-login accounts always carry a mobile, so they never match."""
    return bool(
        user is not None
        and not (user.password_hash or "").strip()
        and not user.email_verified
        and not user.mobile
        and not (user.auth_providers or "").strip()
    )


def role_grants_full_access(role: Optional[models.CompanyRole]) -> bool:
    return bool(role is not None and (role.permissions or {}).get("all") is True)


def require_module_view(
    db: Session, current_user: models.User, company_id: uuid.UUID, module: str
) -> None:
    """Sibling of `require_permission` for SENSITIVE READ gating.

    Passes if the caller has ANY access to `module` (view/edit/approve), is a
    partner, has `all`, or has no configured role/permissions yet while the
    legacy fail-open policy applies. Under the D7 fail-closed policy an
    unconfigured non-partner gets Viewer (view-only) grants and an empty
    configured dict allows nothing. 403s otherwise. Used only for the
    sensitive financial/payroll GETs called out in the Phase 2b spec.
    """
    membership = get_company_membership(db, current_user, company_id)

    # Failsafe 1: partners can never be locked out.
    if membership.priority_type == "partner":
        return

    role_perms, fail_closed = _resolve_rbac_target_perms(db, membership)

    # Failsafe 2 (legacy): un-migrated / empty permissions -> fail-open (allow).
    # Reachable by config (RBAC_EMPTY_PERMS_POLICY="open") for one release.
    if not role_perms and not fail_closed:
        return

    # Superuser flag bypasses every check.
    if role_perms.get("all") is True:
        return

    if not has_module_access(role_perms, module):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You do not have access to view {module}.",
        )


def get_current_active_company_user(
    token: str = Depends(oauth2_scheme),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db)
) -> dict:
    # Prefer the company context baked into the JWT; verify the user is actually
    # a member of it rather than blindly grabbing an arbitrary membership row.
    company_id = None
    if token:
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            raw_cid = payload.get("company_id")
            if raw_cid:
                try:
                    company_id = uuid.UUID(str(raw_cid))
                except (ValueError, TypeError):
                    company_id = None
        except JWTError:
            company_id = None

    membership = None
    if company_id:
        membership = db.query(models.CompanyTeam).filter(
            models.CompanyTeam.user_id == current_user.id,
            models.CompanyTeam.company_id == company_id,
        ).first()

    if not membership:
        membership = db.query(models.CompanyTeam).filter(
            models.CompanyTeam.user_id == current_user.id
        ).first()

    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User is not associated with any company team context"
        )

    # Ensure RLS context is also bound to the db session used for subsequent queries
    # in this request (same transaction, pooler-safe). Already set in get_current_user
    # on its db, but this covers the case where the two Depends(get_db) resolve to
    # different Session instances.
    try:
        _set_rls_session_context(db, current_user.id)
    except Exception:
        pass

    return {
        "user": current_user,
        "company_id": membership.company_id,
        "role_id": membership.role_id,
        "priority_type": membership.priority_type,
    }


def verify_company_access(
    company_id: uuid.UUID,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Dependency for URL-routed endpoints: 403s unless the caller is a member
    of the company_id path/query param already declared on the endpoint."""
    membership = db.query(models.CompanyTeam).filter(
        models.CompanyTeam.company_id == company_id,
        models.CompanyTeam.user_id == current_user.id,
    ).first()
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this company",
        )


def verify_project_access(
    project_id: uuid.UUID,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Dependency for URL-routed endpoints: 403s unless the caller belongs to
    the company that owns the project_id path/query param on the endpoint."""
    project = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    membership = db.query(models.CompanyTeam).filter(
        models.CompanyTeam.company_id == project.company_id,
        models.CompanyTeam.user_id == current_user.id,
    ).first()
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this project",
        )


def get_verified_company_user(
    company_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db)
) -> dict:
    """Dependency for URL-routed endpoints: verifies the caller is a member of the
    company_id taken from the path before authorizing any work on it."""
    try:
        cid = uuid.UUID(company_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid company id")
    membership = get_company_membership(db, current_user, cid)
    return {
        "user": current_user,
        "company_id": cid,
        "role_id": membership.role_id,
        "priority_type": membership.priority_type,
    }


def assert_cost_codes_known(
    db: Session,
    company_id: uuid.UUID,
    codes: Optional[list] = None,
    sub_cost_codes: Optional[list] = None,
    status_code: int = 422,
) -> None:
    """R2-764: Cost code validation gate across all write paths.
    Every non-empty cost code or sub_cost_code must exist in the company's Cost Code Library.
    Fails atomically with HTTP 422 naming unknown codes.
    """
    comp_uuid = uuid.UUID(str(company_id))
    unknown_codes = []

    if codes:
        cleaned_codes = {str(c).strip() for c in codes if c and str(c).strip()}
        if cleaned_codes:
            known = set(
                code for (code,) in db.query(models.LibraryCostCode.code).filter(
                    models.LibraryCostCode.company_id == comp_uuid,
                    models.LibraryCostCode.code.in_(cleaned_codes),
                ).all()
            )
            for c in sorted(cleaned_codes - known):
                unknown_codes.append(c)

    if sub_cost_codes:
        cleaned_subs = {str(s).strip() for s in sub_cost_codes if s and str(s).strip()}
        if cleaned_subs:
            known_subs = set(
                sub for (sub,) in db.query(models.LibraryCostCode.sub_cost_code).filter(
                    models.LibraryCostCode.company_id == comp_uuid,
                    models.LibraryCostCode.sub_cost_code.in_(cleaned_subs),
                ).all()
            )
            for s in sorted(cleaned_subs - known_subs):
                unknown_codes.append(s)

    if unknown_codes:
        raise HTTPException(
            status_code=status_code,
            detail="Unknown cost codes (add them to the Cost Code Library first): " + ", ".join(unknown_codes),
        )
