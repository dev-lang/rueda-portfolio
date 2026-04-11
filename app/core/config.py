import logging
import os
from dotenv import load_dotenv

load_dotenv()

_log = logging.getLogger(__name__)

# ── JWT secret — fail-fast if not configured ─────────────────────────────────
# Tokens must survive restarts: a random key would invalidate all sessions on
# every deploy. Generate once and store in .env:
#   python -c "import secrets; print(secrets.token_hex(32))"
_jwt_secret = os.getenv("JWT_SECRET_KEY")
if not _jwt_secret:
    raise ValueError(
        "La variable de entorno JWT_SECRET_KEY no está configurada.\n"
        "Generá una clave con:\n"
        "  python -c \"import secrets; print(secrets.token_hex(32))\"\n"
        "y añadila al archivo .env como: JWT_SECRET_KEY=<clave>"
    )


class Settings:
    # ── Database ──────────────────────────────────────────────────────────────
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./ordenes.db")
    RESET_DB_ON_START: bool = os.getenv("RESET_DB_ON_START", "false").lower() == "true"

    # ── CORS ──────────────────────────────────────────────────────────────────
    # Comma-separated list of allowed origins. Override via env var for prod.
    # Example: CORS_ORIGINS="https://mi-app.com,https://www.mi-app.com"
    _cors_raw: str = os.getenv("CORS_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000,http://100.122.23.117:8000")
    CORS_ORIGINS: list[str] = [o.strip() for o in _cors_raw.split(",") if o.strip()]

    # ── JWT ───────────────────────────────────────────────────────────────────
    JWT_SECRET_KEY: str = _jwt_secret
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
    REFRESH_TOKEN_EXPIRE_DAYS: int = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))

    # ── Admin seed ────────────────────────────────────────────────────────────
    # Initial admin user created on first startup if no users exist.
    ADMIN_USERNAME: str = os.getenv("ADMIN_USERNAME", "admin")
    ADMIN_PASSWORD: str = os.getenv("ADMIN_PASSWORD", "changeme123")

    # ── Operador users (created on first startup alongside admin) ─────────────
    OPERADOR1_USERNAME: str = os.getenv("OPERADOR1_USERNAME", "operador1")
    OPERADOR1_PASSWORD: str = os.getenv("OPERADOR1_PASSWORD", "operador123")
    OPERADOR2_USERNAME: str = os.getenv("OPERADOR2_USERNAME", "operador2")
    OPERADOR2_PASSWORD: str = os.getenv("OPERADOR2_PASSWORD", "operador456")

    # ── Market bot ────────────────────────────────────────────────────────────
    # Background task that simulates market volume by varying prices.
    MARKET_BOT_ENABLED: bool = os.getenv("MARKET_BOT_ENABLED", "true").lower() == "true"
    MARKET_BOT_INTERVAL: float = float(os.getenv("MARKET_BOT_INTERVAL", "5"))
    MARKET_BOT_VARIANCE: float = float(os.getenv("MARKET_BOT_VARIANCE", "0.008"))

    # ── App domain (used for CSP in production) ───────────────────────────────
    APP_DOMAIN: str = os.getenv("APP_DOMAIN", "localhost")


settings = Settings()

# ── Startup warnings for insecure defaults ────────────────────────────────────
# Never log the actual default password — only flag that the env var is missing.
_DEFAULT_PASSWORD_VARS = {
    "ADMIN_PASSWORD":     "admin",
    "OPERADOR1_PASSWORD": "operador1",
    "OPERADOR2_PASSWORD": "operador2",
}
for _env_var, _user in _DEFAULT_PASSWORD_VARS.items():
    if os.getenv(_env_var) is None:
        _log.warning(
            "SEGURIDAD: %s no está configurada. El usuario '%s' usará una contraseña "
            "por defecto insegura. Configurá %s en .env antes de ir a producción.",
            _env_var, _user, _env_var,
        )
