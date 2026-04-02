"""
Daily P&L service.

run_cierre_dia(db, fecha) computes and stores PnlDiario rows for every
(cliente, especie) pair with activity on or before fecha.

P&L methodology:
  Realized  — FIFO matching of buys vs sells on the same calendar date.
              matched_qty × (avg_sell_price - avg_buy_price)
  Unrealized — position snapshot: qty_neta × (precio_cierre - costo_promedio_compra)
               Uses PrecioHistorico first, falls back to PrecioMercado.

Idempotent: calling run_cierre_dia twice for the same date overwrites the rows.
"""

from datetime import date

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.models.pnl_diario import PnlDiario
from app.models.ejecucion import Ejecucion
from app.models.orden import Orden
from app.models.posicion import Posicion
from app.models.precio_historico import PrecioHistorico
from app.models.precio_mercado import PrecioMercado
from app.models.bot_instancia import TIPOS_COMPRA as _TIPOS_COMPRA, TIPOS_VENTA as _TIPOS_VENTA


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_precio_cierre(db: Session, especie: str, fecha: date) -> float | None:
    """
    Return closing price for MTM.
    Priority: official AJUSTE > CORTE_MAE > CIERRE > PrecioMercado fallback.
    Feature 16: AJUSTE (BYMA/ROFEX) and CORTE_MAE (MAE RF) take precedence.
    """
    # Try official types first (AJUSTE, then CORTE_MAE)
    for tipo in ("AJUSTE", "CORTE_MAE", "CIERRE"):
        hist = db.execute(
            select(PrecioHistorico.precio)
            .where(
                PrecioHistorico.especie == especie,
                PrecioHistorico.fecha == fecha,
                PrecioHistorico.precio_tipo == tipo,
            )
        ).scalar_one_or_none()
        if hist is not None:
            return hist

    mkt = db.execute(
        select(PrecioMercado.precio)
        .where(PrecioMercado.especie == especie)
    ).scalar_one_or_none()
    return mkt


def _calcular_pnl_realizado_fifo(
    fills_compra: list[tuple[int, float]],   # [(qty, precio), ...]
    fills_venta: list[tuple[int, float]],
) -> float:
    """
    FIFO P&L: match buy fills against sell fills in chronological order.
    Returns the realized gain/loss for matched quantities.
    """
    if not fills_compra or not fills_venta:
        return 0.0

    buy_queue = list(fills_compra)    # [(qty_remaining, precio)]
    pnl = 0.0

    for sell_qty, sell_precio in fills_venta:
        remaining_sell = sell_qty
        while remaining_sell > 0 and buy_queue:
            buy_qty, buy_precio = buy_queue[0]
            matched = min(buy_qty, remaining_sell)
            pnl += matched * (sell_precio - buy_precio)
            remaining_sell -= matched
            if matched == buy_qty:
                buy_queue.pop(0)
            else:
                buy_queue[0] = (buy_qty - matched, buy_precio)

    return round(pnl, 2)


# ── Main ──────────────────────────────────────────────────────────────────────

def run_cierre_dia(db: Session, fecha: date) -> int:
    """
    Compute and persist PnlDiario rows for all active (cliente, especie) pairs.
    Returns number of rows written.

    Steps per (cliente, especie, moneda):
      1. Fetch all fills on `fecha` — compute realized P&L via FIFO.
      2. Fetch position snapshot — compute unrealized P&L using closing price.
      3. Upsert PnlDiario row.
    """
    # 1. Find all (cliente, especie, moneda) pairs with fills on this date
    rows = db.execute(
        select(
            Orden.cliente,
            Orden.especie,
            Orden.moneda,
            Orden.tipo_orden,
            Orden.desk,
            Ejecucion.cantidad,
            Ejecucion.precio,
            Ejecucion.created_at,
        )
        .join(Orden, Ejecucion.orden_id == Orden.id)
        .where(Ejecucion.fecha == fecha)
        .order_by(Orden.cliente, Orden.especie, Ejecucion.created_at)
    ).all()

    # Group fills by (cliente, especie, moneda)
    grupos: dict[tuple, dict] = {}
    for cliente, especie, moneda, tipo_orden, desk, cantidad, precio, _ in rows:
        key = (cliente, especie, moneda)
        if key not in grupos:
            grupos[key] = {"compras": [], "ventas": [], "vol_compra": 0.0, "vol_venta": 0.0, "desk": desk}
        # Keep the first non-null desk seen for this group
        if not grupos[key]["desk"] and desk:
            grupos[key]["desk"] = desk
        t = tipo_orden.upper()
        if t in _TIPOS_COMPRA:
            grupos[key]["compras"].append((cantidad, precio))
            grupos[key]["vol_compra"] += cantidad * precio
        elif t in _TIPOS_VENTA:
            grupos[key]["ventas"].append((cantidad, precio))
            grupos[key]["vol_venta"] += cantidad * precio

    # 2. Process each group
    written = 0
    for (cliente, especie, moneda), g in grupos.items():
        # Realized P&L (FIFO intraday)
        pnl_realizado = _calcular_pnl_realizado_fifo(g["compras"], g["ventas"])

        # Closing price for MTM
        precio_cierre = _get_precio_cierre(db, especie, fecha)

        # Current position snapshot
        posicion = db.execute(
            select(Posicion).where(
                Posicion.cliente == cliente,
                Posicion.especie == especie,
                Posicion.moneda  == moneda,
            )
        ).scalar_one_or_none()

        pnl_no_realizado = 0.0
        costo_promedio = None
        if posicion and precio_cierre and posicion.cantidad_neta != 0:
            if posicion.cantidad_neta > 0 and posicion.costo_promedio_compra:
                pnl_no_realizado = round(
                    posicion.cantidad_neta * (precio_cierre - posicion.costo_promedio_compra), 2
                )
                costo_promedio = posicion.costo_promedio_compra
            elif posicion.cantidad_neta < 0 and posicion.costo_promedio_venta:
                # Short position: profit when price falls below average sell price
                pnl_no_realizado = round(
                    posicion.cantidad_neta * (precio_cierre - posicion.costo_promedio_venta), 2
                )
                costo_promedio = posicion.costo_promedio_venta

        # First fill price of the day as "apertura"
        precio_apertura = g["compras"][0][1] if g["compras"] else (g["ventas"][0][1] if g["ventas"] else None)

        # Upsert
        existing = db.execute(
            select(PnlDiario).where(
                PnlDiario.fecha    == fecha,
                PnlDiario.cliente  == cliente,
                PnlDiario.especie  == especie,
                PnlDiario.moneda   == moneda,
            )
        ).scalar_one_or_none()

        if existing:
            row = existing
        else:
            row = PnlDiario(fecha=fecha, cliente=cliente, especie=especie, moneda=moneda)
            db.add(row)

        row.pnl_realizado    = pnl_realizado
        row.pnl_no_realizado = pnl_no_realizado
        row.pnl_total        = round(pnl_realizado + pnl_no_realizado, 2)
        row.volumen_comprado = round(g["vol_compra"], 2)
        row.volumen_vendido  = round(g["vol_venta"], 2)
        row.precio_apertura  = precio_apertura
        row.precio_cierre    = precio_cierre
        row.costo_promedio   = costo_promedio
        row.desk             = g.get("desk")
        written += 1

    return written


# ── Query helpers ─────────────────────────────────────────────────────────────

def listar_pnl(
    db: Session,
    fecha_desde: date | None = None,
    fecha_hasta: date | None = None,
    cliente: str | None = None,
    especie: str | None = None,
) -> list[PnlDiario]:
    stmt = select(PnlDiario)
    if fecha_desde:
        stmt = stmt.where(PnlDiario.fecha >= fecha_desde)
    if fecha_hasta:
        stmt = stmt.where(PnlDiario.fecha <= fecha_hasta)
    if cliente and cliente != "Todos":
        stmt = stmt.where(PnlDiario.cliente == cliente)
    if especie and especie != "Todos":
        stmt = stmt.where(PnlDiario.especie == especie)
    return db.execute(
        stmt.order_by(PnlDiario.fecha.desc(), PnlDiario.cliente, PnlDiario.especie)
    ).scalars().all()


def listar_pnl_por_desk(db: Session, fecha: date) -> list[dict]:
    """
    Aggregated P&L grouped by desk for a given date.
    Feature 15: cost-center P&L breakdown.
    """
    rows = db.execute(
        select(
            PnlDiario.desk,
            func.sum(PnlDiario.pnl_realizado).label("pnl_realizado"),
            func.sum(PnlDiario.pnl_no_realizado).label("pnl_no_realizado"),
            func.sum(PnlDiario.pnl_total).label("pnl_total"),
            func.sum(PnlDiario.volumen_comprado).label("vol_compra"),
            func.sum(PnlDiario.volumen_vendido).label("vol_venta"),
            func.count(PnlDiario.id).label("n_posiciones"),
        )
        .where(PnlDiario.fecha == fecha)
        .group_by(PnlDiario.desk)
        .order_by(PnlDiario.desk)
    ).all()
    return [
        {
            "desk":            r.desk or "Sin Desk",
            "pnl_realizado":   round(r.pnl_realizado or 0, 2),
            "pnl_no_realizado": round(r.pnl_no_realizado or 0, 2),
            "pnl_total":       round(r.pnl_total or 0, 2),
            "volumen_comprado": round(r.vol_compra or 0, 2),
            "volumen_vendido":  round(r.vol_venta or 0, 2),
            "n_posiciones":    r.n_posiciones or 0,
        }
        for r in rows
    ]


def get_resumen_pnl(db: Session, fecha: date) -> dict:
    """Aggregated totals for a given date across all clients."""
    rows = db.execute(
        select(
            func.sum(PnlDiario.pnl_realizado).label("total_realizado"),
            func.sum(PnlDiario.pnl_no_realizado).label("total_no_realizado"),
            func.sum(PnlDiario.pnl_total).label("total"),
            func.sum(PnlDiario.volumen_comprado).label("vol_compra"),
            func.sum(PnlDiario.volumen_vendido).label("vol_venta"),
            func.count(PnlDiario.id).label("n_posiciones"),
        ).where(PnlDiario.fecha == fecha)
    ).one()

    return {
        "fecha":              fecha.isoformat(),
        "pnl_realizado":      round(rows.total_realizado or 0, 2),
        "pnl_no_realizado":   round(rows.total_no_realizado or 0, 2),
        "pnl_total":          round(rows.total or 0, 2),
        "volumen_comprado":   round(rows.vol_compra or 0, 2),
        "volumen_vendido":    round(rows.vol_venta or 0, 2),
        "posiciones_procesadas": rows.n_posiciones or 0,
    }
