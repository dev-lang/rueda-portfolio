"""
Pure strategy functions for bot order generation.

Uses gaussian and triangular distributions for realistic quantity and
price-offset simulation. All functions are stateless and take a
PerfilConfig as their primary parameter.
"""

import random
from app.models.bot_instancia import TIPOS_COMPRA, TIPOS_VENTA
from app.simulador.perfiles import PerfilConfig


def calcular_cantidad(
    precio: float,
    perfil: PerfilConfig,
    balance_disponible: float | None = None,
) -> int:
    """
    Gaussian quantity distribution around a tier-based mean.

    If balance_disponible is provided, the result is capped so the notional
    cost (precio × cantidad) does not exceed capital_fraccion_max of the
    available balance — this prevents bots from placing unrealistically large
    orders relative to their capital.

    Larger sigma (qty_sigma_pct) → more spread = more aggressive profile.
    """
    if precio >= 10_000:
        base = random.choice([10, 20, 50, 100])
    elif precio >= 1_000:
        base = random.choice([100, 200, 500, 1_000])
    elif precio >= 100:
        base = random.choice([500, 1_000, 2_000, 5_000])
    else:
        base = random.choice([1_000, 5_000, 10_000, 20_000])

    sigma = max(1.0, base * perfil.qty_sigma_pct)
    cantidad = max(1, int(random.gauss(base, sigma)))

    # Capital-based cap: never commit more than capital_fraccion_max of balance
    if balance_disponible is not None and balance_disponible > 0 and precio > 0:
        presupuesto = balance_disponible * perfil.capital_fraccion_max
        cantidad_max = max(1, int(presupuesto / precio))
        cantidad = min(cantidad, cantidad_max)

    return cantidad


def calcular_offset_precio(
    es_compra: bool,
    perfil: PerfilConfig,
    momentum: float = 0.0,
) -> float:
    """
    Triangular distribution offset with momentum adjustment.

    For buys (es_compra=True): negative offset (bid below market).
        Falling price → mode shifts toward high (more aggressive, closer to market).
    For sells (es_compra=False): positive offset (ask above market).
        Rising price → mode shifts toward low (more aggressive, closer to market).

    momentum: variacion_pct / 100  (e.g. +0.015 means +1.5 % recent move)
    """
    if es_compra:
        low  = perfil.offset_compra_min
        high = perfil.offset_compra_max
        # Default: bid conservatively (mode near the low end = furthest from market)
        mode = low + (high - low) * 0.3
        if momentum < 0:
            # Falling price → buyer chases the market, tightens the bid
            mode = low + (high - low) * 0.7
    else:
        low  = perfil.offset_venta_min
        high = perfil.offset_venta_max
        # Default: ask conservatively (mode near high end = furthest from market)
        mode = low + (high - low) * 0.7
        if momentum > 0:
            # Rising price → seller chases the market, tightens the ask
            mode = low + (high - low) * 0.3

    return random.triangular(low, high, mode)


def decidir_burst(perfil: PerfilConfig) -> int:
    """
    Returns how many extra orders to inject in this tick (0 = no burst).
    """
    if random.random() < perfil.burst_prob:
        return random.randint(1, perfil.burst_size)
    return 0


def seleccionar_tickers(
    candidatas: list,
    variaciones_map: dict[str, float],
    perfil: PerfilConfig,
    n: int,
) -> list:
    """
    Momentum-weighted ticker selection without replacement.
    Tickers with higher absolute price variation get a proportionally higher
    selection weight, scaled by ticker_momentum_weight.
    """
    if not candidatas or n <= 0:
        return []

    n = min(n, len(candidatas))
    pool = []
    for em in candidatas:
        variacion = abs(variaciones_map.get(em.especie, 0.0))
        # Weight: base 1.0, boosted up to ticker_momentum_weight at |variacion| ≥ 3 %
        weight = 1.0 + (perfil.ticker_momentum_weight - 1.0) * min(variacion / 3.0, 1.0)
        pool.append([em, weight])

    selected = []
    for _ in range(n):
        if not pool:
            break
        total = sum(w for _, w in pool)
        r = random.uniform(0, total)
        cumulative = 0.0
        for i, (em, w) in enumerate(pool):
            cumulative += w
            if r <= cumulative:
                selected.append(em)
                pool.pop(i)
                break

    return selected


def elegir_tipo_sesgado(
    tipos: list[str],
    posicion_neta: int,
    modo: str,
    sesgo_macro: float = 0.0,
) -> str:
    """
    Weighted buy/sell decision combining three independent signals:

    1. Accumulation/Distribution cycle (modo):
       - ACUMULACION  → 70 % buy  / 30 % sell
       - NEUTRO       → 50 % buy  / 50 % sell
       - DISTRIBUCION → 30 % buy  / 70 % sell

    2. Own-position bias (posicion_neta):
       - Large long position  (> 5 000 units) → shift −20 pp toward selling
       - Large short position (< −5 000 units) → shift +20 pp toward buying

    3. Market-wide macro sesgo (-1.0 … +1.0):
       - +1.0 (full bullish) → shift +15 pp toward buying
       - -1.0 (full bearish) → shift −15 pp toward selling
       Set via ConfigSistema.mercado_sesgo from the admin panel.

    The combined weight is clamped to [0.10, 0.90] so neither side is
    completely excluded. Falls back gracefully if only one side is
    available in tipos.
    """
    tipos_compra = [t for t in tipos if t in TIPOS_COMPRA]
    tipos_venta  = [t for t in tipos if t in TIPOS_VENTA]

    if not tipos_compra:
        return random.choice(tipos_venta)
    if not tipos_venta:
        return random.choice(tipos_compra)

    # Signal 1: base weight from cycle phase
    if modo == "ACUMULACION":
        peso_compra = 0.70
    elif modo == "DISTRIBUCION":
        peso_compra = 0.30
    else:  # NEUTRO
        peso_compra = 0.50

    # Signal 2: own-inventory pressure
    if posicion_neta > 5_000:
        peso_compra -= 0.20   # sitting long → lean toward selling
    elif posicion_neta < -5_000:
        peso_compra += 0.20   # sitting short → lean toward buying

    # Signal 3: market-wide macro sentiment (±15 pp max)
    peso_compra += sesgo_macro * 0.15

    peso_compra = max(0.10, min(0.90, peso_compra))

    if random.random() < peso_compra:
        return random.choice(tipos_compra)
    return random.choice(tipos_venta)
