"""
Mercado router — market watchlist for BYMA Panel Líder and Merval General groups.

GET  /api/mercado/grupos   — returns stored prices for all active group tickers
POST /api/mercado/refresh  — fetches from yfinance and saves to PrecioMercado
"""

import asyncio

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.especie_mercado import EspecieMercado
from app.models.precio_mercado import PrecioMercado
from app.models.user import User
from app.services.precio_service import (
    TICKER_MAP,
    get_ticker_map_from_db,
    get_grupo_from_db,
    _fetch_yfinance_prices,
    _upsert,
)
from app.services.tipo_cambio_service import get_tipo_cambio

router = APIRouter(prefix="/api/mercado", tags=["mercado"])


def _build_grupo(especies: list[str], precios_db: dict[str, PrecioMercado], ticker_map: dict) -> list[dict]:
    result = []
    for esp in especies:
        pm = precios_db.get(esp)
        result.append({
            "especie": esp,
            "precio": pm.precio if pm else None,
            "variacion_pct": round(pm.variacion_pct, 2) if pm and pm.variacion_pct is not None else None,
            "fuente": pm.fuente if pm else None,
            "tiene_yf": esp in ticker_map,
        })
    return result


@router.get("/especies")
def list_especies(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Returns all active tickers from DB (used to populate frontend datalist)."""
    rows = db.execute(
        select(EspecieMercado.especie)
        .where(EspecieMercado.activo == True)
        .order_by(EspecieMercado.panel, EspecieMercado.especie)
    ).scalars().all()
    return rows


@router.get("/grupos")
def get_grupos(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Returns stored prices for all active group tickers (fast, no blocking IO)."""
    grupo_byma = get_grupo_from_db(db, "BYMA") or [
        "ALUA", "BBAR", "BMA", "BYMA", "CEPU", "COME", "CRES", "EDN",
        "GGAL", "LOMA", "METR", "PAMP", "SUPV", "TECO2", "TGNO4",
        "TGSU2", "TRAN", "TXAR", "VALO", "YPFD",
    ]
    grupo_merval = get_grupo_from_db(db, "MERVAL") or []
    grupo_usd    = get_grupo_from_db(db, "USD") or []

    all_especies = list(set(grupo_byma + grupo_merval + grupo_usd))
    rows = db.execute(
        select(PrecioMercado).where(PrecioMercado.especie.in_(all_especies))
    ).scalars().all()
    precios_db = {pm.especie: pm for pm in rows}

    # Prefer DB ticker map; fall back to hardcoded
    ticker_map = get_ticker_map_from_db(db) or TICKER_MAP

    tc = get_tipo_cambio()
    return {
        "byma":           _build_grupo(grupo_byma, precios_db, ticker_map),
        "merval_general": _build_grupo(grupo_merval, precios_db, ticker_map),
        "usd":            _build_grupo(grupo_usd, precios_db, ticker_map),
        "tipo_cambio":    tc,
    }


@router.post("/refresh")
async def refresh_grupos(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Fetches yfinance prices for all active mapped tickers and saves to DB."""
    grupo_byma = get_grupo_from_db(db, "BYMA")
    grupo_merval = get_grupo_from_db(db, "MERVAL")
    grupo_usd = get_grupo_from_db(db, "USD")
    all_especies = list(set(grupo_byma + grupo_merval + grupo_usd))

    ticker_map = get_ticker_map_from_db(db) or TICKER_MAP
    to_fetch: dict[str, str] = {
        esp: ticker_map[esp] for esp in all_especies if esp in ticker_map
    }

    # Deduplicate YF symbols (several D/C variants share the same base symbol)
    unique_symbols = list(set(to_fetch.values()))
    yf_prices = await asyncio.to_thread(_fetch_yfinance_prices, unique_symbols)

    updated = []
    for especie, yf_sym in to_fetch.items():
        precio = yf_prices.get(yf_sym)
        if precio:
            _upsert(db, especie, float(precio), fuente="yfinance")
            updated.append(especie)

    if updated:
        db.commit()

    return {"updated": sorted(updated), "total": len(updated)}
