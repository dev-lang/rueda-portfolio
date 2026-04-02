"""
FastAPI dependency functions for authentication and authorization.

Usage in routers:
    from app.core.deps import get_current_user, require_role

    @router.get("/something")
    def my_endpoint(user: User = Depends(get_current_user)):
        ...

    @router.post("/admin-only")
    def admin_endpoint(user: User = Depends(require_role("ADMIN"))):
        ...
"""

from fastapi import Cookie, Depends, HTTPException, status
from jose import JWTError
from sqlalchemy.orm import Session

from app.core.security import decode_token
from app.db.session import get_db
from app.models.user import User


def get_current_user(
    access_token: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> User:
    """
    Reads the access_token httpOnly cookie, validates the JWT,
    and returns the active User. Raises 401 on any failure.
    """
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="No autenticado. Iniciá sesión.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    if not access_token:
        raise credentials_exc

    try:
        payload = decode_token(access_token)
    except JWTError:
        raise credentials_exc

    if payload.get("type") != "access":
        raise credentials_exc

    username: str | None = payload.get("sub")
    if not username:
        raise credentials_exc

    user = db.query(User).filter(User.username == username).first()
    if not user or not user.is_active:
        raise credentials_exc

    return user


def require_role(*roles: str):
    """
    Returns a dependency that enforces one of the given roles.

    Example:
        Depends(require_role("ADMIN"))
        Depends(require_role("ADMIN", "OPERADOR"))
    """
    def _check(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Acceso denegado. Se requiere rol: {' o '.join(roles)}.",
            )
        return user
    return _check
