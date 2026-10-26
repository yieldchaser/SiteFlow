import hashlib
import hmac
import json
import logging
import secrets as pysecrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.database import get_db
from app.auth import (
    create_access_token,
    get_company_membership,
    get_current_active_company_user,
    get_current_user,
    invite_never_claimed,
    is_owner_equivalent,
    oauth2_scheme,
    require_permission,
    role_grants_full_access,
)
from app.permissions import effective_permissions
from app.config import settings
from app.rate_limit import _rate_limit_key, limiter
from app.routers.settings import _validate_gstin
from app import models, sms, email_otp, security, firebase_auth

router = APIRouter(prefix="/auth", tags=["Authentication"])

logger = logging.getLogger(__name__)


def _auth_limit_key(request: Request) -> str:
    """Bucket key for the auth rate limits (R2-511).

    The stock key is the socket peer, which behind Render's proxy is the edge
    itself - every customer shared a handful of buckets and one visitor could
    exhaust the login limit for the whole platform. This key composes the
    proxy-aware client address with the identifier being authenticated
    (mobile/email) when the JSON body has already been parsed by FastAPI, so
    one address cannot lock out an account and one account cannot be attacked
    from many addresses without paying the full per-address budget too.
    Falls back to the plain client address for bodies it cannot read.
    """
    base = _rate_limit_key(request)
    raw = getattr(request, "_body", None)
    if not raw:
        return base
    try:
        data = json.loads(raw)
    except Exception:
        return base
    if not isinstance(data, dict):
        return base
    identifier = ""
    for field in ("mobile", "email"):
        value = str(data.get(field) or "").strip().lower()
        if value:
            identifier = value
            break
    return f"{base}:{identifier}" if identifier else base


# ── OTP primitives (shared by SMS and email) ─────────────────────────────────

def _generate_otp_code() -> str:
    """Cryptographically-random 6-digit code."""
    return f"{pysecrets.randbelow(1_000_000):06d}"


def _hash_otp(identifier: str, code: str) -> str:
    """HMAC-SHA256 of the code keyed by SECRET_KEY, bound to the identifier.

    The identifier is the phone number (SMS) or email (email OTP). The plaintext
    code is never persisted; only this hash is stored, so a DB leak does not
    expose live codes. Phone codes keep the same hash as before (identifier ==
    mobile), so the existing SMS flow is unchanged.
    """
    msg = f"{identifier}:{code}".encode("utf-8")
    return hmac.new(settings.SECRET_KEY.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def _hash_handoff(code: str) -> str:
    """HMAC-SHA256 of a one-time OAuth handoff code, keyed by SECRET_KEY."""
    return hmac.new(settings.SECRET_KEY.encode("utf-8"), code.encode("utf-8"), hashlib.sha256).hexdigest()


def _aware(dt: datetime) -> datetime:
    """Treat naive datetimes (SQLite) as UTC for safe comparison."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _issue_otp(db: Session, identifier: str, channel: str, code: str, purpose: str = "login", ttl_seconds: Optional[int] = None) -> None:
    """Invalidate earlier unconsumed codes for this identifier+purpose, then store
    the new one hashed with a TTL and a fresh attempt counter. Shared by both
    channels so there is a single, hardened OTP implementation."""
    db.query(models.OTPCode).filter(
        models.OTPCode.identifier == identifier,
        models.OTPCode.purpose == purpose,
        models.OTPCode.consumed.is_(False),
    ).update({models.OTPCode.consumed: True})
    otp = models.OTPCode(
        id=uuid.uuid4(),
        mobile=identifier if channel == "sms" else None,
        channel=channel,
        identifier=identifier,
        purpose=purpose,
        code_hash=_hash_otp(identifier, code),
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds or settings.OTP_TTL_SECONDS),
        attempts=0,
        consumed=False,
    )
    db.add(otp)
    db.commit()


def _verify_otp_code(db: Session, identifier: str, submitted: str, purpose: str = "login") -> None:
    """Verify and burn a code for identifier+purpose. Raises HTTPException on any
    failure (no active code, expired, too many attempts, wrong code). On success
    the code is consumed so it cannot be replayed. Identical rules for SMS and
    email: TTL, attempt cap, constant-time compare, single-use."""
    now = datetime.now(timezone.utc)
    otp = (
        db.query(models.OTPCode)
        .filter(
            models.OTPCode.identifier == identifier,
            models.OTPCode.purpose == purpose,
            models.OTPCode.consumed.is_(False),
        )
        .order_by(models.OTPCode.created_at.desc())
        .first()
    )
    if not otp:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No active code. Please request a new one.",
        )

    if _aware(otp.expires_at) < now:
        otp.consumed = True
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Code has expired. Please request a new one.",
        )

    if otp.attempts >= settings.OTP_MAX_ATTEMPTS:
        otp.consumed = True
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Too many incorrect attempts. Please request a new code.",
        )

    if not hmac.compare_digest(_hash_otp(identifier, (submitted or "").strip()), otp.code_hash):
        otp.attempts += 1
        if otp.attempts >= settings.OTP_MAX_ATTEMPTS:
            otp.consumed = True
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid code.")

    otp.consumed = True
    db.commit()


# ── Account-linking / provider bookkeeping ───────────────────────────────────
#
# Account-linking policy (v1, deliberately conservative):
#   * A login attempt resolves to an existing user ONLY by a VERIFIED identifier
#     (verified email matches users.email, verified phone matches users.mobile).
#   * An unverified identifier is never treated as proof of identity.
#   * If a verified Google/email-OTP email matches an existing account that has a
#     PASSWORD set, we do NOT silently merge the Google/OTP login onto it (that
#     could let one method hijack a password account). We require that account's
#     own password login instead. (Deferred edge case: an explicit, user-driven
#     "link Google to my account" flow.)
#   * We never auto-merge a phone-only account onto an email login or vice versa.

def _add_provider(user: models.User, name: str) -> None:
    existing = {p for p in (user.auth_providers or "").split(",") if p}
    if name not in existing:
        existing.add(name)
        user.auth_providers = ",".join(sorted(existing))


def _has_password(user: models.User) -> bool:
    return bool((user.password_hash or "").strip())


def _is_demo_mobile(mobile: str) -> bool:
    return mobile in settings.demo_allowlist


# ── Shared post-auth: company resolution, session minting, onboarding ─────────

def _list_companies(db: Session, user: models.User) -> list[dict]:
    memberships = db.query(models.CompanyTeam).filter(
        models.CompanyTeam.user_id == user.id
    ).all()
    company_ids = [m.company_id for m in memberships]
    if not company_ids:
        return []
    companies = db.query(models.Company).filter(models.Company.id.in_(company_ids)).all()
    prio = {m.company_id: m.priority_type for m in memberships}
    return [
        {
            "id": str(c.id),
            "name": c.name,
            "slug": c.slug,
            "priority_type": prio.get(c.id),
        }
        for c in companies
    ]


def _resolve_company_context(db: Session, user: models.User):
    """Return (company_id | None, companies, onboarding_bool).

    company_id is the user's most-recent membership; onboarding is True only when
    the user belongs to no company yet (a brand-new real signup)."""
    membership = (
        db.query(models.CompanyTeam)
        .filter(models.CompanyTeam.user_id == user.id)
        .order_by(models.CompanyTeam.created_at.desc())
        .first()
    )
    companies = _list_companies(db, user)
    if not membership:
        return None, companies, True
    return membership.company_id, companies, False


def _user_payload(user: models.User) -> dict:
    return {
        "id": str(user.id),
        "name": user.name,
        "mobile": user.mobile,
        "email": user.email,
        "email_verified": bool(user.email_verified),
    }


def _mint_session_response(db: Session, user: models.User, company_id, onboarding: bool) -> dict:
    """Build the auth response. In onboarding state the JWT carries no company
    claim and the frontend routes to the create-company screen; otherwise the JWT
    is scoped to the selected company."""
    if onboarding or company_id is None:
        token = create_access_token(
            data={"sub": str(user.id), "user_name": user.name, "onboarding": True}
        )
        return {
            "access_token": token,
            "token_type": "bearer",
            "onboarding": True,
            "user": _user_payload(user),
            "company": None,
            "companies": _list_companies(db, user),
        }

    membership = db.query(models.CompanyTeam).filter(
        models.CompanyTeam.user_id == user.id,
        models.CompanyTeam.company_id == company_id,
    ).first()
    company = db.query(models.Company).filter(models.Company.id == company_id).first()

    claims = {"sub": str(user.id), "company_id": str(company_id), "user_name": user.name}
    if user.mobile:
        claims["mobile"] = user.mobile
    token = create_access_token(data=claims)

    companies = _list_companies(db, user)
    return {
        "access_token": token,
        "token_type": "bearer",
        "onboarding": False,
        "needs_company_selection": len(companies) > 1,
        "user": _user_payload(user),
        "company": {
            "id": str(company_id),
            "name": company.name if company else None,
            "priority_type": membership.priority_type if membership else None,
        },
        "companies": companies,
    }


def _post_auth(db: Session, user: models.User, provider: str) -> dict:
    """Single convergence point for ALL auth methods after identity is proven.

    Records the provider, resolves the user's company context, and mints the
    session (or an onboarding-state session for brand-new users). No auth method
    is ever force-attached to the shared demo tenant here."""
    _add_provider(user, provider)
    db.commit()
    company_id, _companies, onboarding = _resolve_company_context(db, user)
    return _mint_session_response(db, user, company_id, onboarding)


def _create_handoff(db: Session, user: models.User, company_id, onboarding: bool, provider: str) -> str:
    """Create a single-use, short-lived handoff and return its plaintext code.

    Used by OAuth callbacks so the real session JWT is never placed in a redirect
    URL; the frontend exchanges this code via POST /auth/oauth/exchange."""
    code = pysecrets.token_urlsafe(32)
    handoff = models.OAuthHandoff(
        id=uuid.uuid4(),
        code_hash=_hash_handoff(code),
        user_id=user.id,
        company_id=company_id,
        onboarding=onboarding,
        provider=provider,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        consumed=False,
    )
    db.add(handoff)
    db.commit()
    return code


# ── Phone OTP (unchanged hardening, now on the shared core) ───────────────────

class OTPSendRequest(BaseModel):
    mobile: str = Field(..., example="+919876543210")

class OTPVerifyRequest(BaseModel):
    mobile: str = Field(..., example="+919876543210")
    code: str = Field(..., example="123456")


@router.post("/otp/send")
@limiter.limit("5/minute", key_func=_auth_limit_key)
def send_otp(request: Request, payload: OTPSendRequest, db: Session = Depends(get_db)):
    """Generate a one-time code, store it hashed with a short TTL, and deliver it
    by SMS. Only demo-allowlisted numbers work when no SMS provider is wired."""
    mobile = (payload.mobile or "").strip()
    if not mobile:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Mobile number is required")

    provider_ready = sms.is_configured()
    is_demo = _is_demo_mobile(mobile)

    if not provider_ready and not is_demo:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OTP delivery is not configured on this server. Please contact support.",
        )

    use_demo_code = is_demo and not provider_ready
    if use_demo_code and not settings.OTP_DEMO_CODE:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Demo OTP code is not configured on this server.",
        )
    code = settings.OTP_DEMO_CODE if use_demo_code else _generate_otp_code()

    _issue_otp(db, mobile, channel="sms", code=code, purpose="login")

    response = {"success": True, "message": f"OTP sent successfully to {mobile}"}

    if provider_ready:
        try:
            sms.send_otp_sms(mobile, code)
        except Exception as exc:
            logger.error("SMS send failed for %s: %s", mobile, exc)
            db.query(models.OTPCode).filter(
                models.OTPCode.identifier == mobile,
                models.OTPCode.purpose == "login",
                models.OTPCode.consumed.is_(False),
            ).update({models.OTPCode.consumed: True})
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Failed to send OTP. Please try again.",
            )
    elif use_demo_code:
        response["demo_mode"] = True
        response["mock_code"] = code

    return response


@router.post("/otp/verify")
@limiter.limit("5/minute", key_func=_auth_limit_key)
def verify_otp(request: Request, payload: OTPVerifyRequest, db: Session = Depends(get_db)):
    mobile = (payload.mobile or "").strip()
    _verify_otp_code(db, mobile, payload.code, purpose="login")

    user = db.query(models.User).filter(models.User.mobile == mobile).first()
    if not user:
        user = models.User(
            id=uuid.uuid4(),
            name="Site User",
            mobile=mobile,
            auth_providers="phone",
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    # No special-cased tenant attachment: every phone login converges on the
    # same post-auth path as every other method. An allowlisted demo number now
    # gets exactly what any unknown login gets - an onboarding session and no
    # company rows (D-V1 removed the shared demo tenant entirely).
    return _post_auth(db, user, provider="phone")


# ── Firebase Phone Auth (client-side verification, additive) ─────────────────
#
# Firebase Phone Auth is additive to the MSG91/demo-allowlist OTP above: the
# browser (Firebase JS SDK) runs reCAPTCHA + SMS + code entry and produces a
# signed Firebase ID token; this endpoint only VERIFIES that token server-side
# (see app/firebase_auth.py) and mints our session. The verified phone_number
# claim is the sole proof of identity here - a client-supplied number is never
# trusted. New users funnel through the same _post_auth path as every other
# method. The MSG91 flow above is untouched.

class FirebaseVerifyRequest(BaseModel):
    id_token: str = Field(..., min_length=1)


@router.post("/firebase/verify")
@limiter.limit("5/minute")
def verify_firebase(request: Request, payload: FirebaseVerifyRequest, db: Session = Depends(get_db)):
    if not firebase_auth.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Firebase phone login is not configured on this server. Please contact support.",
        )

    try:
        claims = firebase_auth.verify_id_token(payload.id_token)
    except ValueError as exc:
        logger.error("Firebase verify failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired verification. Please try again.",
        )

    mobile = (claims.get("phone_number") or "").strip()
    if not mobile:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This Firebase account has no verified phone number.",
        )

    # Find-or-create by the VERIFIED phone number, same identity-linking policy as
    # the rest of auth.py (match by verified identifier only).
    user = db.query(models.User).filter(models.User.mobile == mobile).first()
    if not user:
        user = models.User(
            id=uuid.uuid4(),
            name="Site User",
            mobile=mobile,
            auth_providers="firebase_phone",
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    return _post_auth(db, user, provider="firebase_phone")


# ── Email OTP (Part C) ───────────────────────────────────────────────────────
class EmailOTPSendRequest(BaseModel):
    email: EmailStr = Field(..., example="user@example.com")

class EmailOTPVerifyRequest(BaseModel):
    email: EmailStr = Field(..., example="user@example.com")
    code: str = Field(..., example="123456")


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _deliver_email_code(db: Session, email: str, purpose: str, invite: Optional[dict] = None) -> dict:
    """Shared email-OTP send: configured -> real SMTP; else demo-allowlist only.
    Returns a response dict (never contains the code except demo convenience).
    `invite` (company_name, inviter, role_name, claim_url) switches to the team
    invite email and a 7-day code, since people open those hours later."""
    provider_ready = email_otp.is_configured()
    is_demo = email in settings.email_demo_allowlist

    if not provider_ready and not is_demo:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email delivery is not configured on this server. Please contact support.",
        )

    use_demo_code = is_demo and not provider_ready
    if use_demo_code and not settings.OTP_DEMO_CODE:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Demo OTP code is not configured on this server.",
        )
    code = settings.OTP_DEMO_CODE if use_demo_code else _generate_otp_code()
    _issue_otp(db, email, channel="email", code=code, purpose=purpose,
               ttl_seconds=INVITE_CODE_TTL_SECONDS if invite else None)

    response = {"success": True, "message": f"Verification code sent to {email}"}
    if provider_ready:
        try:
            content = email_otp.invite_subject_and_body(code, **invite) if invite else None
            email_otp.send_otp_email(email, code, content)
        except Exception as exc:
            logger.error("Email OTP send failed for %s: %s", email, exc)
            db.query(models.OTPCode).filter(
                models.OTPCode.identifier == email,
                models.OTPCode.purpose == purpose,
                models.OTPCode.consumed.is_(False),
            ).update({models.OTPCode.consumed: True})
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Failed to send verification email. Please try again.",
            )
    elif use_demo_code:
        response["demo_mode"] = True
        response["mock_code"] = code
    return response


@router.post("/email-otp/send")
@limiter.limit("5/minute", key_func=_auth_limit_key)
def send_email_otp(request: Request, payload: EmailOTPSendRequest, db: Session = Depends(get_db)):
    email = _normalize_email(payload.email)
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email is required")
    return _deliver_email_code(db, email, purpose="login")


@router.post("/email-otp/verify")
@limiter.limit("5/minute", key_func=_auth_limit_key)
def verify_email_otp(request: Request, payload: EmailOTPVerifyRequest, db: Session = Depends(get_db)):
    email = _normalize_email(payload.email)
    _verify_otp_code(db, email, payload.code, purpose="login")

    user = db.query(models.User).filter(func.lower(models.User.email) == email).first()
    if not user:
        user = models.User(
            id=uuid.uuid4(),
            name=email.split("@")[0],
            email=email,
            email_verified=True,
            auth_providers="email_otp",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        user.email_verified = True
        db.commit()

    return _post_auth(db, user, provider="email_otp")


# ── Email + password (Part E) ────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)

class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1)

class ForgotPasswordRequest(BaseModel):
    email: EmailStr

class ResetPasswordRequest(BaseModel):
    email: EmailStr
    code: str
    new_password: str = Field(..., min_length=1)


@router.post("/register")
@limiter.limit("5/minute", key_func=_auth_limit_key)
def register(request: Request, payload: RegisterRequest, db: Session = Depends(get_db)):
    """Create an email+password account. The account cannot access any company
    until its email is verified via email OTP (Part C)."""
    email = _normalize_email(payload.email)
    pw_error = security.validate_password_strength(payload.password)
    if pw_error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=pw_error)

    existing = db.query(models.User).filter(func.lower(models.User.email) == email).first()
    if existing:
        # Do not silently link; direct them to login / reset (see linking policy).
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists. Please log in or reset your password.",
        )

    # Verification must be deliverable before we create the account, otherwise the
    # user could never reach a company. Mirrors the SMS 503 behaviour.
    if not email_otp.is_configured() and email not in settings.email_demo_allowlist:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email verification is not configured on this server. Please contact support.",
        )

    user = models.User(
        id=uuid.uuid4(),
        name=payload.name.strip(),
        email=email,
        password_hash=security.hash_password(payload.password),
        email_verified=False,
        auth_providers="password",
    )
    db.add(user)
    db.commit()

    delivery = _deliver_email_code(db, email, purpose="login")
    return {
        "success": True,
        "verification_required": True,
        "email": email,
        "message": "Account created. Verify your email with the code we sent to continue.",
        **({"demo_mode": True, "mock_code": delivery.get("mock_code")} if delivery.get("demo_mode") else {}),
    }


@router.post("/login")
@limiter.limit("5/minute", key_func=_auth_limit_key)
def login(request: Request, payload: LoginRequest, db: Session = Depends(get_db)):
    """Email + password login. Errors are generic so they do not reveal whether
    an email exists; bcrypt verification is constant-time."""
    email = _normalize_email(payload.email)
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password."
    )
    user = db.query(models.User).filter(func.lower(models.User.email) == email).first()
    if not user or not _has_password(user):
        # Run a dummy verify to keep timing similar whether or not the user exists.
        security.dummy_verify(payload.password)
        raise invalid
    if not security.verify_password(payload.password, user.password_hash):
        raise invalid
    if not user.email_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Please verify your email before logging in.",
        )
    return _post_auth(db, user, provider="password")


@router.post("/password/forgot")
@limiter.limit("5/minute", key_func=_auth_limit_key)
def forgot_password(request: Request, payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """Send a password-reset code via email OTP. Always returns a generic success
    so it does not disclose whether the email is registered."""
    email = _normalize_email(payload.email)
    generic = {
        "success": True,
        "message": "If an account exists for that email, a reset code has been sent.",
    }
    user = db.query(models.User).filter(func.lower(models.User.email) == email).first()
    if not user:
        return generic
    # Only attempt delivery when possible; swallow the 503/502 into the generic
    # response so existence is never revealed via error codes.
    if not email_otp.is_configured() and email not in settings.email_demo_allowlist:
        return generic
    try:
        _deliver_email_code(db, email, purpose="password_reset")
    except HTTPException:
        pass
    return generic


@router.post("/password/reset")
@limiter.limit("5/minute", key_func=_auth_limit_key)
def reset_password(request: Request, payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Reset the password using an email-OTP code (single-use). Verifying the code
    also proves email ownership, so email_verified is set true."""
    email = _normalize_email(payload.email)
    pw_error = security.validate_password_strength(payload.new_password)
    if pw_error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=pw_error)

    _verify_otp_code(db, email, payload.code, purpose="password_reset")

    user = db.query(models.User).filter(func.lower(models.User.email) == email).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reset request.")

    user.password_hash = security.hash_password(payload.new_password)
    user.email_verified = True
    user.tokens_revoked_at = datetime.now(timezone.utc)
    _add_provider(user, "password")
    db.commit()
    return {"success": True, "message": "Password updated. Please log in."}


@router.post("/logout")
def logout(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired session.",
    )
    if not token:
        raise invalid
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        raise invalid
    jti = payload.get("jti")
    if not jti:
        raise invalid
    exp = payload.get("exp")
    if isinstance(exp, (int, float)):
        expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
    else:
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    already = db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first()
    if not already:
        db.add(models.RevokedToken(jti=jti, expires_at=expires_at))
        db.commit()
    return {"success": True, "message": "Signed out."}


# ── OAuth handoff exchange (Part D + F) ──────────────────────────────────────

class OAuthExchangeRequest(BaseModel):
    code: str = Field(..., min_length=1)


@router.post("/oauth/exchange")
@limiter.limit("10/minute")
def oauth_exchange(request: Request, payload: OAuthExchangeRequest, db: Session = Depends(get_db)):
    """Exchange a single-use OAuth handoff code (from a callback redirect) for the
    real session JWT. The handoff is burned on first use."""
    now = datetime.now(timezone.utc)
    handoff = (
        db.query(models.OAuthHandoff)
        .filter(
            models.OAuthHandoff.code_hash == _hash_handoff(payload.code.strip()),
            models.OAuthHandoff.consumed.is_(False),
        )
        .order_by(models.OAuthHandoff.created_at.desc())
        .first()
    )
    if not handoff or _aware(handoff.expires_at) < now:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired login code.")

    handoff.consumed = True
    db.commit()

    user = db.query(models.User).filter(models.User.id == handoff.user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid login code.")

    return _mint_session_response(db, user, handoff.company_id, onboarding=bool(handoff.onboarding))


# ── Real onboarding: create the user's own company (Part F) ───────────────────

class CreateCompanyRequest(BaseModel):
    name: str = Field(..., min_length=1, example="My Construction Co")
    legal_business_name: str | None = Field(default=None, example="My Construction Pvt Ltd")
    gstin: str | None = Field(
        default=None,
        pattern=r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$",
        example="27AADCD2424B1ZP",
    )
    phone: str | None = None
    city: str | None = None
    billing_address: str | None = None

    _check_gstin = field_validator("gstin")(_validate_gstin)


@router.post("/onboarding/create-company")
def create_company(
    payload: CreateCompanyRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create the caller's OWN company and make them its owner, then re-issue the
    JWT scoped to it. This replaces the old force-attach-to-demo behaviour: a new
    real user owns their company and never the shared demo tenant."""
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Company name is required")

    company = models.Company(
        id=uuid.uuid4(),
        name=name,
        legal_business_name=(payload.legal_business_name or "").strip() or None,
        gstin=(payload.gstin or "").strip() or None,
        phone=(payload.phone or "").strip() or None,
        billing_address=(payload.billing_address or "").strip() or None,
        onboarding_city=(payload.city or "").strip() or None,
    )
    db.add(company)
    db.commit()
    db.refresh(company)

    # Seed an Owner role for the new tenant and attach the creator as owner.
    owner_role = models.CompanyRole(
        id=uuid.uuid4(),
        company_id=company.id,
        role_name="Owner",
        permissions={"all": True},
    )
    db.add(owner_role)
    db.commit()

    membership = models.CompanyTeam(
        id=uuid.uuid4(),
        company_id=company.id,
        user_id=current_user.id,
        role_id=owner_role.id,
        priority_type="partner",
    )
    db.add(membership)
    db.commit()

    resp = _mint_session_response(db, current_user, company.id, onboarding=False)
    resp["success"] = True
    return resp


# ── Existing helpers (unchanged) ─────────────────────────────────────────────

@router.get("/resolve-company/{slug}")
def resolve_company(slug: str, db: Session = Depends(get_db)):
    company = db.query(models.Company).filter(models.Company.slug == slug).first()
    if not company:
        try:
            company_uuid = uuid.UUID(slug)
            company = db.query(models.Company).filter(models.Company.id == company_uuid).first()
        except ValueError:
            pass

    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    return {
        "id": str(company.id),
        "name": company.name,
        "slug": company.slug,
    }


@router.get("/me")
@limiter.limit("120/minute")
def get_me(
    request: Request,
    ctx: dict = Depends(get_current_active_company_user),
    db: Session = Depends(get_db),
):
    """Return the current authenticated user's company role context.

    Includes the caller's effective `permissions` dict (resolved role
    permissions, or `{"all": true}` for partners) so the frontend can gate UI.

    R2-138/R2-308: this endpoint is called by every page load, and a runaway
    client once hammered it at ~16 req/s until the 30-connection pool was
    exhausted and login itself died. The generous 120/minute cap is invisible
    to normal navigation but turns a request loop into a bounded 429 spray, so
    one buggy tab can no longer take the platform down.
    """
    user = ctx["user"]
    company_id = ctx["company_id"]
    role_id = ctx.get("role_id")
    priority_type = ctx.get("priority_type")
    role_name = None
    role_perms = None
    if role_id:
        role = db.query(models.CompanyRole).filter(models.CompanyRole.id == role_id).first()
        if role:
            role_name = role.role_name
            role_perms = role.permissions
    return {
        "user_id": str(user.id),
        "name": user.name,
        "company_id": str(company_id),
        "role_id": str(role_id) if role_id else None,
        "role": role_name,
        "priority_type": priority_type,
        "permissions": effective_permissions(role_perms, priority_type),
    }


@router.get("/me/permissions")
def get_my_permissions(ctx: dict = Depends(get_current_active_company_user), db: Session = Depends(get_db)):
    """Return just the caller's effective permission set (see get_me)."""
    company_id = ctx["company_id"]
    role_id = ctx.get("role_id")
    priority_type = ctx.get("priority_type")
    role_name = None
    role_perms = None
    if role_id:
        role = db.query(models.CompanyRole).filter(models.CompanyRole.id == role_id).first()
        if role:
            role_name = role.role_name
            role_perms = role.permissions
    return {
        "company_id": str(company_id),
        "role_id": str(role_id) if role_id else None,
        "role": role_name,
        "priority_type": priority_type,
        "permissions": effective_permissions(role_perms, priority_type),
    }


@router.get("/my-companies")
def my_companies(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """List the companies the authenticated user belongs to, flagging enterprises
    (companies that are a parent of at least one other company)."""
    memberships = db.query(models.CompanyTeam).filter(
        models.CompanyTeam.user_id == current_user.id
    ).all()
    company_ids = [m.company_id for m in memberships]
    if not company_ids:
        return {"companies": []}

    companies = db.query(models.Company).filter(models.Company.id.in_(company_ids)).all()

    parent_ids = {
        c.parent_company_id
        for c in db.query(models.Company).filter(models.Company.parent_company_id.isnot(None)).all()
        if c.parent_company_id
    }

    result = [
        {
            "id": str(c.id),
            "name": c.name,
            "slug": c.slug,
            "parent_company_id": str(c.parent_company_id) if c.parent_company_id else None,
            "is_enterprise": c.id in parent_ids,
        }
        for c in companies
    ]
    return {"companies": result}


@router.post("/switch-company/{company_id}")
def switch_company(
    company_id: uuid.UUID,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_company_membership(db, current_user, company_id)
    return _mint_session_response(db, current_user, company_id, onboarding=False)


# ── Team invitations (R2-181) ─────────────────────────────────────────────────
#
# Until now a CompanyTeam row was born only four ways (company creator, demo
# allowlist, login-less subcontractor, bootstrap seed), so the RBAC subsystem
# governed tenants that could never gain a second member. This flow lets an
# owner with settings:manage attach a real, login-capable member to their
# tenant with a chosen role and a non-partner priority_type:
#   1. POST /auth/team/invite - creates (or reuses) the user by email, attaches
#      the membership immediately, and emails a one-time claim code for brand-
#      new accounts (demo allowlist gets the mock_code convenience).
#   2. POST /auth/team/invite/accept - proves mailbox control via that code,
#      sets the password, marks the email verified, and mints the session.
# The OTP machinery (hashed codes, TTL, attempt caps, single use) is shared.

# People open invite emails hours or days later; a 5-minute login code is useless there.
INVITE_CODE_TTL_SECONDS = 7 * 24 * 3600


def _invite_claim_url(request: Request) -> str:
    """Sign-in page link for the invite email: the app the inviter is using,
    if it is one of ours, else the configured frontend address."""
    origin = (request.headers.get("origin") or "").strip().rstrip("/")
    if origin and origin in settings.allowed_origins_list:
        return f"{origin}/login?mode=invite"
    base = (settings.FRONTEND_URL or "").split(",")[0].strip().rstrip("/")
    return f"{base}/login?mode=invite" if base else ""


class InviteMemberRequest(BaseModel):
    email: EmailStr
    name: str = Field(..., min_length=1)
    role_id: uuid.UUID
    # R2-746: an optional explicit target. A membership write must not depend
    # silently on a JWT claim the client cannot see or correct: after a company
    # switch the claim still named the PREVIOUS company, so an invite issued from
    # company B's screen granted membership of company A. When supplied it wins;
    # when omitted the token claim is used, so existing callers keep working.
    company_id: Optional[uuid.UUID] = None


class AcceptInviteRequest(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


@router.post("/team/invite")
@limiter.limit("10/minute", key_func=_auth_limit_key)
def invite_member(
    request: Request,
    payload: InviteMemberRequest,
    ctx: dict = Depends(get_current_active_company_user),
    db: Session = Depends(get_db),
):
    """Attach an email address to the caller's company as a working member."""
    user = ctx["user"]
    # R2-746: prefer an explicitly-named target. The claim is only a default,
    # and it is the one that goes stale across a company switch.
    company_id = payload.company_id or ctx["company_id"]
    # team:manage is the "add / remove members, assign roles" key.
    require_permission(db, user, company_id, "team:manage")
    caller = get_company_membership(db, user, company_id)

    email = _normalize_email(payload.email)
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email is required")

    role = (
        db.query(models.CompanyRole)
        .filter(models.CompanyRole.id == payload.role_id, models.CompanyRole.company_id == company_id)
        .first()
    )
    if not role:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role not found in this company.",
        )
    if role_grants_full_access(role) and not is_owner_equivalent(db, caller):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the owner or an admin can add someone with full access.",
        )

    company = db.query(models.Company).filter(models.Company.id == company_id).first()
    invite = {
        "company_name": company.name if company else "your company",
        "inviter": user.name or "Your company",
        "role_name": role.role_name,
        "claim_url": _invite_claim_url(request),
    }

    existing_member = (
        db.query(models.CompanyTeam)
        .join(models.User, models.CompanyTeam.user_id == models.User.id)
        .filter(
            models.CompanyTeam.company_id == company_id,
            func.lower(models.User.email) == email,
        )
        .first()
    )
    invitee = db.query(models.User).filter(func.lower(models.User.email) == email).first()
    never_claimed = invite_never_claimed(invitee)

    if existing_member:
        if not never_claimed:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This person is already a member of the company.",
            )
        # Invited earlier but never signed in (the code may have lapsed):
        # send a fresh code. Their role stays as it is.
        delivery = _deliver_email_code(db, email, purpose="team_invite", invite=invite)
        response = {
            "success": True,
            "status": "resent",
            "member_id": str(existing_member.id),
            "email": email,
            "message": "A new invite code has been emailed.",
        }
        if delivery.get("demo_mode"):
            response["demo_mode"] = True
            response["mock_code"] = delivery["mock_code"]
        return response

    delivery = {}
    if invitee and not never_claimed:
        # An existing account just gains the membership; it logs in with its own
        # credentials, so no claim code is needed (and none is sent).
        invited_status = "attached"
    else:
        invited_status = "invited"
        # Deliver BEFORE writing anything so undeliverable invites are clean 503s.
        delivery = _deliver_email_code(db, email, purpose="team_invite", invite=invite)
        if invitee is None:
            invitee = models.User(
                id=uuid.uuid4(),
                name=(payload.name or "").strip() or email.split("@")[0],
                email=email,
                password_hash=None,
                email_verified=False,
                auth_providers="",
            )
            db.add(invitee)

    membership = models.CompanyTeam(
        id=uuid.uuid4(),
        company_id=company_id,
        user_id=invitee.id,
        role_id=role.id,
        priority_type="employee",
    )
    db.add(membership)
    db.commit()

    response = {
        "success": True,
        "status": invited_status,
        "member_id": str(membership.id),
        "email": email,
        "role": role.role_name,
        "message": (
            "Existing account added to the company; they can log in right away."
            if invited_status == "attached"
            else "Invitation sent. They can claim the account with the code we emailed."
        ),
    }
    if delivery.get("demo_mode"):
        response["demo_mode"] = True
        response["mock_code"] = delivery["mock_code"]
    return response


@router.post("/team/invite/accept")
@limiter.limit("5/minute", key_func=_auth_limit_key)
def accept_invite(request: Request, payload: AcceptInviteRequest, db: Session = Depends(get_db)):
    """Claim an invited account: verify the emailed code, set the password,
    mark the email verified, and log straight into the inviting company."""
    email = _normalize_email(payload.email)
    pw_error = security.validate_password_strength(payload.password)
    if pw_error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=pw_error)

    _verify_otp_code(db, email, payload.code, purpose="team_invite")

    user = db.query(models.User).filter(func.lower(models.User.email) == email).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No invitation found for this email.",
        )

    user.password_hash = security.hash_password(payload.password)
    user.email_verified = True
    user.tokens_revoked_at = datetime.now(timezone.utc)
    _add_provider(user, "password")
    db.commit()

    return _post_auth(db, user, provider="password")
