"""
Bot behavior profiles — CONSERVADOR / MODERADO / AGRESIVO / TRADER.

Each profile defines default ranges for variance, interval, price offsets,
fill_rate, burst behavior, quantity distribution spread, stale-order tolerance,
capital allocation, accumulation/distribution cycle length, and fill-reaction
parameters.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class PerfilConfig:
    # Price movement variance range [min, max] as a fraction per tick
    variance_min: float
    variance_max: float
    # Time between ticks range [min, max] in seconds
    interval_min: float
    interval_max: float
    # Bid offset range (negative = below market price)
    offset_compra_min: float
    offset_compra_max: float
    # Ask offset range (positive = above market price)
    offset_venta_min: float
    offset_venta_max: float
    # Fraction [0,1]: probability that a given bot order gets a simulated fill
    fill_rate: float
    # Probability of a burst (multiple simultaneous orders) per order-injection tick
    burst_prob: float
    # Max extra orders injected during a burst
    burst_size: int
    # Gaussian sigma as fraction of the mean quantity (spread)
    qty_sigma_pct: float
    # Weight multiplier for high-momentum tickers vs flat ones (≥ 1.0)
    ticker_momentum_weight: float

    # ── Human-like behavior fields ────────────────────────────────────────────
    # Max deviation from current market price before a pending order is cancelled
    # as "stale" (e.g. 0.025 = cancel if price drifted more than 2.5 % away)
    stale_offset_pct: float
    # Max fraction of available balance to allocate per order (capital sizing)
    # (e.g. 0.05 = risk at most 5 % of available cash on a single order)
    capital_fraccion_max: float
    # Accumulation/Distribution cycle: number of ticks spent in each phase
    ciclo_min_ticks: int
    ciclo_max_ticks: int
    # Probability [0,1] of injecting a counter-order after one of the bot's
    # orders is fully executed (simulates a human "recycling" the position)
    fill_react_prob: float
    # Price markup/markdown applied to counter-orders relative to fill price
    # (e.g. 0.005 = place the reverse leg 0.5 % away from the execution price)
    fill_react_markup: float
    # Probability [0,1] that a given order is sent as MERCADO instead of LIMITE.
    # Doubles automatically when |momentum| > 1 % (operator chasing the price).
    prob_orden_mercado: float


PERFILES: dict[str, PerfilConfig] = {
    "CONSERVADOR": PerfilConfig(
        variance_min=0.002,
        variance_max=0.005,
        interval_min=10.0,
        interval_max=20.0,
        offset_compra_min=-0.020,
        offset_compra_max=-0.008,
        offset_venta_min=0.008,
        offset_venta_max=0.020,
        fill_rate=0.25,
        burst_prob=0.05,
        burst_size=1,
        qty_sigma_pct=0.10,
        ticker_momentum_weight=1.2,
        # Human-like
        stale_offset_pct=0.030,       # cancel if >3 % away from market
        capital_fraccion_max=0.03,    # max 3 % of balance per order
        ciclo_min_ticks=20,           # slow, long accumulation phases
        ciclo_max_ticks=60,
        fill_react_prob=0.30,         # only reacts to 30 % of fills
        fill_react_markup=0.010,      # 1.0 % spread on counter-order
        prob_orden_mercado=0.03,      # 3 % market orders — controls price, rarely chases
    ),
    "MODERADO": PerfilConfig(
        variance_min=0.005,
        variance_max=0.012,
        interval_min=5.0,
        interval_max=10.0,
        offset_compra_min=-0.012,
        offset_compra_max=-0.003,
        offset_venta_min=0.003,
        offset_venta_max=0.012,
        fill_rate=0.45,
        burst_prob=0.15,
        burst_size=2,
        qty_sigma_pct=0.20,
        ticker_momentum_weight=1.8,
        # Human-like
        stale_offset_pct=0.020,       # cancel if >2 % away
        capital_fraccion_max=0.05,    # max 5 % per order
        ciclo_min_ticks=12,
        ciclo_max_ticks=40,
        fill_react_prob=0.50,
        fill_react_markup=0.006,
        prob_orden_mercado=0.08,      # 8 % market orders — occasional urgency
    ),
    "AGRESIVO": PerfilConfig(
        variance_min=0.010,
        variance_max=0.025,
        interval_min=2.0,
        interval_max=6.0,
        offset_compra_min=-0.006,
        offset_compra_max=-0.001,
        offset_venta_min=0.001,
        offset_venta_max=0.006,
        fill_rate=0.70,
        burst_prob=0.30,
        burst_size=3,
        qty_sigma_pct=0.35,
        ticker_momentum_weight=2.5,
        # Human-like
        stale_offset_pct=0.015,       # cancel if >1.5 % away (tighter)
        capital_fraccion_max=0.08,    # up to 8 % per order
        ciclo_min_ticks=8,
        ciclo_max_ticks=25,
        fill_react_prob=0.70,
        fill_react_markup=0.003,
        prob_orden_mercado=0.20,      # 20 % market orders — doesn't want price to escape
    ),
    # Scalper: very high frequency, tiny offsets, chases momentum.
    "TRADER": PerfilConfig(
        variance_min=0.001,
        variance_max=0.002,
        interval_min=1.0,
        interval_max=2.5,
        offset_compra_min=-0.004,
        offset_compra_max=-0.001,
        offset_venta_min=0.001,
        offset_venta_max=0.004,
        fill_rate=0.85,
        burst_prob=0.40,
        burst_size=2,
        qty_sigma_pct=0.15,
        ticker_momentum_weight=3.5,
        # Human-like
        stale_offset_pct=0.010,       # cancel if >1 % away (very tight)
        capital_fraccion_max=0.10,    # up to 10 % per order (scalper sizing)
        ciclo_min_ticks=4,
        ciclo_max_ticks=15,
        fill_react_prob=0.85,         # almost always reacts to fills
        fill_react_markup=0.002,      # tiny spread — scalper style
        prob_orden_mercado=0.35,      # 35 % market orders — scalper executes on momentum
    ),
}

PERFIL_NOMBRES = list(PERFILES.keys())


def get_perfil(nombre: str) -> PerfilConfig:
    """Return profile by name (case-insensitive). Falls back to MODERADO."""
    return PERFILES.get((nombre or "MODERADO").upper(), PERFILES["MODERADO"])
