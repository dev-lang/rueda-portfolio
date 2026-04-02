"""
Market volume bot — multi-instance background asyncio runner.

Reads all BotInstancia rows from the DB on every master tick (1 s).
Each enabled bot runs at its own interval, applying the full set of
human-like behaviours described below.

═══════════════════════════════════════════════════════════════════════
  Human-like behaviour layers (all 8 active simultaneously)
═══════════════════════════════════════════════════════════════════════

  1. Market hours — only injects orders Mon–Fri 10:00–17:00 Buenos Aires
     (UTC-3, Argentina has no DST).  Outside those hours the bot still
     performs housekeeping (stale cancellation, fill reaction) but does
     NOT move prices or open new orders.

  2. Accumulation / Distribution cycles — each bot cycles through
     ACUMULACION → NEUTRO → DISTRIBUCION phases of random length
     (driven by ciclo_min_ticks / ciclo_max_ticks from its profile).
     The active phase biases the buy/sell probability for every order.

  3. Stale-order cancellation — pending orders whose limit price has
     drifted more than stale_offset_pct from the current market price
     are cancelled before new orders are injected.

  4. Own-position bias — the bot reads its own net position for each
     species and adjusts buy/sell probability accordingly: sitting long
     → leans toward selling, sitting flat/short → leans toward buying.

  5. Spread awareness — before setting a limit price the bot reads the
     best bid and ask from all other pending orders in the book and
     anchors to the spread midpoint (rather than last traded price).
     If the book is one-sided it uses the available side; if empty it
     falls back to the last market price.

  6. Fill reaction — when one of the bot's orders is fully executed,
     with probability fill_react_prob the bot places the opposite leg
     at fill_react_markup away from the execution price, simulating a
     human who "recycles" inventory after a fill.  Reaction chains are
     capped at _MAX_REACT_DEPTH levels to prevent infinite ping-pong.

  7. Capital-based order sizing — order quantity is capped so the
     notional cost does not exceed capital_fraccion_max of the bot's
     available balance.  This prevents unrealistically large orders
     when the bot has limited funds.

  8. EMA momentum — price momentum is tracked as an exponential moving
     average (alpha=0.3) of per-tick variacion_pct, giving the offset
     calculation a persistent directional memory instead of reacting
     only to the latest single tick.

Additional improvements over the original design:
  • Backpressure — when pending orders exceed 75 % of max_ordenes the
    bot halves its burst probability and skips the injection tick with
    40 % probability, reducing order-book congestion.
  • Market-wide macro sesgo — ConfigSistema.mercado_sesgo (-1…+1) is
    read once per master loop and applied as an extra ±15 pp bias on
    every bot's buy/sell weight.
  • Structured logging — every order decision is emitted at DEBUG level
    with especie, ciclo, momentum, tipo, offset, precio, and qty so
    bot behaviour can be audited without a DB schema change.

Bot configuration is fully managed via /api/admin/bots (ADMIN only) and
persisted in the bot_instancias table — no server restart required.
"""

import asyncio
import logging
import random
import time
from dataclasses import replace as _dc_replace
from datetime import date, datetime, timezone, timedelta

from sqlalchemy import select, func

from app.db.session import SessionLocal
from app.models.bot_instancia import BotInstancia, TIPOS_COMPRA, TIPOS_VENTA
from app.models.config_sistema import ConfigSistema
from app.models.especie_mercado import EspecieMercado
from app.models.precio_mercado import PrecioMercado
from app.models.orden import Orden
from app.models.posicion import Posicion
from app.core.socketio import sio
from app.services import account_service
from app.simulador.perfiles import get_perfil, PerfilConfig
from app.simulador.estrategias import (
    calcular_cantidad,
    calcular_offset_precio,
    decidir_burst,
    seleccionar_tickers,
    elegir_tipo_sesgado,
)

_logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

_BOT_RAZON = "Bot Simulador de Mercado"

# Buenos Aires is UTC-3 year-round (no DST in Argentina).
_BA_TZ = timezone(timedelta(hours=-3))

# Accumulation / Distribution cycle phases
_CICLOS = ["ACUMULACION", "NEUTRO", "DISTRIBUCION"]

# Per-bot last-run timestamps       {bot_id: float}
_last_run: dict[int, float] = {}

# Per-bot order-tick counter        {bot_id: int}
_tick_ctr: dict[int, int] = {}
_TICKS_PER_ORDER = 3   # inject orders every N price-ticks per bot

# Per-bot cycle state               {bot_id: str}  and  {bot_id: int}
_bot_modo: dict[int, str] = {}
_bot_modo_ticks: dict[int, int] = {}

# Order IDs already reacted to (fill reaction, to avoid duplicate counter-orders)
_reacted_fills: set[int] = set()

# ── Mejora 8: EMA momentum tracking ──────────────────────────────────────────
# Exponential moving average of variacion_pct per especie.
# alpha=0.3 → effective memory ≈ 3 ticks; higher = more reactive.
_precio_ema: dict[str, float] = {}
_EMA_ALPHA = 0.3

# ── Mejora 3: fill-reaction cascade depth ────────────────────────────────────
# Maps order_id → reaction depth.  0 = original order, 1 = first reaction,
# 2 = reaction-of-reaction.  Orders at depth >= _MAX_REACT_DEPTH are never
# reacted to, preventing infinite ping-pong chains.
_react_depth: dict[int, int] = {}
_MAX_REACT_DEPTH = 2
# Trim the depth dict when it grows beyond this size to prevent unbounded growth.
_REACT_DEPTH_MAX_SIZE = 5_000


# ── Profile resolver ──────────────────────────────────────────────────────────

def _resolver_perfil(bot: BotInstancia, perfil: PerfilConfig) -> PerfilConfig:
    """
    Return a PerfilConfig with any per-bot overrides applied.

    Each nullable column on BotInstancia can shadow the corresponding field in
    its PerfilConfig.  NULL (None) means "inherit from profile".  This lets
    admins tune individual bots without creating entirely new profiles.

    Uses dataclasses.replace() so the result is still a valid frozen PerfilConfig.
    """
    overrides = {}
    if bot.stale_offset_pct is not None:
        overrides["stale_offset_pct"] = bot.stale_offset_pct
    if bot.capital_fraccion_max is not None:
        overrides["capital_fraccion_max"] = bot.capital_fraccion_max
    if bot.ciclo_min_ticks is not None:
        overrides["ciclo_min_ticks"] = bot.ciclo_min_ticks
    if bot.ciclo_max_ticks is not None:
        overrides["ciclo_max_ticks"] = bot.ciclo_max_ticks
    if bot.fill_react_prob is not None:
        overrides["fill_react_prob"] = bot.fill_react_prob
    if bot.fill_react_markup is not None:
        overrides["fill_react_markup"] = bot.fill_react_markup
    return _dc_replace(perfil, **overrides) if overrides else perfil


# ── Price helpers ──────────────────────────────────────────────────────────────

def _round_to_tick(price: float) -> float:
    if price >= 50_000:   tick = 500.0
    elif price >= 10_000: tick = 100.0
    elif price >= 1_000:  tick = 5.0
    elif price >= 100:    tick = 1.0
    elif price >= 10:     tick = 0.5
    else:                 tick = 0.1
    return round(round(price / tick) * tick, 2)


# ── Behaviour helpers ──────────────────────────────────────────────────────────

def _es_horario_mercado() -> bool:
    """True if the current Buenos Aires time is within market hours."""
    ahora = datetime.now(_BA_TZ)
    if ahora.weekday() >= 5:   # Saturday = 5, Sunday = 6
        return False
    return 10 <= ahora.hour < 17


def _actualizar_ciclo(bot_id: int, perfil: PerfilConfig) -> str:
    """
    Decrement the remaining-ticks counter for the bot's current phase.
    When it reaches zero, pick a new random phase and reset the counter.
    Returns the current phase name.
    """
    ticks = _bot_modo_ticks.get(bot_id, 0) - 1
    if ticks <= 0:
        modo = random.choice(_CICLOS)
        _bot_modo[bot_id] = modo
        _bot_modo_ticks[bot_id] = random.randint(perfil.ciclo_min_ticks, perfil.ciclo_max_ticks)
    else:
        _bot_modo_ticks[bot_id] = ticks
    return _bot_modo.get(bot_id, "NEUTRO")


def _cancelar_stale(
    db,
    razon_bot: str,
    precios_map: dict[str, float],
    perfil: PerfilConfig,
    cliente_bot: str,
) -> int:
    """
    Cancel this bot's pending orders whose limit price has drifted more
    than stale_offset_pct away from the current market price.
    Returns the number of orders cancelled (caller must commit).
    """
    pendientes = db.execute(
        select(Orden).where(
            Orden.cliente == cliente_bot,
            Orden.razon_social == razon_bot,
            Orden.instancia.notin_(["Ejecutada", "Cancelada"]),
        )
    ).scalars().all()

    canceladas = 0
    for orden in pendientes:
        precio_actual = precios_map.get(orden.especie)
        if precio_actual is None or not orden.precio_limite:
            continue
        desviacion = abs(orden.precio_limite - precio_actual) / precio_actual
        if desviacion > perfil.stale_offset_pct:
            orden.instancia = "Cancelada"
            orden.instancia_codigo = 9
            orden.estado_color = "red"
            canceladas += 1
    return canceladas


def _get_posicion_neta(db, especie: str, cliente_bot: str) -> int:
    """Return this bot instance's net position (cantidad_neta) for a species, or 0."""
    pos = db.execute(
        select(Posicion).where(
            Posicion.cliente == cliente_bot,
            Posicion.especie == especie,
        )
    ).scalar_one_or_none()
    return pos.cantidad_neta if pos else 0


def _get_pendientes_venta_qty(db, especie: str, razon_bot: str) -> int:
    """Sum of remaining quantity on pending sell orders for this bot and species.

    Used to prevent placing new sell orders that would exceed the bot's actual
    inventory (posicion_neta minus already-committed pending sells).
    """
    qty = db.execute(
        select(func.sum(Orden.cantidad_total - Orden.cantidad_ejecutada)).where(
            Orden.razon_social == razon_bot,
            Orden.especie == especie,
            Orden.tipo_orden.in_(TIPOS_VENTA),
            Orden.instancia.notin_(["Ejecutada", "Cancelada"]),
        )
    ).scalar()
    return qty or 0


def _get_mejor_bid_ask(
    db,
    especie: str,
    excluir_razon: str,
) -> tuple[float | None, float | None]:
    """
    Read the best bid and best ask for a species from all pending orders
    that do NOT belong to the requesting bot (to avoid anchoring on its
    own stale quotes).

    Returns (mejor_bid, mejor_ask) — either may be None if the side is empty.
    """
    ordenes = db.execute(
        select(Orden).where(
            Orden.especie == especie,
            Orden.instancia.notin_(["Ejecutada", "Cancelada"]),
            Orden.razon_social != excluir_razon,
            Orden.precio_limite.isnot(None),
        )
    ).scalars().all()

    bids = [o.precio_limite for o in ordenes if o.tipo_orden in TIPOS_COMPRA]
    asks = [o.precio_limite for o in ordenes if o.tipo_orden in TIPOS_VENTA]

    mejor_bid = max(bids) if bids else None
    mejor_ask = min(asks) if asks else None
    return mejor_bid, mejor_ask


def _reaccionar_fills(
    db,
    bot: BotInstancia,
    razon_bot: str,
    perfil: PerfilConfig,
    precios_map: dict[str, float],
    cliente_bot: str,
) -> list[str]:
    """
    Check for bot orders that were fully executed since the last tick and
    that have not yet been reacted to.  For each such order, with probability
    fill_react_prob, place the opposite leg at fill_react_markup away from
    the execution price — simulating a human who recycled the position.

    Mejora 3: Orders at cascade depth >= _MAX_REACT_DEPTH are skipped to
    prevent infinite ping-pong chains between the bot and other market actors.

    Returns a list of new order nro_orden strings (caller must commit and emit).
    """
    global _react_depth

    # Trim depth dict if it grows too large
    if len(_react_depth) > _REACT_DEPTH_MAX_SIZE:
        _react_depth = {}

    # Exclude already-reacted IDs.  SQLAlchemy notin_ needs a non-empty list.
    excluir = list(_reacted_fills) if _reacted_fills else [-1]

    ejecutadas = db.execute(
        select(Orden).where(
            Orden.cliente == cliente_bot,
            Orden.razon_social == razon_bot,
            Orden.instancia == "Ejecutada",
            Orden.id.notin_(excluir),
        )
    ).scalars().all()

    nuevos: list[str] = []
    for orden in ejecutadas:
        _reacted_fills.add(orden.id)

        # ── Mejora 3: cascade depth check ─────────────────────────────────────
        depth = _react_depth.get(orden.id, 0)
        if depth >= _MAX_REACT_DEPTH:
            _logger.debug(
                "[%s] fill-reaction skipped (cascade depth %d >= %d): orden=%d especie=%s",
                bot.nombre, depth, _MAX_REACT_DEPTH, orden.id, orden.especie,
            )
            continue

        if random.random() >= perfil.fill_react_prob:
            continue

        precio_ref = precios_map.get(orden.especie)
        if not precio_ref or not orden.precio_promedio:
            continue

        es_compra = orden.tipo_orden in TIPOS_COMPRA
        tipos = bot.tipos_list()
        tipos_contra = [
            t for t in tipos
            if (t in TIPOS_VENTA if es_compra else t in TIPOS_COMPRA)
        ]
        if not tipos_contra:
            continue

        tipo_contra = random.choice(tipos_contra)
        markup = perfil.fill_react_markup

        if es_compra:
            # Fill was a buy → place sell above fill price
            # Only if the bot holds enough free inventory (net pos minus pending sells)
            pos_actual = _get_posicion_neta(db, orden.especie, cliente_bot)
            pendientes_venta = _get_pendientes_venta_qty(db, orden.especie, razon_bot)
            inventario_libre = pos_actual - pendientes_venta
            if inventario_libre <= 0:
                continue
            precio_contra = _round_to_tick(orden.precio_promedio * (1 + markup))
        else:
            # Fill was a sell → place buy below fill price
            precio_contra = _round_to_tick(orden.precio_promedio * (1 - markup))

        # Size: between 50 % and 100 % of the executed quantity
        cantidad = max(1, int(orden.cantidad_ejecutada * random.uniform(0.5, 1.0)))
        if es_compra:
            cantidad = min(cantidad, inventario_libre)

        # Fill reactions can also be market orders (same probability as regular orders)
        prob_mkt_react = (
            bot.prob_orden_mercado
            if bot.prob_orden_mercado is not None
            else perfil.prob_orden_mercado
        )
        if random.random() < prob_mkt_react:
            react_tipo_precio = "MERCADO"
            react_precio_limite = None
        else:
            react_tipo_precio = "LIMITE"
            react_precio_limite = precio_contra

        nueva = Orden(
            nro_orden="",
            tipo_orden=tipo_contra,
            tipo_precio=react_tipo_precio,
            fecha_orden=date.today(),
            cliente=cliente_bot,
            razon_social=razon_bot,
            especie=orden.especie,
            moneda=orden.moneda or "ARP",
            precio_limite=react_precio_limite,
            cantidad_total=cantidad,
            cantidad_ejecutada=0,
            precio_promedio=0.0,
            instancia="Pendiente",
            instancia_codigo=1,
            estado_color="orange",
            version=1,
            bot_id=bot.id,
        )
        db.add(nueva)
        db.flush()
        nueva.nro_orden = f"OR{nueva.id + 999:06d}"

        # Track cascade depth for the new reaction order
        _react_depth[nueva.id] = depth + 1

        nuevos.append(nueva.nro_orden)
        _logger.debug(
            "[%s] fill-reaction: especie=%s tipo=%s precio=%.2f qty=%d depth=%d",
            bot.nombre, orden.especie, tipo_contra, precio_contra, cantidad, depth + 1,
        )

    return nuevos


# ── Single-bot tick ────────────────────────────────────────────────────────────

async def _tick_bot(bot: BotInstancia, sesgo_macro: float = 0.0) -> None:
    perfil = _resolver_perfil(bot, get_perfil(bot.perfil))

    # ── Mejora 6: outside-hours mode ──────────────────────────────────────────
    # Instead of skipping entirely, bots still run housekeeping outside market
    # hours (stale cancellation + fill reaction) but do NOT move prices or
    # inject new orders.
    fuera_de_horario = bot.respetar_horario and not _es_horario_mercado()

    # Cycle always advances — keeps state consistent across the day boundary.
    modo = _actualizar_ciclo(bot.id, perfil)

    db = SessionLocal()
    try:
        # Load active species
        especies = db.execute(
            select(EspecieMercado).where(EspecieMercado.activo == True)
        ).scalars().all()
        if not especies:
            return

        # Build price and variation maps (needed for stale check and order pricing)
        precio_rows = db.execute(
            select(PrecioMercado.especie, PrecioMercado.precio, PrecioMercado.variacion_pct)
            .where(PrecioMercado.precio > 0)
        ).all()
        precios_map     = {r[0]: r[1] for r in precio_rows}
        variaciones_map = {r[0]: (r[2] or 0.0) for r in precio_rows}

        razon_bot = _BOT_RAZON + f" [{bot.nombre}]"
        cliente_bot = f"BOT_{bot.id}"

        # ── 3. Cancel stale orders (runs outside hours too) ───────────────────
        n_stale = _cancelar_stale(db, razon_bot, precios_map, perfil, cliente_bot)
        if n_stale:
            db.commit()
            _logger.info("[%s] %d orden(es) stale cancelada(s)", bot.nombre, n_stale)

        # ── 4. React to recent fills (runs outside hours too) ─────────────────
        fills_nuevos = _reaccionar_fills(db, bot, razon_bot, perfil, precios_map, cliente_bot)
        if fills_nuevos:
            db.commit()
            for nro in fills_nuevos:
                await sio.emit("orden_nueva", {"nro_orden": nro, "cliente": cliente_bot})

        # ── Mejora 6: stop here when outside market hours ─────────────────────
        if fuera_de_horario:
            return

        # ── Mejora 1: update EMA momentum ─────────────────────────────────────
        # Smooth each ticker's variacion_pct with an exponential moving average
        # so the offset calculation has directional memory across ticks.
        for esp, var in variaciones_map.items():
            prev_ema = _precio_ema.get(esp, 0.0)
            _precio_ema[esp] = _EMA_ALPHA * var + (1 - _EMA_ALPHA) * prev_ema

        # ── 5. Price movement ─────────────────────────────────────────────────
        sample = random.sample(especies, min(random.randint(3, 6), len(especies)))

        if bot.variance and bot.variance > 0:
            variance = bot.variance
        else:
            variance = random.uniform(perfil.variance_min, perfil.variance_max)

        updated = []
        for em in sample:
            pm = db.execute(
                select(PrecioMercado).where(PrecioMercado.especie == em.especie)
            ).scalar_one_or_none()
            if pm is None or not pm.precio or pm.precio <= 0:
                continue

            prev = pm.precio
            factor = random.uniform(1 - variance, 1 + variance)
            nuevo = _round_to_tick(prev * factor)
            if nuevo <= 0:
                continue

            variacion = round((nuevo - prev) / prev * 100, 2)
            pm.precio_anterior = prev
            pm.precio = nuevo
            pm.variacion_pct = variacion
            pm.fuente = "bot"
            pm.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)
            updated.append({"especie": em.especie, "precio": nuevo,
                             "variacion_pct": variacion, "fuente": "bot"})
            precios_map[em.especie] = nuevo   # keep map fresh for order pricing
            # Update EMA with the freshly moved price variation
            prev_ema = _precio_ema.get(em.especie, 0.0)
            _precio_ema[em.especie] = _EMA_ALPHA * variacion + (1 - _EMA_ALPHA) * prev_ema

        if updated:
            db.commit()
            for item in updated:
                await sio.emit("precio_actualizado", item)

        # ── 6. Order injection (every N ticks) ────────────────────────────────
        ctr = _tick_ctr.get(bot.id, 0) + 1
        _tick_ctr[bot.id] = ctr
        if ctr % _TICKS_PER_ORDER != 0:
            return

        tipos = bot.tipos_list()
        if not tipos:
            return

        pending = db.execute(
            select(func.count()).where(
                Orden.cliente == cliente_bot,
                Orden.razon_social == razon_bot,
                Orden.instancia.notin_(["Ejecutada", "Cancelada"]),
            )
        ).scalar() or 0

        if pending >= bot.max_ordenes:
            return

        # ── Mejora 4: backpressure when near max_ordenes ───────────────────────
        # When the bot has > 75 % of its order cap pending: halve burst
        # probability and randomly skip 40 % of injection ticks to reduce
        # order-book congestion without hard-stopping activity.
        presion = pending / bot.max_ordenes if bot.max_ordenes > 0 else 0.0
        if presion >= 0.75:
            if random.random() < 0.40:
                return   # skip this injection tick
            perfil = _dc_replace(perfil, burst_prob=perfil.burst_prob * 0.5)

        # Balance gate
        account = account_service.get_account(db, "bot", bot.id)
        if account is None:
            return
        balance_disponible = float(account.balance_cache)
        if balance_disponible <= 0:
            tipos = [t for t in tipos if t in TIPOS_VENTA]
            if not tipos:
                return

        candidatas = [e for e in especies if e.especie in precios_map]
        if not candidatas:
            return

        n_base   = random.randint(1, 3)
        n_burst  = decidir_burst(perfil)
        n_nuevas = min(n_base + n_burst, bot.max_ordenes - pending)

        seleccion = seleccionar_tickers(candidatas, variaciones_map, perfil, n_nuevas)

        nuevos: list[str] = []
        for em in seleccion:
            precio_ref = precios_map[em.especie]

            # ── Mejora 1: use EMA-smoothed momentum instead of raw variacion_pct
            momentum = _precio_ema.get(em.especie, 0.0) / 100.0

            # ── 4. Own-position bias + cycle phase + macro sesgo ──────────────
            posicion_neta = _get_posicion_neta(db, em.especie, cliente_bot)
            tipo = elegir_tipo_sesgado(tipos, posicion_neta, modo, sesgo_macro)
            es_compra = tipo in TIPOS_COMPRA

            # ── 5. Spread awareness — anchor price to orderbook midpoint ──────
            mejor_bid, mejor_ask = _get_mejor_bid_ask(db, em.especie, razon_bot)
            if mejor_bid and mejor_ask:
                precio_ref_spread = (mejor_bid + mejor_ask) / 2.0
            elif mejor_bid:
                precio_ref_spread = mejor_bid
            elif mejor_ask:
                precio_ref_spread = mejor_ask
            else:
                precio_ref_spread = precio_ref   # fallback: last traded price

            # Resolve price offsets: use bot-level overrides if set, else use profile
            if es_compra:
                off_min = bot.offset_min_compra if bot.offset_min_compra is not None else None
                off_max = bot.offset_max_compra if bot.offset_max_compra is not None else None
            else:
                off_min = bot.offset_min_venta if bot.offset_min_venta is not None else None
                off_max = bot.offset_max_venta if bot.offset_max_venta is not None else None

            if off_min is not None and off_max is not None:
                offset = random.uniform(off_min, off_max)
            else:
                offset = calcular_offset_precio(es_compra, perfil, momentum)

            precio_limite_calculado = _round_to_tick(precio_ref_spread * (1 + offset))

            # ── 6b. Limit vs market order decision ────────────────────────────
            # Base probability from bot override or profile default.
            # Doubles when |momentum| > 1 % — operator "chasing" the price.
            prob_mkt = (
                bot.prob_orden_mercado
                if bot.prob_orden_mercado is not None
                else perfil.prob_orden_mercado
            )
            if abs(momentum) > 0.01:
                prob_mkt = min(0.70, prob_mkt * 2.0)
            use_mercado = random.random() < prob_mkt

            if use_mercado:
                tipo_precio_orden = "MERCADO"
                precio_limite_orden = None
                # Use last market price as capital estimate (actual fill may differ)
                precio_para_capital = precio_ref
            else:
                tipo_precio_orden = "LIMITE"
                precio_limite_orden = precio_limite_calculado
                precio_para_capital = precio_limite_calculado

            # ── 7. Capital-based sizing ───────────────────────────────────────
            cantidad = calcular_cantidad(
                precio_para_capital,
                perfil,
                balance_disponible if es_compra else None,
            )

            if es_compra:
                costo_estimado = precio_para_capital * cantidad
                if costo_estimado > balance_disponible:
                    continue
                balance_disponible -= costo_estimado   # reserve for next iterations
            else:
                # Position check: cannot sell more than free inventory
                # (net filled position minus quantity already committed in pending sells)
                pendientes_venta = _get_pendientes_venta_qty(db, em.especie, razon_bot)
                inventario_libre = posicion_neta - pendientes_venta
                if inventario_libre <= 0:
                    continue
                cantidad = min(cantidad, inventario_libre)

            # ── Mejora 8: structured decision logging ─────────────────────────
            _logger.debug(
                "[%s] especie=%s ciclo=%s momentum=%.3f tipo=%s tipo_precio=%s offset=%.4f precio=%.2f qty=%d sesgo=%.2f",
                bot.nombre, em.especie, modo, momentum, tipo, tipo_precio_orden,
                offset, precio_para_capital, cantidad, sesgo_macro,
            )

            orden = Orden(
                nro_orden="",
                tipo_orden=tipo,
                tipo_precio=tipo_precio_orden,
                fecha_orden=date.today(),
                cliente=cliente_bot,
                razon_social=razon_bot,
                especie=em.especie,
                moneda="ARP",
                precio_limite=precio_limite_orden,
                cantidad_total=cantidad,
                cantidad_ejecutada=0,
                precio_promedio=0.0,
                instancia="Pendiente",
                instancia_codigo=1,
                estado_color="orange",
                version=1,
                bot_id=bot.id,
            )
            db.add(orden)
            db.flush()
            orden.nro_orden = f"OR{orden.id + 999:06d}"
            nuevos.append(orden.nro_orden)

        if nuevos:
            db.commit()
            for nro in nuevos:
                await sio.emit("orden_nueva", {"nro_orden": nro, "cliente": cliente_bot})

    except Exception as exc:
        _logger.exception("[%s] Error en tick: %s", bot.nombre, exc)
        db.rollback()
    finally:
        db.close()


# ── Entry point ────────────────────────────────────────────────────────────────

async def run_market_bot() -> None:
    """Called via asyncio.create_task() in main.py lifespan.
    Master loop ticks every 1 s; each bot runs at its own configured interval.
    Reads ConfigSistema.mercado_sesgo once per tick and propagates it to all bots.
    """
    _logger.info("[MarketBot] Motor multi-instancia iniciado.")
    while True:
        await asyncio.sleep(1)
        now = time.time()
        db = SessionLocal()
        try:
            bots = db.execute(
                select(BotInstancia).where(BotInstancia.enabled == True)
            ).scalars().all()
            # ── Mejora 7: read market-wide macro sesgo ────────────────────────
            cfg = db.get(ConfigSistema, 1)
            sesgo_macro = float(cfg.mercado_sesgo or 0.0) if cfg else 0.0
        except Exception as exc:
            _logger.error("[MarketBot] Error leyendo instancias: %s", exc)
            bots = []
            sesgo_macro = 0.0
        finally:
            db.close()

        for bot in bots:
            last = _last_run.get(bot.id, 0)
            if now - last >= bot.interval:
                _last_run[bot.id] = now
                await _tick_bot(bot, sesgo_macro)
