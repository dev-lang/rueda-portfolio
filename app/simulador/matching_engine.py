"""
Automatic order-matching engine.

When auto_matching is enabled (ConfigSistema.auto_matching = True) this
background loop runs a sweep every second.  For each species that has both
pending buy and sell orders it applies price-time priority matching:

  1. Best bid  = highest buy-limit price; ties broken by earliest created_at.
  2. Best ask  = lowest sell-limit price; ties broken by earliest created_at.
  3. If best_bid.precio_limite >= best_ask.precio_limite → prices cross → fill.
  4. Execution price = ask.precio_limite (passive/resting order convention).
  5. Execution qty   = min(remaining bid qty, remaining ask qty).
  6. Both sides are filled via transaccion_service; positions and accounts
     are updated in the same transaction.
  7. Repeat for the same species until no more crosses remain.

Self-trading prevention: orders from the same (cliente, razon_social) pair
are never matched against each other.
"""

import asyncio
from datetime import date

from sqlalchemy import select, func, distinct, case, or_

from app.db.session import SessionLocal
from app.models.config_sistema import ConfigSistema
from app.models.especie_mercado import EspecieMercado
from app.models.precio_mercado import PrecioMercado
from app.models.orden import Orden
from app.models.bot_instancia import TIPOS_COMPRA, TIPOS_VENTA
from app.core.socketio import sio

_ESTADOS_EXCL = {"Ejecutada", "Cancelada"}

# Mercado string stamped on auto-generated fills (overridden by config)
_DEFAULT_MERCADO = "DEFAULT"


# ── Single-species matching pass ───────────────────────────────────────────────

def _cruzar_especie(db, especie: str, mercado: str) -> list[dict]:
    """
    Run one full matching pass for *especie*.  Loops until no more crosses exist.
    Returns a list of emit payloads (one per filled order side).
    Caller must commit after this returns.

    Market orders (tipo_precio='MERCADO'):
      - Have priority over limit orders in queue ordering.
      - Skip the price-cross check (execute against any available counter-price).
      - Execution price = counter-limit price; if both sides are market orders,
        fallback to the last known PrecioMercado price.

    Circuit breaker:
      - If EspecieMercado.volumen_max_dia is set and the species' intraday
        volume (PrecioMercado.volumen_dia) has reached the limit, matching is
        halted for the rest of the day.
      - The fill quantity is also capped so the limit is never exceeded mid-loop.
    """
    from app.services import (
        transaccion_service, posicion_service,
        comision_service, account_service, riesgo_service, precio_service,
    )

    emits: list[dict] = []

    # ── Load per-species config (circuit breaker + max order size) ─────────────
    em_cfg = db.execute(
        select(EspecieMercado).where(EspecieMercado.especie == especie)
    ).scalar_one_or_none()

    # Helper: order-type priority (MERCADO orders sort first)
    _mercado_first = case((Orden.tipo_precio == "MERCADO", 1), else_=0)

    while True:
        # ── Circuit breaker check ──────────────────────────────────────────────
        volumen_max = em_cfg.volumen_max_dia if em_cfg else None
        if volumen_max is not None:
            pm_vol = db.execute(
                select(PrecioMercado).where(PrecioMercado.especie == especie)
            ).scalar_one_or_none()
            vol_hoy = (
                (pm_vol.volumen_dia or 0)
                if (pm_vol and pm_vol.fecha_volumen == date.today())
                else 0
            )
            if vol_hoy >= volumen_max:
                break  # circuit breaker triggered — halt matching for today

        # ── Best bid: market orders first, then highest limit price ───────────
        bid = db.execute(
            select(Orden)
            .where(
                Orden.especie == especie,
                Orden.tipo_orden.in_(TIPOS_COMPRA),
                Orden.instancia.notin_(_ESTADOS_EXCL),
                Orden.cantidad_total > Orden.cantidad_ejecutada,
                Orden.activa == True,
                or_(Orden.tipo_precio == "MERCADO", Orden.precio_limite.isnot(None)),
            )
            .order_by(
                _mercado_first.desc(),
                Orden.precio_limite.desc().nullslast(),
                Orden.created_at.asc(),
            )
            .limit(1)
        ).scalar_one_or_none()

        # ── Best ask: market orders first, then lowest limit price ─────────────
        ask = db.execute(
            select(Orden)
            .where(
                Orden.especie == especie,
                Orden.tipo_orden.in_(TIPOS_VENTA),
                Orden.instancia.notin_(_ESTADOS_EXCL),
                Orden.cantidad_total > Orden.cantidad_ejecutada,
                Orden.activa == True,
                or_(Orden.tipo_precio == "MERCADO", Orden.precio_limite.isnot(None)),
            )
            .order_by(
                _mercado_first.desc(),
                Orden.precio_limite.asc().nullsfirst(),
                Orden.created_at.asc(),
            )
            .limit(1)
        ).scalar_one_or_none()

        if not bid or not ask:
            break

        # ── Self-trading prevention ────────────────────────────────────────────
        if bid.cliente == ask.cliente and bid.razon_social == ask.razon_social:
            break

        # ── Price cross check (skipped when either side is a market order) ─────
        is_market = bid.tipo_precio == "MERCADO" or ask.tipo_precio == "MERCADO"
        if not is_market and bid.precio_limite < ask.precio_limite:
            break  # no cross

        # ── Execution price ────────────────────────────────────────────────────
        if bid.tipo_precio == "MERCADO" and ask.tipo_precio == "MERCADO":
            # Both market: use last known price as reference
            pm_ref = db.execute(
                select(PrecioMercado).where(PrecioMercado.especie == especie)
            ).scalar_one_or_none()
            exec_precio = pm_ref.precio if (pm_ref and pm_ref.precio) else 0.01
        elif bid.tipo_precio == "MERCADO":
            exec_precio = ask.precio_limite   # market buy fills at ask
        elif ask.tipo_precio == "MERCADO":
            exec_precio = bid.precio_limite   # market sell fills at bid
        else:
            exec_precio = ask.precio_limite   # passive side sets the price

        # ── Execution quantity ─────────────────────────────────────────────────
        exec_qty = min(
            bid.cantidad_total - bid.cantidad_ejecutada,
            ask.cantidad_total - ask.cantidad_ejecutada,
        )

        # Cap qty to circuit-breaker headroom
        if volumen_max is not None:
            headroom = volumen_max - vol_hoy
            exec_qty = min(exec_qty, headroom)

        if exec_qty <= 0:
            break  # safety guard

        # ── Balance check for the buy side ────────────────────────────────────
        bid_account = account_service.get_account_for_orden(db, bid)
        if bid_account:
            try:
                riesgo_service.verificar_saldo_ejecucion(
                    db, bid_account, bid, exec_qty, exec_precio
                )
            except riesgo_service.RiesgoLimiteError:
                break  # buyer can't afford it — stop matching this species

        # ── Fill buy side ──────────────────────────────────────────────────────
        ejec_bid, ord_bid = transaccion_service.ejecutar_orden(
            db, bid.id, exec_qty, exec_precio, mercado=mercado, usuario="matching"
        )
        com_bid = comision_service.calcular_comision(db, ejec_bid, ord_bid)
        pos_bid = posicion_service.actualizar_posicion(
            db, ejec_bid, ord_bid,
            precio_efectivo=com_bid.costo_efectivo_unitario if com_bid else None,
        )
        if bid_account:
            account_service.impactar_ejecucion(
                db, bid_account, ejec_bid, ord_bid, com_bid, usuario="matching"
            )

        # ── Fill sell side ─────────────────────────────────────────────────────
        ask_account = account_service.get_account_for_orden(db, ask)
        ejec_ask, ord_ask = transaccion_service.ejecutar_orden(
            db, ask.id, exec_qty, exec_precio, mercado=mercado, usuario="matching"
        )
        com_ask = comision_service.calcular_comision(db, ejec_ask, ord_ask)
        pos_ask = posicion_service.actualizar_posicion(
            db, ejec_ask, ord_ask,
            precio_efectivo=com_ask.costo_efectivo_unitario if com_ask else None,
        )
        if ask_account:
            account_service.impactar_ejecucion(
                db, ask_account, ejec_ask, ord_ask, com_ask, usuario="matching"
            )

        # ── Update intraday VWAP/volume (once per trade, not per side) ─────────
        precio_service.actualizar_volumen_vwap(db, especie, exec_qty, exec_precio)

        emits.append({"tipo": "bid", "orden": ord_bid.to_dict()})
        emits.append({"tipo": "ask", "orden": ord_ask.to_dict()})
        if pos_bid:
            emits.append({"tipo": "pos", "pos": pos_bid.to_dict()})
        if pos_ask:
            emits.append({"tipo": "pos", "pos": pos_ask.to_dict()})
        # Emit updated volume/VWAP for the UI
        pm_emit = db.execute(
            select(PrecioMercado).where(PrecioMercado.especie == especie)
        ).scalar_one_or_none()
        if pm_emit:
            emits.append({"tipo": "precio", "precio": pm_emit.to_dict()})

    return emits


# ── Full matching sweep ────────────────────────────────────────────────────────

async def _sweep(mercado: str) -> None:
    """Run one full matching sweep across all species with pending orders."""
    db = SessionLocal()
    try:
        # Species that have at least one pending buy AND one pending sell
        # Include MERCADO orders (tipo_precio='MERCADO' have no precio_limite)
        _matchable = or_(Orden.tipo_precio == "MERCADO", Orden.precio_limite.isnot(None))

        buy_especies = db.execute(
            select(distinct(Orden.especie)).where(
                Orden.tipo_orden.in_(TIPOS_COMPRA),
                Orden.instancia.notin_(_ESTADOS_EXCL),
                Orden.cantidad_total > Orden.cantidad_ejecutada,
                Orden.activa == True,
                _matchable,
            )
        ).scalars().all()

        sell_especies = set(
            db.execute(
                select(distinct(Orden.especie)).where(
                    Orden.tipo_orden.in_(TIPOS_VENTA),
                    Orden.instancia.notin_(_ESTADOS_EXCL),
                    Orden.cantidad_total > Orden.cantidad_ejecutada,
                    Orden.activa == True,
                    _matchable,
                )
            ).scalars().all()
        )

        candidatas = [e for e in buy_especies if e in sell_especies]

    except Exception as exc:
        print(f"[Matching] Error en sweep (carga candidatas): {exc}")
        candidatas = []
    finally:
        db.close()

    # Each species gets its own session to avoid identity-map cross-contamination
    # between species when one rolls back.
    for especie in candidatas:
        db2 = SessionLocal()
        try:
            emits = _cruzar_especie(db2, especie, mercado)
            if emits:
                db2.commit()
                for ev in emits:
                    if ev["tipo"] in ("bid", "ask"):
                        await sio.emit("orden_actualizada", ev["orden"])
                    elif ev["tipo"] == "pos":
                        await sio.emit("posicion_actualizada", ev["pos"])
                    elif ev["tipo"] == "precio":
                        await sio.emit("precio_actualizado", ev["precio"])
        except Exception as exc:
            db2.rollback()
            print(f"[Matching] Error cruzando {especie}: {exc}")
        finally:
            db2.close()


# ── Background loop ────────────────────────────────────────────────────────────

async def run_matching_engine() -> None:
    """
    Background task started in main.py lifespan.
    Reads ConfigSistema on every tick — config changes take effect immediately.
    """
    print("[Matching] Motor de matching iniciado.")
    while True:
        await asyncio.sleep(1)
        db = SessionLocal()
        try:
            cfg = db.get(ConfigSistema, 1)
            if not cfg or not cfg.auto_matching:
                continue
            mercado = cfg.matching_mercado or _DEFAULT_MERCADO
        except Exception:
            continue
        finally:
            db.close()

        await _sweep(mercado)
