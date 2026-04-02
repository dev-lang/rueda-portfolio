"""
Market price service.

Fetches prices from Yahoo Finance (via yfinance) for mapped tickers and
falls back gracefully. Instruments not in the map (e.g. bonds) require
manual price entry via POST /api/prices/manual.
"""

import asyncio
from datetime import datetime, timezone, timezone, date
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.models.precio_mercado import PrecioMercado
from app.models.precio_historico import PrecioHistorico

# ── Ticker mapping: especie (internal) → Yahoo Finance symbol ─────────────────
# Add or override here without touching any other file.
# D/C variants (dollar/cable settlement) are mapped to their base ARS ticker
# as a price reference — the actual traded price will differ by the FX rate.
TICKER_MAP: dict[str, str] = {
    # ── BYMA Panel Líder ──────────────────────────────────────────────────────
    "ALUA":  "ALUA.BA",
    "BBAR":  "BBAR.BA",
    "BMA":   "BMA.BA",
    "BYMA":  "BYMA.BA",
    "CEPU":  "CEPU.BA",
    "COME":  "COME.BA",
    "CRES":  "CRES.BA",
    "EDN":   "EDN.BA",
    "GGAL":  "GGAL.BA",
    "LOMA":  "LOMA.BA",
    "METR":  "METR.BA",
    "PAMP":  "PAMP.BA",
    "SUPV":  "SUPV.BA",
    "TECO2": "TECO2.BA",
    "TGNO4": "TGNO4.BA",
    "TGSU2": "TGSU2.BA",
    "TRAN":  "TRAN.BA",
    "TXAR":  "TXAR.BA",
    "VALO":  "VALO.BA",
    "YPFD":  "YPFD.BA",
    # ── Merval General — base tickers ────────────────────────────────────────
    "A3":    "A3.BA",
    "AGRO":  "AGRO.BA",
    "AUSO":  "AUSO.BA",
    "BHIP":  "BHIP.BA",
    "BOLT":  "BOLT.BA",
    "BPAT":  "BPAT.BA",
    "CADO":  "CADO.BA",
    "CAPX":  "CAPX.BA",
    "CARC":  "CARC.BA",
    "CECO2": "CECO2.BA",
    "CELU":  "CELU.BA",
    "CGPA2": "CGPA2.BA",
    "CTIO":  "CTIO.BA",
    "DGCE":  "DGCE.BA",
    "DGCU2": "DGCU2.BA",
    "ECOG":  "ECOG.BA",
    "FERR":  "FERR.BA",
    "FIPL":  "FIPL.BA",
    "HARG":  "HARG.BA",
    "HSAT":  "HSAT.BA",
    "INVJ":  "INVJ.BA",
    "IRSA":  "IRSA.BA",
    "LEDE":  "LEDE.BA",
    "MIRG":  "MIRG.BA",
    "MOLA":  "MOLA.BA",
    "MOLI":  "MOLI.BA",
    "MORI":  "MORI.BA",
    "OEST":  "OEST.BA",
    "PATA":  "PATA.BA",
    "SAMI":  "SAMI.BA",
    "SEMI":  "SEMI.BA",
    # ── D/C variants (price reference = base ARS ticker) ─────────────────────
    "AGROD": "AGRO.BA",
    "BMA.C": "BMA.BA",
    "BMA.D": "BMA.BA",
    "BYMAD": "BYMA.BA",
    "CEPUC": "CEPU.BA",
    "CEPUD": "CEPU.BA",
    "COMED": "COME.BA",
    "CRESD": "CRES.BA",
    "ECOGD": "ECOG.BA",
    "EDND":  "EDN.BA",
    "GGALD": "GGAL.BA",
    "LOMAD": "LOMA.BA",
    "METRD": "METR.BA",
    "PAMPD": "PAMP.BA",
    "SAMID": "SAMI.BA",
    "SUPVD": "SUPV.BA",
    "TECOC": "TECO2.BA",
    "TECOD": "TECO2.BA",
    "TGN4D": "TGNO4.BA",
    "TGSUD": "TGSU2.BA",
    "TRAND": "TRAN.BA",
    "TXARD": "TXAR.BA",
    "VALOC": "VALO.BA",
    "VALOD": "VALO.BA",
    "YPFDD": "YPFD.BA",
    # ── Legacy aliases ────────────────────────────────────────────────────────
    "YPF":   "YPFD.BA",
}

# ── Market groups (for the Mercado view) ──────────────────────────────────────
GRUPO_BYMA: list[str] = [
    "ALUA", "BBAR", "BMA", "BYMA", "CEPU", "COME", "CRES", "EDN",
    "GGAL", "LOMA", "METR", "PAMP", "SUPV", "TECO2", "TGNO4",
    "TGSU2", "TRAN", "TXAR", "VALO", "YPFD",
]

GRUPO_MERVAL: list[str] = [
    "A3", "AGRO", "AGROD", "AUSO", "BHIP", "BMA.C", "BMA.D", "BOLT",
    "BPAT", "BYMAD", "CADO", "CAPX", "CARC", "CECO2", "CELU", "CEPUC",
    "CEPUD", "CGPA2", "COMED", "CRESD", "CTIO", "DGCE", "DGCU2", "ECOG",
    "ECOGD", "EDND", "FERR", "FIPL", "GGALD", "HARG", "HSAT", "INVJ",
    "IRSA","LEDE", "LOMAD", "METRD", "MIRG", "MOLA", "MOLI",
    "MORI", "OEST", "PAMPD", "PATA", "SAMI", "SAMID", "SEMI", "SUPVD",
    "TECOC", "TECOD", "TGN4D", "TGSUD", "TRAND", "TXARD", "VALOC",
    "VALOD", "YPFDD",
]


def _fetch_yfinance_prices(symbols: list[str]) -> dict[str, float]:
    """
    Synchronous yfinance fetch — must be called via asyncio.to_thread().
    Returns {yf_symbol: price}. Silently skips failures.
    """
    import yfinance as yf

    result: dict[str, float] = {}
    if not symbols:
        return result

    try:
        tickers = yf.Tickers(" ".join(symbols))
        for sym in symbols:
            try:
                fi = tickers.tickers[sym].fast_info
                # FastInfo en yfinance 0.2.x es un objeto con atributos, no dict
                precio = (
                    getattr(fi, "last_price", None)
                    or getattr(fi, "regular_market_price", None)
                    or getattr(fi, "previous_close", None)
                )
                if precio and float(precio) > 0:
                    result[sym] = float(precio)
            except Exception:
                pass
    except Exception as e:
        print(f"[PriceFeed] yfinance batch error: {e}")

    return result


def get_ticker_map_from_db(db: Session) -> dict[str, str]:
    """Returns {especie: yf_symbol} for all active tickers that have a yf_symbol."""
    from app.models.especie_mercado import EspecieMercado
    rows = db.execute(
        select(EspecieMercado).where(
            EspecieMercado.activo == True,
            EspecieMercado.yf_symbol.isnot(None),
        )
    ).scalars().all()
    return {r.especie: r.yf_symbol for r in rows}


def get_grupo_from_db(db: Session, panel: str) -> list[str]:
    """Returns ordered list of active especie codes for the given panel."""
    from app.models.especie_mercado import EspecieMercado
    rows = db.execute(
        select(EspecieMercado).where(
            EspecieMercado.panel == panel,
            EspecieMercado.activo == True,
        ).order_by(EspecieMercado.especie)
    ).scalars().all()
    return [r.especie for r in rows]


async def fetch_and_update(db: Session) -> list[str]:
    """
    Fetches prices from yfinance for all mapped tickers that have positions,
    updates the DB, and returns the list of updated especies.
    Uses EspecieMercado DB table; falls back to hardcoded TICKER_MAP if empty.
    """
    # Only fetch prices for species that actually exist in positions
    from app.models.posicion import Posicion
    especies_en_db = [
        r[0] for r in db.execute(select(Posicion.especie).distinct()).all()
    ]

    # Prefer DB ticker map; fall back to hardcoded map
    db_map = get_ticker_map_from_db(db)
    active_map = db_map if db_map else TICKER_MAP

    # Build fetch list: only mapped tickers
    to_fetch: dict[str, str] = {
        esp: active_map[esp]
        for esp in especies_en_db
        if esp in active_map
    }

    if not to_fetch:
        return []

    yf_symbols = list(to_fetch.values())
    yf_prices = await asyncio.to_thread(_fetch_yfinance_prices, yf_symbols)

    actualizadas = []
    for especie, yf_sym in to_fetch.items():
        precio_nuevo = yf_prices.get(yf_sym)
        if precio_nuevo is None:
            continue
        _upsert(db, especie, precio_nuevo, fuente="yfinance")
        actualizadas.append(especie)

    if actualizadas:
        db.commit()

    return actualizadas


def upsert_manual(db: Session, especie: str, precio: float) -> PrecioMercado:
    """Operator-entered price for instruments without a yfinance ticker."""
    pm = _upsert(db, especie, precio, fuente="manual")
    db.commit()
    return pm


def _upsert(db: Session, especie: str, precio_nuevo: float, fuente: str) -> PrecioMercado:
    pm = db.execute(
        select(PrecioMercado).where(PrecioMercado.especie == especie)
    ).scalar_one_or_none()

    if pm is None:
        pm = PrecioMercado(
            especie=especie,
            precio=precio_nuevo,
            precio_anterior=None,
            variacion_pct=None,
            fuente=fuente,
            last_updated=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        db.add(pm)
    else:
        variacion = (
            (precio_nuevo - pm.precio) / pm.precio * 100
            if pm.precio and pm.precio > 0
            else None
        )
        pm.precio_anterior = pm.precio
        pm.precio = precio_nuevo
        pm.variacion_pct = round(variacion, 2) if variacion is not None else None
        pm.fuente = fuente
        pm.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)

    return pm


def get_precios_dict(db: Session) -> dict[str, PrecioMercado]:
    """Returns {especie: PrecioMercado} for all stored prices."""
    rows = db.execute(select(PrecioMercado)).scalars().all()
    return {pm.especie: pm for pm in rows}


def get_all(db: Session) -> list[PrecioMercado]:
    return db.execute(
        select(PrecioMercado).order_by(PrecioMercado.especie)
    ).scalars().all()


def snapshot_diario(db: Session, fecha: date | None = None) -> int:
    """
    Saves prices from PrecioMercado into PrecioHistorico as tipo CIERRE.
    Idempotent: skips species already snapshotted for that date.
    Returns number of new rows inserted.
    Feature 16: stamps precio_tipo='CIERRE'.
    """
    target = fecha or date.today()
    precios = db.execute(select(PrecioMercado)).scalars().all()
    count = 0
    for pm in precios:
        exists = db.execute(
            select(PrecioHistorico).where(
                PrecioHistorico.especie == pm.especie,
                PrecioHistorico.fecha == target,
                PrecioHistorico.precio_tipo == "CIERRE",
            )
        ).scalar_one_or_none()
        if not exists:
            db.add(PrecioHistorico(
                especie=pm.especie,
                fecha=target,
                precio=pm.precio,
                fuente=pm.fuente,
                precio_tipo="CIERRE",
            ))
            count += 1
    if count:
        db.commit()
    return count


def upsert_precio_ajuste(
    db: Session,
    especie: str,
    precio: float,
    fecha: date,
    precio_tipo: str,   # AJUSTE | CORTE_MAE | CIERRE
    fuente: str = "manual",
) -> PrecioHistorico:
    """
    Registers an official valuation price for a given (especie, fecha, precio_tipo).
    Idempotent: updates price if the row already exists.
    Feature 16.
    """
    existing = db.execute(
        select(PrecioHistorico).where(
            PrecioHistorico.especie == especie,
            PrecioHistorico.fecha == fecha,
            PrecioHistorico.precio_tipo == precio_tipo,
        )
    ).scalar_one_or_none()
    if existing:
        existing.precio = precio
        existing.fuente = fuente
        db.commit()
        db.refresh(existing)
        return existing
    row = PrecioHistorico(
        especie=especie,
        fecha=fecha,
        precio=precio,
        fuente=fuente,
        precio_tipo=precio_tipo,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def listar_precios_historico(
    db: Session,
    especie: str | None = None,
    fecha_desde: date | None = None,
    fecha_hasta: date | None = None,
    precio_tipo: str | None = None,
) -> list[PrecioHistorico]:
    """Query helper for historical prices with optional filters. Feature 16."""
    from sqlalchemy import select as _select
    stmt = _select(PrecioHistorico)
    if especie:
        stmt = stmt.where(PrecioHistorico.especie == especie.upper())
    if fecha_desde:
        stmt = stmt.where(PrecioHistorico.fecha >= fecha_desde)
    if fecha_hasta:
        stmt = stmt.where(PrecioHistorico.fecha <= fecha_hasta)
    if precio_tipo:
        stmt = stmt.where(PrecioHistorico.precio_tipo == precio_tipo.upper())
    return db.execute(
        stmt.order_by(PrecioHistorico.fecha.desc(), PrecioHistorico.especie)
    ).scalars().all()


def actualizar_volumen_vwap(
    db: Session,
    especie: str,
    cantidad: int,
    precio: float,
) -> None:
    """
    Increments the intraday volume counter and recalculates the VWAP for a
    species after a fill.  Resets both counters when the stored fecha_volumen
    is not today (day-roll).

    Must be called **once per trade** (not once per side) to avoid double-counting.
    The caller is responsible for the surrounding DB transaction/commit.
    """
    from datetime import date as _date
    pm = db.execute(
        select(PrecioMercado).where(PrecioMercado.especie == especie)
    ).scalar_one_or_none()
    if pm is None:
        return

    today = _date.today()
    if pm.fecha_volumen != today:
        pm.volumen_dia = 0
        pm.vwap = 0.0
        pm.fecha_volumen = today

    nuevo_vol = (pm.volumen_dia or 0) + cantidad
    if nuevo_vol > 0:
        pm.vwap = round(
            ((pm.volumen_dia or 0) * (pm.vwap or 0.0) + cantidad * precio) / nuevo_vol, 4
        )
    pm.volumen_dia = nuevo_vol


def calcular_pnl(
    cantidad_neta: int,
    costo_promedio_compra: float,
    precio_mercado: float,
) -> tuple[float, float]:
    """
    Returns (pnl_no_realizado, pnl_pct).
    pnl_pct is relative to the cost base (not market value).
    """
    if cantidad_neta == 0 or costo_promedio_compra <= 0:
        return 0.0, 0.0
    pnl = round((precio_mercado - costo_promedio_compra) * cantidad_neta, 2)
    pnl_pct = round((precio_mercado - costo_promedio_compra) / costo_promedio_compra * 100, 2)
    return pnl, pnl_pct
