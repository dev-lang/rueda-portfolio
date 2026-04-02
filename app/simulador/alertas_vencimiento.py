"""
Background task: daily checks that run once per calendar date.

  1. Alert for futures contracts expiring within 5 business days.
     Emits 'vencimiento_proximo' WebSocket event per contract.

  2. GTD order expiry: cancels all orders whose time_in_force='GTD'
     and fecha_exp < today that are still in a non-terminal state.
     Also releases any cash reservation held by those orders.
"""

import asyncio
from datetime import date, timedelta

from app.core.socketio import sio
from app.db.session import SessionLocal


_DIAS_ALERTA = 5          # alert window in calendar days
_CHECK_INTERVAL = 3600    # check every hour (seconds)


def _get_fecha_alerta_hasta() -> date:
    return date.today() + timedelta(days=_DIAS_ALERTA)


def _cancelar_gtd_vencidas(db) -> int:
    """
    Cancels GTD orders whose expiry date is strictly before today.
    Releases cash reservations for buy orders so client balances are correct.
    Returns the number of orders cancelled.
    """
    from sqlalchemy import select
    from app.models.orden import Orden
    from app.models.cliente import Cliente
    from app.services.account_service import get_account, liberar_reserva_orden
    from app.services import audit_service
    from app.models.bot_instancia import TIPOS_COMPRA as _TIPOS_COMPRA

    today = date.today()

    vencidas = db.execute(
        select(Orden).where(
            Orden.time_in_force == "GTD",
            Orden.fecha_exp < today,
            Orden.instancia.notin_(["Ejecutada", "Cancelada"]),
        )
    ).scalars().all()

    canceladas = 0
    for orden in vencidas:
        datos_antes = orden.to_dict()
        orden.instancia = "Cancelada"
        orden.instancia_codigo = 0
        orden.estado_color = "red"
        orden.version += 1

        # Release cash reservation for human buy orders
        if orden.tipo_orden in _TIPOS_COMPRA and orden.bot_id is None:
            cliente_obj = db.execute(
                select(Cliente).where(Cliente.codigo == orden.cliente)
            ).scalar_one_or_none()
            if cliente_obj:
                cuenta = get_account(db, "cliente", cliente_obj.id, orden.moneda or "ARP")
                if cuenta:
                    liberar_reserva_orden(db, cuenta, orden.id, usuario="sistema-gtd")

        audit_service.registrar(
            db,
            tabla="ordenes",
            operacion="CANCEL",
            record_id=orden.id,
            descripcion=f"Orden {orden.nro_orden} cancelada por vencimiento GTD ({orden.fecha_exp}).",
            datos_antes=datos_antes,
            datos_despues=orden.to_dict(),
            usuario="sistema-gtd",
        )
        canceladas += 1

    if canceladas:
        db.commit()
    return canceladas


async def _check_once(last_run_date: date) -> date:
    """Run a single vencimiento check. Returns the date of this run."""
    today = date.today()
    if today == last_run_date:
        return last_run_date  # already ran today

    from sqlalchemy import select
    from app.models.instrumento import FuturoRofexDetalle, Instrumento

    db = SessionLocal()
    alertas_emitidas = 0
    try:
        # ── GTD expiry ────────────────────────────────────────────────────────
        try:
            n = _cancelar_gtd_vencidas(db)
            if n:
                print(f"[GTDExpiry] {n} orden(es) GTD canceladas por vencimiento.")
        except Exception as exc:
            print(f"[GTDExpiry] Error al cancelar GTD: {exc}")
            db.rollback()

        hasta = _get_fecha_alerta_hasta()
        rows = db.execute(
            select(FuturoRofexDetalle, Instrumento)
            .join(Instrumento, FuturoRofexDetalle.instrumento_id == Instrumento.id)
            .where(
                FuturoRofexDetalle.mes_vencimiento != None,
                FuturoRofexDetalle.mes_vencimiento >= today,
                FuturoRofexDetalle.mes_vencimiento <= hasta,
                Instrumento.activo == True,
            )
        ).all()

        for detalle, inst in rows:
            dias_restantes = (detalle.mes_vencimiento - today).days
            await sio.emit("vencimiento_proximo", {
                "instrumento_id":    inst.id,
                "especie":           inst.especie,
                "descripcion":       inst.descripcion,
                "contrato":          detalle.contrato,
                "activo_subyacente": detalle.activo_subyacente,
                "fecha_vencimiento": detalle.mes_vencimiento.isoformat(),
                "dias_restantes":    dias_restantes,
            })
            alertas_emitidas += 1

        if alertas_emitidas:
            print(f"[VencimientosAlert] {alertas_emitidas} futuro(s) vencen dentro de {_DIAS_ALERTA} días.")
    except Exception as exc:
        print(f"[VencimientosAlert] Error: {exc}")
    finally:
        db.close()

    return today


async def run_alertas_vencimiento() -> None:
    """Entry point. Called via asyncio.create_task() in main.py lifespan."""
    last_run = date.min
    while True:
        last_run = await _check_once(last_run)
        await asyncio.sleep(_CHECK_INTERVAL)
