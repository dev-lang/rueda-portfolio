"""
Portfolio risk metrics service.

Computes:
  - Duration ponderada y DV01 (renta fija)
  - VaR paramétrico 95% 1 día (all positions)
  - Sensibilidad FX 1% (USD-denominated positions)

All calculations are read-only — no DB writes.
"""

import math
from statistics import stdev

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.instrumento import Instrumento
from app.models.posicion import Posicion
from app.models.precio_mercado import PrecioMercado
from app.models.precio_historico import PrecioHistorico
from app.models.tipo_cambio import TipoCambioHistorico


_Z_95 = 1.6449  # z-score for 95% one-tailed confidence


def _get_precio_actual(db: Session, especie: str) -> float | None:
    pm = db.execute(
        select(PrecioMercado).where(PrecioMercado.especie == especie)
    ).scalar_one_or_none()
    return pm.precio if pm and pm.precio > 0 else None


def _get_historicos(db: Session, especie: str, limit: int = 252) -> list[float]:
    rows = db.execute(
        select(PrecioHistorico.precio)
        .where(PrecioHistorico.especie == especie)
        .order_by(PrecioHistorico.fecha.desc())
        .limit(limit)
    ).scalars().all()
    return list(reversed(rows))  # oldest first


def _daily_returns(precios: list[float]) -> list[float]:
    if len(precios) < 2:
        return []
    return [(precios[i] / precios[i - 1]) - 1 for i in range(1, len(precios))]


def _get_tc_usd(db: Session) -> float:
    """Last known USD/ARS official sell rate."""
    row = db.execute(
        select(TipoCambioHistorico)
        .where(TipoCambioHistorico.tipo == "OFICIAL")
        .order_by(TipoCambioHistorico.fecha.desc())
        .limit(1)
    ).scalar_one_or_none()
    if row and row.valor_venta and row.valor_venta > 0:
        return float(row.valor_venta)
    return 1.0  # fallback: 1:1 (won't affect ARP positions)


def calcular_metricas_cartera(
    db: Session,
    cliente_codigo: str,
    moneda_base: str = "ARP",
) -> dict:
    """
    Returns portfolio risk metrics for a given client.
    All monetary values are expressed in moneda_base (default ARP).
    """
    tc_usd = _get_tc_usd(db)

    # Load all active long positions
    posiciones = db.execute(
        select(Posicion).where(
            Posicion.cliente == cliente_codigo,
            Posicion.cantidad_neta > 0,
        )
    ).scalars().all()

    # Pre-load instruments (for duration / tipo)
    instrumentos: dict[str, Instrumento] = {}
    especie_set = {p.especie for p in posiciones}
    if especie_set:
        rows = db.execute(
            select(Instrumento)
            .options(selectinload(Instrumento.renta_fija))
            .where(Instrumento.especie.in_(especie_set))
        ).scalars().all()
        instrumentos = {i.especie: i for i in rows}

    duration_weighted_sum = 0.0
    dv01_total = 0.0
    valor_total_arp = 0.0
    var_items: list[float] = []
    fx_delta = 0.0

    posicion_details: list[dict] = []

    for pos in posiciones:
        precio = _get_precio_actual(db, pos.especie)
        if precio is None or precio <= 0:
            continue

        # Convert position value to moneda_base (ARP)
        moneda_pos = (pos.moneda or "ARP").upper()
        fx_factor = tc_usd if moneda_pos == "USD" else 1.0
        valor_arp = pos.cantidad_neta * precio * fx_factor
        valor_total_arp += valor_arp

        inst = instrumentos.get(pos.especie)

        # ── Duration / DV01 (renta fija only) ─────────────────────────────
        duration = None
        dv01 = 0.0
        if inst and inst.tipo == "RENTA_FIJA" and inst.renta_fija:
            rf = inst.renta_fija
            dur = rf.duration
            if dur and dur > 0:
                precio_ref = rf.precio_sucio or precio
                dv01 = (dur / 10_000) * precio_ref * pos.cantidad_neta * fx_factor
                duration_weighted_sum += dur * valor_arp
                dv01_total += dv01
                duration = dur

        # ── VaR paramétrico ───────────────────────────────────────────────
        historicos = _get_historicos(db, pos.especie)
        returns = _daily_returns(historicos)

        if len(returns) >= 10:
            sigma = stdev(returns)
            dias_hist = len(returns)
        else:
            # Fallback: use current variacion_pct as proxy for 1-day sigma
            pm = db.execute(
                select(PrecioMercado).where(PrecioMercado.especie == pos.especie)
            ).scalar_one_or_none()
            var_pct = abs(pm.variacion_pct or 1.0) / 100 if pm else 0.01
            sigma = var_pct
            dias_hist = 0

        var_pos = valor_arp * sigma * _Z_95
        var_items.append(var_pos)

        # ── FX sensitivity (USD positions) ────────────────────────────────
        if moneda_pos == "USD":
            # How much does the ARP value change if USD/ARS rate moves 1%?
            fx_delta += valor_arp * 0.01

        posicion_details.append({
            "especie": pos.especie,
            "cantidad_neta": pos.cantidad_neta,
            "precio_mercado": precio,
            "valor_arp": round(valor_arp, 2),
            "duration": duration,
            "dv01": round(dv01, 2) if dv01 else None,
            "var_95_1d": round(var_pos, 2),
            "sigma": round(sigma * 100, 4),
            "dias_historicos": dias_hist,
        })

    # Portfolio duration (value-weighted)
    duration_ponderada = (duration_weighted_sum / valor_total_arp) if valor_total_arp > 0 else 0

    # Portfolio VaR — assume independence (conservative lower bound is sum, normal is sqrt-of-sum-squares)
    var_portfolio = math.sqrt(sum(v ** 2 for v in var_items)) if var_items else 0.0

    return {
        "cliente": cliente_codigo,
        "moneda_base": moneda_base,
        "valor_portfolio_arp": round(valor_total_arp, 2),
        "duration_ponderada": round(duration_ponderada, 4),
        "dv01_total": round(dv01_total, 2),
        "var_95_1d": round(var_portfolio, 2),
        "var_95_1d_pct": round((var_portfolio / valor_total_arp * 100) if valor_total_arp > 0 else 0, 4),
        "sensibilidad_fx_1pct": round(fx_delta, 2),
        "tc_usd_usado": round(tc_usd, 2),
        "posiciones": posicion_details,
    }
