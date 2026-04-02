"""
Shared rate-limiter instance.

Imported by main.py (to register with the app) and by individual routers
that need endpoint-specific limits (e.g. order creation).

Key function: identifies requests by authenticated user (JWT sub claim)
so limits are per-user rather than per-IP, which is more accurate behind
a reverse proxy where many users share the same IP.
"""

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


def _get_rate_limit_key(request: Request) -> str:
    access_token = request.cookies.get("access_token")
    if access_token:
        try:
            from app.core.security import decode_token
            payload = decode_token(access_token)
            sub = payload.get("sub")
            if sub:
                return f"user:{sub}"
        except Exception:
            pass
    return get_remote_address(request)


limiter = Limiter(key_func=_get_rate_limit_key, default_limits=["300/minute"])
