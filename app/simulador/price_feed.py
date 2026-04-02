"""
Market price feed — asyncio background task.

Refreshes Yahoo Finance prices every INTERVAL seconds for all instruments
that have positions and a known ticker mapping. Emits `precios_actualizados`
via Socket.IO after each successful refresh so the UI updates live.

Resilience behaviour:
  - Each refresh runs inside asyncio.wait_for() with a 30 s hard timeout.
  - On failure, the interval doubles up to MAX_BACKOFF (1 h) and resets on success.
  - All events are logged via the stdlib logging module (not print).
"""

import asyncio
import logging

from app.db.session import SessionLocal
from app.models.bot_instancia import TIPOS_COMPRA
from app.services import precio_service, tipo_cambio_service
from app.core.socketio import sio

logger = logging.getLogger(__name__)

INTERVAL    = 300   # base interval between refreshes (seconds)
MAX_BACKOFF = 3600  # maximum backoff on consecutive failures (1 hour)
FETCH_TIMEOUT = 30  # max seconds to wait for yfinance / TC fetch


async def run_price_feed() -> None:
    """Entry point — called via asyncio.create_task() in main.py lifespan."""
    logger.info("PriceFeed iniciado — actualizando precios cada %d s.", INTERVAL)
    backoff = INTERVAL
    while True:
        await asyncio.sleep(backoff)
        success = await _refresh()
        if success:
            backoff = INTERVAL  # reset on success
        else:
            backoff = min(backoff * 2, MAX_BACKOFF)
            logger.warning("PriceFeed: próximo intento en %d s.", backoff)


async def _refresh() -> bool:
    """
    Performs one price-feed cycle. Returns True on success, False on failure.
    The caller uses the return value to apply exponential backoff.
    """
    db = SessionLocal()
    try:
        try:
            actualizadas = await asyncio.wait_for(
                precio_service.fetch_and_update(db),
                timeout=FETCH_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.error(
                "PriceFeed: timeout al obtener precios (>%d s) — se reintentará.", FETCH_TIMEOUT
            )
            db.rollback()
            return False

        if actualizadas:
            precios = precio_service.get_all(db)
            await sio.emit("precios_actualizados", {
                "precios": [p.to_dict() for p in precios],
            })
            logger.info("PriceFeed: precios actualizados — %s", ", ".join(actualizadas))

            n = precio_service.snapshot_diario(db)
            if n:
                logger.debug("PriceFeed: snapshot diario — %d registros.", n)

            # Persist FX rates alongside price snapshot
            try:
                n_tc = tipo_cambio_service.guardar_historico(db)
                if n_tc:
                    db.commit()
                    logger.debug("PriceFeed: tipos de cambio guardados — %d registros.", n_tc)
            except Exception as tc_exc:
                logger.warning("PriceFeed: error guardando TC: %s", tc_exc)

            # Check stop-loss / take-profit activation after every price update
            try:
                n_act = await _activar_condicionales(db, precios)
                if n_act:
                    logger.info("PriceFeed: Stop/TP activadas — %d orden(es).", n_act)
            except Exception as act_exc:
                logger.warning("PriceFeed: error activando condicionales: %s", act_exc)

        return True

    except Exception as exc:
        logger.error("PriceFeed: error inesperado: %s", exc, exc_info=True)
        db.rollback()
        return False
    finally:
        db.close()


async def _activar_condicionales(db, precios) -> int:
    """
    Checks all inactive (conditional) orders with tipo_activacion set.
    Activates them when the market price crosses the activation threshold.
    Returns the number of orders activated.
    """
    from sqlalchemy import select
    from app.models.orden import Orden

    precio_map = {p.especie: p.precio for p in precios}

    pendientes = db.execute(
        select(Orden).where(
            Orden.activa == False,
            Orden.tipo_activacion != None,
            Orden.instancia == "Pendiente",
        )
    ).scalars().all()

    activadas = 0
    for orden in pendientes:
        precio_actual = precio_map.get(orden.especie)
        if precio_actual is None or orden.precio_activacion is None:
            continue

        debe_activar = False
        if orden.tipo_activacion == "STOP_LOSS":
            # STOP_LOSS compra: activar cuando precio sube a >= precio_activacion
            # STOP_LOSS venta: activar cuando precio baja a <= precio_activacion
            if orden.tipo_orden in TIPOS_COMPRA:
                debe_activar = precio_actual >= orden.precio_activacion
            else:
                debe_activar = precio_actual <= orden.precio_activacion
        elif orden.tipo_activacion == "TAKE_PROFIT":
            # TAKE_PROFIT compra: activar cuando precio baja a <= precio_activacion
            # TAKE_PROFIT venta: activar cuando precio sube a >= precio_activacion
            if orden.tipo_orden in TIPOS_COMPRA:
                debe_activar = precio_actual <= orden.precio_activacion
            else:
                debe_activar = precio_actual >= orden.precio_activacion

        if debe_activar:
            orden.activa = True
            order_dict = orden.to_dict()
            db.flush()
            await sio.emit("orden_actualizada", order_dict)
            activadas += 1

    if activadas:
        db.commit()
    return activadas
