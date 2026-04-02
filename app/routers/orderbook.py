"""
Order Book endpoint — constructs levels from last market price + percentage spread.

Reference price: PrecioMercado table (refreshed every 5 min by price_feed background task).
Fallback: direct yfinance fetch (cached 120 s) when the especie has no stored price yet.
Level construction: 5 bid and 5 ask levels at widening percentage increments from last price.
System overlay: pending buy/sell orders from the DB are merged; system orders take priority
over synthetic at the same price level.
"""

import time
import random

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.orden import Orden
from app.models.precio_mercado import PrecioMercado
from app.models.user import User
from app.services.precio_service import TICKER_MAP, _fetch_yfinance_prices
from app.models.bot_instancia import TIPOS_COMPRA as _TIPOS_COMPRA, TIPOS_VENTA as _TIPOS_VENTA

router = APIRouter(prefix="/api/orderbook", tags=["orderbook"])
_ESTADOS_EXCL = {"Ejecutada", "Cancelada"}

# Number of synthetic depth levels on each side
_N_LEVELS = 5

# Short TTL cache for direct yfinance fallback.
# Only successful fetches are cached; failures are retried immediately.
# especie → (timestamp, price)  — only stored when price is not None
_yf_fallback_cache: dict[str, tuple[float, float]] = {}
_YF_TTL = 120  # seconds

# Valid ticker character whitelist (uppercase alphanumeric + dot)
import re as _re
_ESPECIE_RE = _re.compile(r'^[A-Z0-9.]{1,20}$')


def _get_price_fallback(especie: str) -> float | None:
    """
    Fetches last price directly from yfinance when PrecioMercado has no entry.
    Successful results are cached for _YF_TTL seconds.
    Failed fetches are NOT cached so they are retried on the next request.
    Safe to call from a sync route handler (FastAPI runs sync routes in a thread pool).
    """
    sym = TICKER_MAP.get(especie)
    if not sym:
        return None

    now = time.time()
    cached = _yf_fallback_cache.get(especie)
    if cached and now - cached[0] < _YF_TTL:
        return cached[1]

    prices = _fetch_yfinance_prices([sym])
    precio = prices.get(sym)
    if precio:
        result = round(float(precio), 4)
        _yf_fallback_cache[especie] = (now, result)  # only cache successes
        return result
    return None  # failure: not cached, will retry next call


def _tick_size(price: float) -> float:
    """Minimum price increment (tick) for Argentine equities by price range."""
    if price >= 50_000:   return 500.0
    elif price >= 10_000: return 100.0
    elif price >= 1_000:  return 5.0
    elif price >= 100:    return 1.0
    elif price >= 10:     return 0.5
    else:                 return 0.1


def _round_to_tick(price: float) -> float:
    """Round a price to the nearest market-appropriate tick."""
    tick = _tick_size(price)
    return round(round(price / tick) * tick, 2)


def _synthetic_qty(price: float) -> int:
    """
    Generate a plausible round-number quantity for a synthetic level.
    Quantity ranges are inversely proportional to price (cheaper stocks → more shares).
    """
    if price >= 10_000:   choices = [10, 20, 50, 100]
    elif price >= 1_000:  choices = [100, 200, 500, 1_000]
    elif price >= 100:    choices = [500, 1_000, 2_000, 5_000]
    else:                 choices = [1_000, 5_000, 10_000, 20_000]
    return random.choice(choices)


def _build_synthetic(base: float) -> tuple[list[dict], list[dict]]:
    """
    Return _N_LEVELS bid and ask synthetic levels, each exactly 1 tick apart.
    Using tick increments (not percentages) guarantees _N_LEVELS unique prices
    for any price range, since each level differs by exactly 1 tick.
    """
    rounded = _round_to_tick(base)
    tick    = _tick_size(base)
    bids = [
        {"precio": round(rounded - (i + 1) * tick, 4), "cantidad": _synthetic_qty(base), "fuente": "estimado"}
        for i in range(_N_LEVELS)
    ]
    asks = [
        {"precio": round(rounded + (i + 1) * tick, 4), "cantidad": _synthetic_qty(base), "fuente": "estimado"}
        for i in range(_N_LEVELS)
    ]
    return bids, asks


def _merge(synthetic: list[dict], system: list[dict], *, desc: bool) -> list[dict]:
    """
    Merge synthetic and system levels into a single sorted list (max 5).
    System orders override synthetic entries at the exact same price.
    """
    by_price: dict[float, dict] = {r["precio"]: r for r in synthetic}
    for s in system:
        by_price[s["precio"]] = s  # system wins at colliding prices
    return sorted(by_price.values(), key=lambda r: r["precio"], reverse=desc)[:_N_LEVELS]


@router.get("/{especie}")
def get_orderbook(
    especie: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    especie = especie.upper().strip()

    _empty = {
        "especie": especie, "bids": [], "asks": [],
        "ultimo": None, "variacion_pct": None,
        "spread": None, "spread_pct": None,
        "fuente_nivel1": None, "tiene_datos": False,
    }

    # Validate especie format against whitelist (prevents path traversal / injection)
    if not _ESPECIE_RE.match(especie):
        return _empty

    # ── Reference price: DB first, yfinance direct fallback ────────────────────
    pm = db.execute(
        select(PrecioMercado).where(PrecioMercado.especie == especie)
    ).scalar_one_or_none()

    ultimo = round(pm.precio, 4) if pm and pm.precio else None
    variacion_pct = pm.variacion_pct if pm else None

    if not ultimo:
        ultimo = _get_price_fallback(especie)

    if not ultimo:
        return _empty

    # ── Synthetic levels ────────────────────────────────────────────────────────
    syn_bids, syn_asks = _build_synthetic(ultimo)

    # ── System orders (pending) ─────────────────────────────────────────────────
    bid_rows = db.execute(
        select(
            Orden.precio_limite,
            func.sum(Orden.cantidad_total - Orden.cantidad_ejecutada).label("cantidad"),
        )
        .where(
            Orden.especie == especie,
            Orden.tipo_orden.in_(_TIPOS_COMPRA),
            Orden.instancia.notin_(_ESTADOS_EXCL),
            Orden.cantidad_total > Orden.cantidad_ejecutada,
        )
        .group_by(Orden.precio_limite)
        .order_by(Orden.precio_limite.desc())
        .limit(_N_LEVELS)
    ).all()

    ask_rows = db.execute(
        select(
            Orden.precio_limite,
            func.sum(Orden.cantidad_total - Orden.cantidad_ejecutada).label("cantidad"),
        )
        .where(
            Orden.especie == especie,
            Orden.tipo_orden.in_(_TIPOS_VENTA),
            Orden.instancia.notin_(_ESTADOS_EXCL),
            Orden.cantidad_total > Orden.cantidad_ejecutada,
        )
        .group_by(Orden.precio_limite)
        .order_by(Orden.precio_limite.asc())
        .limit(_N_LEVELS)
    ).all()

    sys_bids = [{"precio": r.precio_limite, "cantidad": int(r.cantidad), "fuente": "sistema"} for r in bid_rows if r.precio_limite is not None]
    sys_asks = [{"precio": r.precio_limite, "cantidad": int(r.cantidad), "fuente": "sistema"} for r in ask_rows if r.precio_limite is not None]

    # ── Merge ───────────────────────────────────────────────────────────────────
    bids = _merge(syn_bids, sys_bids, desc=True)   # DESC: best bid (highest) first
    asks = _merge(syn_asks, sys_asks, desc=False)  # ASC:  best ask (lowest)  first

    # ── Spread ──────────────────────────────────────────────────────────────────
    bb = bids[0]["precio"] if bids else None
    ba = asks[0]["precio"] if asks else None
    spread     = round(ba - bb, 4)           if bb and ba else None
    spread_pct = round((ba - bb) / bb * 100, 2) if bb and ba and bb > 0 else None

    return {
        "especie":       especie,
        "ultimo":        ultimo,
        "variacion_pct": variacion_pct,
        "spread":        spread,
        "spread_pct":    spread_pct,
        "fuente_nivel1": "estimado",
        "tiene_datos":   True,
        "bids": bids,
        "asks": asks,
    }
