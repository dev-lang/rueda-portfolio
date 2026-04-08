import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

logger = logging.getLogger(__name__)

import socketio
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from starlette.middleware.base import BaseHTTPMiddleware

# Core
from app.core.config import settings
from app.core.socketio import sio

# DB — models must be imported before create_all() so metadata is populated
from app.db.base import Base, engine
from app.db.session import SessionLocal
from app.db.migrations import run_migrations
from app.db.seed import (
    seed_database, seed_admin_user, seed_clientes,
    seed_especies_mercado, seed_bot_instancias, seed_cuentas,
    seed_settlement_rules, seed_contrapartes, seed_limites_riesgo,
    seed_instrumentos, seed_cartera_propia, seed_config_sistema,
    seed_cuentas_operadores,
)
import app.models  # noqa: F401 — registers all ORM models with Base.metadata

# Routers
from app.routers import (
    ordenes, transacciones, posiciones, notificaciones,
    filtros, informes, utilitarios, auditoria, precios, orderbook, mercado,
    auth, users, clientes, admin, cuentas,
    contrapartes, liquidaciones, riesgo,
    instrumentos, pnl, tipo_cambio, reportes_regulatorios,
    operadores, firma, alertas, seguidos,
)

# Simulator
from app.simulador.background import run_simulador
from app.simulador.price_feed import run_price_feed
from app.simulador.market_bot import run_market_bot
from app.simulador.alertas_vencimiento import run_alertas_vencimiento
from app.simulador.matching_engine import run_matching_engine

BASE_DIR = Path(__file__).parent.parent  # project root (contains static/ and templates/)


# ── Rate limiter ──────────────────────────────────────────────────────────────
from app.core.rate_limiter import limiter


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    # Run column migrations BEFORE create_all so existing tables get new columns
    run_migrations(engine)
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        seed_database(db)
        seed_admin_user(db)
        seed_clientes(db)
        seed_especies_mercado(db)
        seed_bot_instancias(db)
        seed_cuentas(db)              # must run after clientes + bots exist
        seed_settlement_rules(db)     # T+0/T+1/T+2 rules per market
        seed_contrapartes(db)         # standard Argentine market counterparties
        seed_limites_riesgo(db)       # default global risk limits
        seed_instrumentos(db)         # instrument catalog (renta fija, futuros, acciones)
        seed_cartera_propia(db)       # mark STD client as cartera propia
        seed_config_sistema(db)       # system config row (auto_matching default off)
        seed_cuentas_operadores(db)   # zero-balance accounts for each active operador
    except Exception:
        db.rollback()
        logger.exception("Error crítico durante seeding — la app no puede iniciar.")
        raise
    finally:
        db.close()

    sim_task       = asyncio.create_task(run_simulador())
    price_task     = asyncio.create_task(run_price_feed())
    bot_task       = asyncio.create_task(run_market_bot())
    vencim_task    = asyncio.create_task(run_alertas_vencimiento())
    match_task     = asyncio.create_task(run_matching_engine())

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    for task in (sim_task, price_task, bot_task, vencim_task, match_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


# ── Security headers middleware ───────────────────────────────────────────────

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
        # CSP: allow WebSocket connections to the configured domain
        domain = settings.APP_DOMAIN
        # NOTE: 'unsafe-inline' is required because index.html uses onclick="..."
        # attributes extensively. Long-term fix: migrate all inline handlers to
        # addEventListener in main.js and remove 'unsafe-inline'.
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "font-src 'self'; "
            f"connect-src 'self' ws://{domain}:* wss://{domain}:*; "
            "img-src 'self' data:; "
            "frame-ancestors 'none';"
        )
        return response


# ── FastAPI app ───────────────────────────────────────────────────────────────

fastapi_app = FastAPI(title="Rueda Portfolio", version="2.0.0", lifespan=lifespan)

# Rate limiter
fastapi_app.state.limiter = limiter
fastapi_app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS — restricted to configured origins (no wildcard)
fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,  # required for httpOnly cookie auth
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)

fastapi_app.add_middleware(SecurityHeadersMiddleware)

fastapi_app.mount(
    "/static",
    StaticFiles(directory=str(BASE_DIR / "static")),
    name="static",
)
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


# ── Routes ────────────────────────────────────────────────────────────────────

@fastapi_app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@fastapi_app.get("/login")
async def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})


# ── Routers ───────────────────────────────────────────────────────────────────

fastapi_app.include_router(auth.router)
fastapi_app.include_router(users.router)
fastapi_app.include_router(ordenes.router)
fastapi_app.include_router(transacciones.router)
fastapi_app.include_router(posiciones.router)
fastapi_app.include_router(notificaciones.router)
fastapi_app.include_router(filtros.router)
fastapi_app.include_router(informes.router)
fastapi_app.include_router(utilitarios.router)
fastapi_app.include_router(auditoria.router)
fastapi_app.include_router(precios.router)
fastapi_app.include_router(orderbook.router)
fastapi_app.include_router(mercado.router)
fastapi_app.include_router(clientes.router)
fastapi_app.include_router(admin.router)
fastapi_app.include_router(cuentas.router)
fastapi_app.include_router(contrapartes.router)
fastapi_app.include_router(liquidaciones.router)
fastapi_app.include_router(riesgo.router)
fastapi_app.include_router(instrumentos.router)
fastapi_app.include_router(pnl.router)
fastapi_app.include_router(tipo_cambio.router)
fastapi_app.include_router(reportes_regulatorios.router)
fastapi_app.include_router(operadores.router)
fastapi_app.include_router(firma.router)
fastapi_app.include_router(alertas.router)
fastapi_app.include_router(seguidos.router)


# ── Socket.IO events ──────────────────────────────────────────────────────────

@sio.event
async def connect(sid, environ, auth=None):
    """
    Validates the access_token passed in the Socket.IO handshake auth dict.
    Clients must connect with: io({ auth: { token: accessToken } })
    The token is extracted from a cookie on the client side via document.cookie
    — but since the cookie is httpOnly, we read it from the HTTP environ instead.
    """
    from app.core.security import decode_token
    from jose import JWTError

    # Primary: read access_token from httpOnly cookie in the HTTP headers
    http_cookie = environ.get("HTTP_COOKIE", "")
    token = None
    for part in http_cookie.split(";"):
        part = part.strip()
        if part.startswith("access_token="):
            token = part[len("access_token="):]
            break

    # Fallback: token passed explicitly in auth dict (for non-browser clients)
    if not token and auth and isinstance(auth, dict):
        token = auth.get("token")

    if not token:
        logger.warning("[WS] Conexión rechazada (sin token): %s", sid)
        return False  # returning False disconnects the client

    try:
        payload = decode_token(token)
        if payload.get("type") != "access":
            raise JWTError("not access token")
        username = payload.get("sub", "desconocido")
    except JWTError:
        logger.warning("[WS] Conexión rechazada (token inválido): %s", sid)
        return False

    logger.info("[WS] Cliente conectado: %s (%s)", sid, username)
    await sio.emit("status", {"msg": "Conectado al servidor Rueda Portfolio"}, to=sid)


@sio.event
async def disconnect(sid):
    logger.info("[WS] Cliente desconectado: %s", sid)


# ── ASGI app (Socket.IO wraps FastAPI) ────────────────────────────────────────
# Uvicorn must point to this object: uvicorn app.main:app

app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)
