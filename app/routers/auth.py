"""
Authentication router.

POST /api/auth/login    — validates credentials, sets httpOnly cookies
POST /api/auth/logout   — revokes refresh token, clears cookies
POST /api/auth/refresh  — rotates access + refresh tokens
GET  /api/auth/me       — returns current user info (lightweight session check)
"""

import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from jose import JWTError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.rate_limiter import limiter
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.db.session import get_db
from app.models.refresh_token import RefreshToken
from app.models.user import User
from app.schemas.auth import LoginRequest, TokenResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])

# ── Cookie helpers ─────────────────────────────────────────────────────────────

_COOKIE_OPTS = dict(
    httponly=True,
    samesite="lax",
    secure=os.getenv("HTTPS_ONLY", "false").lower() == "true",
)


def _set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    response.set_cookie(
        "access_token",
        access_token,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        **_COOKIE_OPTS,
    )
    response.set_cookie(
        "refresh_token",
        refresh_token,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/api/auth",  # restrict refresh_token cookie to auth endpoints only
        **_COOKIE_OPTS,
    )


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token", path="/api/auth")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
def login(
    request: Request,
    payload: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.username == payload.username).first()

    # Constant-time-safe: always call verify_password even if user not found
    _dummy_hash = "$2b$12$Ah2.wQt1YR2oBJP5Ts1p1.UMYkRX5JrKmdQubozfAH8CFAxPqCrwa"
    valid = verify_password(payload.password, user.hashed_password if user else _dummy_hash)

    if not user or not valid or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuario o contraseña incorrectos.",
        )

    access_token = create_access_token(user.username, user.role)
    refresh_token = create_refresh_token(user.username)

    # Store refresh token hash in DB
    rt = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(refresh_token),
        expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(rt)

    # Update last_login
    user.last_login = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()

    _set_auth_cookies(response, access_token, refresh_token)

    return TokenResponse(username=user.username, role=user.role)


@router.post("/logout")
def logout(
    response: Response,
    refresh_token: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Revoke the refresh token in DB so it can't be reused
    if refresh_token:
        rt_hash = hash_token(refresh_token)
        rt = db.query(RefreshToken).filter(RefreshToken.token_hash == rt_hash).first()
        if rt:
            rt.revoked = True
            db.commit()

    _clear_auth_cookies(response)
    return {"message": "Sesión cerrada correctamente."}


@router.post("/refresh", response_model=TokenResponse)
@limiter.limit("10/minute")
def refresh(
    request: Request,
    response: Response,
    refresh_token: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
):
    """Rotates both tokens using a valid refresh_token cookie."""
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Refresh token inválido o expirado. Iniciá sesión nuevamente.",
    )

    if not refresh_token:
        raise credentials_exc

    try:
        payload = decode_token(refresh_token)
    except JWTError:
        raise credentials_exc

    if payload.get("type") != "refresh":
        raise credentials_exc

    # Verify token exists in DB and is not revoked
    rt_hash = hash_token(refresh_token)
    rt = db.query(RefreshToken).filter(
        RefreshToken.token_hash == rt_hash,
        RefreshToken.revoked == False,  # noqa: E712
    ).first()

    if not rt:
        raise credentials_exc

    user = db.query(User).filter(User.username == payload.get("sub")).first()
    if not user or not user.is_active:
        raise credentials_exc

    # Revoke old token and issue new pair (token rotation)
    rt.revoked = True

    new_access = create_access_token(user.username, user.role)
    new_refresh = create_refresh_token(user.username)

    new_rt = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(new_refresh),
        expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(new_rt)
    db.commit()

    _set_auth_cookies(response, new_access, new_refresh)
    return TokenResponse(username=user.username, role=user.role)


@router.get("/me", response_model=TokenResponse)
def me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lightweight session check — returns username + role + linked client if access_token is valid."""
    from sqlalchemy import select as _select
    from app.models.operador import Operador
    op = db.execute(
        _select(Operador).where(Operador.username == current_user.username, Operador.activo == True)
    ).scalar_one_or_none()
    return TokenResponse(
        username=current_user.username,
        role=current_user.role,
        message="OK",
        cliente_codigo=op.cliente_codigo if op else None,
    )
