import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import select

logger = logging.getLogger(__name__)

from collections import defaultdict

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.models.precio_mercado import PrecioMercado
from app.models.ejecucion import Ejecucion
from app.models.orden import Orden
from app.services import precio_service
from app.core.socketio import sio
from app.schemas.precios import PrecioManualRequest, CierreAjusteRequest

router = APIRouter(prefix="/api/prices", tags=["precios"])


@router.get("")
def listar_precios(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Returns all stored market prices with P&L capability indicator."""
    precios = precio_service.get_all(db)
    mapped = set(precio_service.TICKER_MAP.keys())
    return {
        "precios": [p.to_dict() for p in precios],
        "ticker_map": {k: v for k, v in precio_service.TICKER_MAP.items()},
        "especies_sin_feed": [
            p.especie for p in precios if p.especie not in mapped
        ],
    }


@router.post("/manual")
async def precio_manual(
    payload: PrecioManualRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    pm = precio_service.upsert_manual(db, payload.especie, payload.precio)
    await sio.emit("precios_actualizados", {
        "precios": [p.to_dict() for p in precio_service.get_all(db)],
    })
    return {"success": True, "precio": pm.to_dict()}


@router.post("/refresh")
async def forzar_refresh(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Triggers an immediate yfinance fetch outside the scheduled interval."""
    try:
        actualizadas = await precio_service.fetch_and_update(db)
    except Exception:
        logger.exception("Error al consultar yfinance en /api/prices/refresh")
        raise HTTPException(
            status_code=500,
            detail="Error al actualizar precios. Ver logs del servidor.",
        )

    precios = precio_service.get_all(db)
    if precios:
        await sio.emit("precios_actualizados", {
            "precios": [p.to_dict() for p in precios],
        })

    return {
        "success": True,
        "actualizadas": actualizadas,
        "sin_ticker": [
            esp for esp in actualizadas
            if esp not in precio_service.TICKER_MAP
        ],
    }


@router.post("/cierre-ajuste")
def registrar_cierre_ajuste(
    payload: CierreAjusteRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """
    Registers an official valuation price (BYMA adjustment, ROFEX settlement,
    or MAE RF cut-off price) for a specific (especie, fecha).
    Overwrites an existing row for the same (especie, fecha, precio_tipo).
    Feature 16.
    """
    row = precio_service.upsert_precio_ajuste(
        db,
        especie=payload.especie,
        precio=payload.precio,
        fecha=payload.fecha,
        precio_tipo=payload.precio_tipo,
        fuente=payload.fuente,
    )
    return {
        "success":     True,
        "especie":     row.especie,
        "fecha":       row.fecha.isoformat(),
        "precio":      row.precio,
        "precio_tipo": row.precio_tipo,
        "fuente":      row.fuente,
    }


@router.get("/historico")
def precios_historico(
    especie:     str | None = Query(default=None),
    fecha_desde: date | None = Query(default=None),
    fecha_hasta: date | None = Query(default=None),
    precio_tipo: str | None = Query(default=None, description="CIERRE | AJUSTE | CORTE_MAE"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Historical prices with optional filters. Feature 16."""
    rows = precio_service.listar_precios_historico(
        db,
        especie=especie,
        fecha_desde=fecha_desde,
        fecha_hasta=fecha_hasta,
        precio_tipo=precio_tipo,
    )
    return {
        "precios": [
            {
                "id":          r.id,
                "especie":     r.especie,
                "fecha":       r.fecha.isoformat(),
                "precio":      r.precio,
                "precio_tipo": r.precio_tipo,
                "fuente":      r.fuente,
            }
            for r in rows
        ]
    }


# ── Chart interval helpers ────────────────────────────────────────────────────

# Intervals that require sub-daily yfinance fetch (intraday)
_INTRADAY_INTERVALS = {"15m", "30m", "45m", "1h", "2h", "3h", "4h"}

# intervalo → (yf_interval, default_period_when_no_fecha_desde)
_YF_INTERVAL_PARAMS: dict[str, tuple[str, str]] = {
    "15m": ("15m",  "5d"),
    "30m": ("30m",  "7d"),
    "45m": ("60m",  "7d"),   # yfinance has no 45m; use 1h
    "1h":  ("60m",  "30d"),
    "2h":  ("60m",  "60d"),
    "3h":  ("60m",  "90d"),
    "4h":  ("60m",  "90d"),
    "1w":  ("1wk",  "2y"),
    "1mo": ("1mo",  "5y"),
    "3mo": ("3mo",  "max"),
}

# Intervals that need resampling from 1h yfinance data
_RESAMPLE_HOURS: dict[str, int] = {"2h": 2, "3h": 3, "4h": 4}


def _yf_fetch_ohlcv(
    yf_symbol: str,
    yf_interval: str,
    period: str | None,
    fecha_desde: "date | None",
    fecha_hasta: "date | None",
    resample_hours: int | None,
) -> list[dict]:
    """Synchronous yfinance OHLCV fetch. Run via asyncio.to_thread()."""
    import yfinance as yf

    t = yf.Ticker(yf_symbol)
    if fecha_desde:
        hist = t.history(
            interval=yf_interval,
            start=str(fecha_desde),
            end=str(fecha_hasta or date.today()),
        )
    else:
        hist = t.history(interval=yf_interval, period=period)

    if hist is None or hist.empty:
        return []

    if resample_hours and resample_hours > 1:
        hist = hist.resample(f"{resample_hours}h").agg(
            {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
        ).dropna()

    result = []
    for ts, row in hist.iterrows():
        try:
            o, h, l, c = float(row["Open"]), float(row["High"]), float(row["Low"]), float(row["Close"])
        except (TypeError, ValueError):
            continue
        if any(v != v for v in (o, h, l, c)):  # NaN guard
            continue
        result.append({
            "time":   int(ts.timestamp()),
            "open":   o,
            "high":   h,
            "low":    l,
            "close":  c,
            "volume": float(row.get("Volume", 0) or 0),
        })
    return result


def _aggregate_ohlcv(buckets: dict) -> list[dict]:
    """Convert {key: [(precio, cantidad), ...]} to sorted OHLCV list."""
    data = []
    for key in sorted(buckets.keys(), key=str):
        entries = buckets[key]
        prices  = [e[0] for e in entries]
        volumes = [e[1] for e in entries]
        data.append({
            "time":   key,
            "open":   prices[0],
            "high":   max(prices),
            "low":    min(prices),
            "close":  prices[-1],
            "volume": sum(volumes),
        })
    return data


def _sistema_bucket_key(fecha, created_at, intervalo: str):
    """Return the bucket key (Unix int for intraday, ISO string for daily/weekly)."""
    from datetime import timedelta
    if intervalo in _INTRADAY_INTERVALS:
        mins = {"15m": 15, "30m": 30, "45m": 45, "1h": 60, "2h": 120, "3h": 180, "4h": 240}[intervalo]
        dt = created_at.replace(second=0, microsecond=0)
        dt = dt.replace(minute=(dt.minute // mins) * mins)
        return int(dt.timestamp())
    if intervalo == "1w":
        monday = fecha - __import__("datetime").timedelta(days=fecha.weekday())
        return monday.isoformat()
    if intervalo in ("1mo", "3mo"):
        return fecha.strftime("%Y-%m-01")  # first of month
    return fecha.isoformat()  # 1d (daily)


def _weekly_from_daily(rows) -> list[dict]:
    """Aggregate PrecioHistorico daily rows into weekly OHLCV bars."""
    from datetime import timedelta
    buckets: dict = defaultdict(list)
    for r in rows:
        monday = r.fecha - timedelta(days=r.fecha.weekday())
        buckets[monday.isoformat()].append((r.precio, 0))
    return _aggregate_ohlcv(buckets)


def _monthly_from_daily(rows) -> list[dict]:
    """Aggregate PrecioHistorico daily rows into monthly OHLCV bars."""
    buckets: dict = defaultdict(list)
    for r in rows:
        buckets[r.fecha.strftime("%Y-%m-01")].append((r.precio, 0))
    return _aggregate_ohlcv(buckets)


@router.get("/chart/{especie}")
async def chart_data(
    especie: str,
    fecha_desde: date | None = Query(default=None),
    fecha_hasta: date | None = Query(default=None),
    fuente: str = Query(default="mercado", description="mercado | sistema"),
    intervalo: str = Query(default="1d", description="15m|30m|45m|1h|2h|3h|4h|1d|1w|1mo|3mo"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Price series optimised for Lightweight Charts.

    fuente=mercado: PrecioHistorico (daily closes) or yfinance intraday/weekly.
    fuente=sistema: OHLCV aggregated from Ejecucion table.

    intervalo controls candle resolution.  Intraday intervals return Unix timestamps;
    daily/weekly/monthly return ISO date strings — both formats work in LWC v4.
    """
    import asyncio as _asyncio
    esp = especie.upper().strip()

    # ── SISTEMA mode ─────────────────────────────────────────────────────────
    if fuente == "sistema":
        filters = [Orden.especie == esp]
        if fecha_desde:
            filters.append(Ejecucion.fecha >= fecha_desde)
        if fecha_hasta:
            filters.append(Ejecucion.fecha <= fecha_hasta)

        rows = db.execute(
            select(
                Ejecucion.fecha,
                Ejecucion.precio,
                Ejecucion.cantidad,
                Ejecucion.created_at,
            )
            .join(Orden, Ejecucion.orden_id == Orden.id)
            .where(*filters)
            .order_by(Ejecucion.fecha, Ejecucion.created_at)
        ).all()

        buckets: dict = defaultdict(list)
        for fecha, precio, cantidad, created_at in rows:
            key = _sistema_bucket_key(fecha, created_at, intervalo)
            buckets[key].append((precio, cantidad))

        return {"especie": esp, "fuente": "sistema", "intervalo": intervalo, "data": _aggregate_ohlcv(buckets)}

    # ── MERCADO mode — intraday via yfinance ──────────────────────────────────
    if intervalo in _INTRADAY_INTERVALS or intervalo in _YF_INTERVAL_PARAMS:
        yf_interval, default_period = _YF_INTERVAL_PARAMS.get(
            intervalo, ("1d", "90d")
        )
        resample = _RESAMPLE_HOURS.get(intervalo)
        ticker = precio_service.TICKER_MAP.get(esp)
        if not ticker:
            return {"especie": esp, "fuente": "mercado", "intervalo": intervalo,
                    "data": [], "sin_ticker": True}

        data = await _asyncio.to_thread(
            _yf_fetch_ohlcv,
            ticker, yf_interval, default_period, fecha_desde, fecha_hasta, resample,
        )
        return {"especie": esp, "fuente": "mercado", "intervalo": intervalo, "data": data}

    # ── MERCADO mode — daily closes from PrecioHistorico ─────────────────────
    hist_rows = precio_service.listar_precios_historico(
        db,
        especie=esp,
        fecha_desde=fecha_desde,
        fecha_hasta=fecha_hasta,
        precio_tipo="CIERRE",
    )

    # Weekly/monthly aggregation from stored daily closes
    if intervalo == "1w":
        data = _weekly_from_daily(hist_rows)
        return {"especie": esp, "fuente": "mercado", "intervalo": "1w", "data": data}
    if intervalo in ("1mo", "3mo"):
        data = _monthly_from_daily(hist_rows)
        return {"especie": esp, "fuente": "mercado", "intervalo": intervalo, "data": data}

    # Default: 1d — line/area chart with {time, value}
    data = sorted(
        [{"time": r.fecha.isoformat(), "value": r.precio} for r in hist_rows],
        key=lambda x: x["time"],
    )
    pm = db.execute(select(PrecioMercado).where(PrecioMercado.especie == esp)).scalar_one_or_none()
    today_str = date.today().isoformat()
    if pm and pm.precio and (not data or data[-1]["time"] < today_str):
        data.append({"time": today_str, "value": pm.precio})

    return {"especie": esp, "fuente": "mercado", "intervalo": "1d", "data": data}


@router.post("/snapshot")
def snapshot_manual(
    fecha: date | None = Query(default=None, description="Fecha a snapshottear (default: hoy)"),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """
    Manually triggers a snapshot of current market prices into PrecioHistorico
    as tipo CIERRE. Idempotent — skips species already saved for that date.
    Feature 16.
    """
    n = precio_service.snapshot_diario(db, fecha)
    return {
        "success": True,
        "fecha":   (fecha or __import__("datetime").date.today()).isoformat(),
        "nuevos":  n,
    }
