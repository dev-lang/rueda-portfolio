"""
Background simulator — runs as an asyncio.Task inside FastAPI's lifespan.

Uses TransaccionService so the same business rules (validation, weighted
average recalculation, state transitions) apply to simulated fills as to
real fills from the API.

Bot-aware fill logic:
  - If an order has a bot_id, the fill is only attempted with probability
    equal to that bot's fill_rate (from BotInstancia), scaled by the order's
    distance to the current market price (closer = higher probability).
  - Human orders (bot_id=NULL) are always eligible for fills.

Anti auto-trading:
  - If the selected order belongs to a bot that already has pending orders
    on the opposite side for the same especie, the fill is skipped to avoid
    the bot crossing against itself via the background simulator.
"""

import asyncio
import random
from datetime import date

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.orden import Orden
from app.models.bot_instancia import BotInstancia, TIPOS_COMPRA, TIPOS_VENTA
from app.models.especie_mercado import EspecieMercado
from app.models.precio_mercado import PrecioMercado
from app.models.notificacion import Notificacion
from app.services import transaccion_service, posicion_service, comision_service, account_service, precio_service
from app.simulador.perfiles import get_perfil
from app.core.socketio import sio

_SERVICIOS = ["MAEONL", "ROFEX", "Rueda HUB"]
_MENSAJES_POOL = [
    ("Resultado: OK", "ok"),
    ("Procesando operaciones pendientes...", "info"),
    ("Generando ofertas de mercado", "info"),
    ("Sincronizando con instancia principal", "info"),
    ("Heartbeat OK", "ok"),
    ("Validando compliance de órdenes", "info"),
]


async def _tick() -> None:
    db = SessionLocal()
    try:
        # Pick a random partially-executed order
        ordenes_parciales = db.execute(
            select(Orden).where(
                Orden.cantidad_ejecutada < Orden.cantidad_total,
                Orden.estado_color != "red",
            )
        ).scalars().all()

        if ordenes_parciales:
            orden = random.choice(ordenes_parciales)

            # Bot-aware fill gating
            if orden.bot_id is not None:
                bot = db.get(BotInstancia, orden.bot_id)
                fill_rate = bot.fill_rate if (bot and bot.fill_rate is not None) else 0.45

                # ── Mejora 2: scale fill_rate by distance to market price ──────
                # Orders whose limit price is close to the market price are more
                # likely to be filled than orders far from it.
                pm = db.execute(
                    select(PrecioMercado).where(PrecioMercado.especie == orden.especie)
                ).scalar_one_or_none()
                if pm and pm.precio and pm.precio > 0 and orden.precio_limite:
                    perfil = get_perfil(bot.perfil if bot else "MODERADO")
                    stale_limit = (
                        bot.stale_offset_pct
                        if (bot and bot.stale_offset_pct is not None)
                        else perfil.stale_offset_pct
                    )
                    distancia = abs(orden.precio_limite - pm.precio) / pm.precio
                    # Linear scale: at distance=0 → fill_rate unchanged;
                    # at distance=stale_limit → fill_rate → 0.05 (floor)
                    scale = max(0.0, 1.0 - distancia / stale_limit)
                    fill_rate = max(0.05, min(0.95, fill_rate * scale))

                if random.random() >= fill_rate:
                    orden = None

            # ── Mejora 5: anti auto-trading ───────────────────────────────────
            # Skip if the same bot has pending orders on the opposite side for
            # this especie — prevents the background simulator from crossing the
            # bot against itself.
            if orden is not None and orden.bot_id is not None and orden.razon_social:
                es_compra = orden.tipo_orden in TIPOS_COMPRA
                tipos_opuestos = TIPOS_VENTA if es_compra else TIPOS_COMPRA
                opuesto = db.execute(
                    select(Orden.id).where(
                        Orden.razon_social == orden.razon_social,
                        Orden.especie == orden.especie,
                        Orden.tipo_orden.in_(tipos_opuestos),
                        Orden.instancia.notin_(["Ejecutada", "Cancelada"]),
                    ).limit(1)
                ).scalar_one_or_none()
                if opuesto is not None:
                    orden = None   # bot has both sides open — skip this fill

            if orden is not None:
                # Balance gate for buy orders: skip fill if bot has no account or funds
                if orden.bot_id is not None and orden.tipo_orden in TIPOS_COMPRA:
                    account_check = account_service.get_account(db, "bot", orden.bot_id)
                    if account_check is None or float(account_check.balance_cache) <= 0:
                        orden = None

            if orden is not None:
                restante = orden.cantidad_total - orden.cantidad_ejecutada
                cantidad = min(
                    random.randint(100, max(int(restante * 0.4), 100)),
                    restante,
                )

                # ── Circuit breaker (per-species daily volume limit) ───────────
                em_cfg = db.execute(
                    select(EspecieMercado).where(EspecieMercado.especie == orden.especie)
                ).scalar_one_or_none()
                if em_cfg and em_cfg.volumen_max_dia is not None:
                    pm_cb = db.execute(
                        select(PrecioMercado).where(PrecioMercado.especie == orden.especie)
                    ).scalar_one_or_none()
                    vol_hoy = (
                        (pm_cb.volumen_dia or 0)
                        if (pm_cb and pm_cb.fecha_volumen == date.today())
                        else 0
                    )
                    if vol_hoy >= em_cfg.volumen_max_dia:
                        orden = None  # circuit breaker triggered — skip this fill
                    else:
                        cantidad = min(cantidad, em_cfg.volumen_max_dia - vol_hoy)

            # Resolve fill price: LIMITE orders use precio_limite; MERCADO orders
            # use the current market price (precio_limite is None for market orders).
            precio_base = None
            if orden is not None:
                if orden.precio_limite and orden.precio_limite > 0:
                    precio_base = orden.precio_limite
                else:
                    pm_mkt = db.execute(
                        select(PrecioMercado).where(PrecioMercado.especie == orden.especie)
                    ).scalar_one_or_none()
                    if pm_mkt and pm_mkt.precio and pm_mkt.precio > 0:
                        precio_base = pm_mkt.precio
                    else:
                        orden = None  # no reference price — skip fill

            if orden is not None:
                precio = round(precio_base * random.uniform(0.995, 1.005), 2)

                try:
                    ejecucion, orden_actualizada = transaccion_service.ejecutar_orden(
                        db,
                        orden_id=orden.id,
                        cantidad=cantidad,
                        precio=precio,
                        mercado="DEFAULT",
                    )
                    comision = comision_service.calcular_comision(db, ejecucion, orden_actualizada)
                    posicion = posicion_service.actualizar_posicion(
                        db, ejecucion, orden_actualizada,
                        precio_efectivo=comision.costo_efectivo_unitario,
                    )
                    # Ledger impact — silently skipped if no account exists
                    account = account_service.get_account_for_orden(db, orden_actualizada)
                    if account:
                        account_service.impactar_ejecucion(
                            db, account, ejecucion, orden_actualizada, comision,
                        )
                    # Update intraday VWAP/volume
                    precio_service.actualizar_volumen_vwap(db, orden_actualizada.especie, cantidad, precio)
                    db.commit()
                    db.refresh(orden_actualizada)
                    if posicion:
                        db.refresh(posicion)
                    await sio.emit("orden_actualizada", orden_actualizada.to_dict())
                    if posicion:
                        await sio.emit("posicion_actualizada", posicion.to_dict())
                except transaccion_service.TransaccionError:
                    db.rollback()

        # Random service notification
        srv = random.choice(_SERVICIOS)
        msg, tipo = random.choice(_MENSAJES_POOL)
        notif = Notificacion(servicio=srv, mensaje=msg, tipo=tipo)
        db.add(notif)
        db.commit()
        db.refresh(notif)
        await sio.emit("nueva_notificacion", notif.to_dict())

    except Exception as exc:
        db.rollback()
        raise  # propagate to run_simulador for error counting
    finally:
        db.close()


_consecutive_errors = 0
_MAX_CONSECUTIVE_ERRORS = 5


async def run_simulador() -> None:
    """Entry point. Called via asyncio.create_task() in main.py lifespan."""
    global _consecutive_errors
    while True:
        await asyncio.sleep(random.uniform(4, 9))
        try:
            await _tick()
            _consecutive_errors = 0
        except Exception as exc:
            _consecutive_errors += 1
            print(f"[Simulador] Error #{_consecutive_errors}: {exc}")
            if _consecutive_errors >= _MAX_CONSECUTIVE_ERRORS:
                backoff = min(120, 10 * _consecutive_errors)
                print(f"[Simulador] Demasiados errores consecutivos — pausando {backoff}s.")
                await asyncio.sleep(backoff)
