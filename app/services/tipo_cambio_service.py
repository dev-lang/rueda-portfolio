"""
Tipo de cambio service.

Fetches USD/ARS exchange rates (MEP, CCL, oficial) from dolarapi.com.
Results are cached for 15 minutes to avoid hammering the public API.
Used to calculate the implicit FX rate for D-variant instruments.

Cache strategy:
- Successful fetches: cached for _CACHE_TTL seconds
- Failed fetches: cached for _ERROR_TTL seconds (short retry window)
  so a transient outage doesn't make every request hit a dead endpoint

Persistence:
- guardar_historico(db) writes one TipoCambioHistorico row per type per day
  (idempotent — called by the price_feed background task at startup and daily).
"""

import logging
import time
import urllib.request
import json
from datetime import date
from typing import TypedDict

logger = logging.getLogger(__name__)

_CACHE_TTL = 900   # 15 minutes for successful fetches
_ERROR_TTL = 60    # 1 minute retry window on failure

_EMPTY: dict = {"mep": None, "ccl": None, "oficial": None}

_cache: dict = {}


class TipoCambio(TypedDict):
    mep: float | None
    ccl: float | None
    oficial: float | None


def _fetch() -> list:
    url = "https://dolarapi.com/v1/dolares"
    req = urllib.request.Request(url, headers={"User-Agent": "rueda-portfolio/2.0"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        raw = json.loads(resp.read())
    if not isinstance(raw, list):
        raise ValueError(f"Respuesta inesperada de dolarapi.com: {type(raw)}")
    return raw


def _parse(dolares: list) -> TipoCambio:
    data: TipoCambio = {"mep": None, "ccl": None, "oficial": None}
    for d in dolares:
        if not isinstance(d, dict):
            continue
        nombre = str(d.get("nombre") or "").lower()
        venta = d.get("venta")
        if venta is None:
            continue
        try:
            venta_f = float(venta)
        except (TypeError, ValueError):
            continue
        if "bolsa" in nombre:
            data["mep"] = venta_f
        elif "contado" in nombre:
            data["ccl"] = venta_f
        elif "oficial" in nombre:
            data["oficial"] = venta_f
    return data


def get_tipo_cambio() -> TipoCambio:
    """
    Returns {mep, ccl, oficial} as float venta rates (or None if unavailable).
    Uses a two-tier cache: successful responses for 15 min, errors for 1 min.
    """
    now = time.time()
    cached_ts   = _cache.get("ts")
    cached_data = _cache.get("data")
    cached_err  = _cache.get("err_ts")

    # Return cached success if still fresh
    if cached_ts and cached_data and now - cached_ts < _CACHE_TTL:
        return cached_data

    # Don't hammer a failing endpoint — wait out the error TTL
    if cached_err and now - cached_err < _ERROR_TTL:
        return cached_data or _EMPTY

    try:
        dolares = _fetch()
        data = _parse(dolares)
        _cache["ts"]   = now
        _cache["data"] = data
        _cache.pop("err_ts", None)  # clear error marker on success
        return data
    except Exception:
        logger.exception("[TipoCambio] Error al consultar dolarapi.com")
        _cache["err_ts"] = now  # mark failure timestamp for error TTL
        # Return last known data if available, otherwise empty
        return cached_data or _EMPTY


def guardar_historico(db) -> int:
    """
    Persist today's FX rates to TipoCambioHistorico (one row per type).
    Idempotent — safe to call multiple times per day (upserts by fecha+tipo).
    Returns number of rows written/updated.
    Caller is responsible for committing the transaction.
    """
    from sqlalchemy import select
    from app.models.tipo_cambio import TipoCambioHistorico

    rates = get_tipo_cambio()
    hoy = date.today()

    # Map from our internal keys to display type codes
    mapping = {
        "mep":     ("MEP",    None),
        "ccl":     ("CCL",    None),
        "oficial": ("OFICIAL", None),
    }

    written = 0
    for key, (tipo, _) in mapping.items():
        valor = rates.get(key)
        if valor is None:
            continue

        existing = db.execute(
            select(TipoCambioHistorico).where(
                TipoCambioHistorico.fecha == hoy,
                TipoCambioHistorico.tipo  == tipo,
            )
        ).scalar_one_or_none()

        if existing:
            existing.valor_venta = valor
            existing.valor_compra = valor   # dolarapi only gives venta for these
        else:
            db.add(TipoCambioHistorico(
                fecha=hoy,
                tipo=tipo,
                valor_compra=valor,
                valor_venta=valor,
                fuente="dolarapi.com",
            ))
        written += 1

    return written


def listar_historico(
    db,
    tipo: str | None = None,
    fecha_desde: date | None = None,
    fecha_hasta: date | None = None,
) -> list:
    from sqlalchemy import select
    from app.models.tipo_cambio import TipoCambioHistorico

    stmt = select(TipoCambioHistorico)
    if tipo:
        stmt = stmt.where(TipoCambioHistorico.tipo == tipo.upper())
    if fecha_desde:
        stmt = stmt.where(TipoCambioHistorico.fecha >= fecha_desde)
    if fecha_hasta:
        stmt = stmt.where(TipoCambioHistorico.fecha <= fecha_hasta)
    return db.execute(
        stmt.order_by(TipoCambioHistorico.fecha.desc(), TipoCambioHistorico.tipo)
    ).scalars().all()


def get_tc_para_fecha(db, tipo: str, fecha: date) -> float | None:
    """
    Returns the closest available FX rate for a given tipo and date.
    Looks up to 5 days back to handle weekends/holidays.
    """
    from sqlalchemy import select
    from app.models.tipo_cambio import TipoCambioHistorico
    from datetime import timedelta

    for delta in range(5):
        d = fecha - timedelta(days=delta)
        row = db.execute(
            select(TipoCambioHistorico.valor_venta).where(
                TipoCambioHistorico.fecha == d,
                TipoCambioHistorico.tipo  == tipo.upper(),
            )
        ).scalar_one_or_none()
        if row is not None:
            return row

    # Final fallback: current live rate
    rates = get_tipo_cambio()
    return rates.get(tipo.lower())
