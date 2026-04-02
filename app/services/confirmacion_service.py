"""
Bilateral confirmation service — manages the confirm/reject lifecycle
for fills that require counterparty confirmation (MAE, ROFEX).

State transitions:
    PENDIENTE → CONFIRMADA: fill is accepted; order moves to Ejecutada/Parcialmente Ejecutada.
    PENDIENTE → RECHAZADA:  fill is rejected; position + cash are reversed; order moves back.

Partial-fill recalculation:
    After any confirm/reject, recalcular_estado_orden() recomputes the order's instancia
    based on the combined state of all its fills.
"""

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy.orm import Session
from sqlalchemy import select

from app.models.confirmacion import Confirmacion
from app.models.ejecucion import Ejecucion
from app.models.orden import Orden
from app.models.posicion import Posicion
from app.models.account import Account
from app.models.account_entry import AccountEntry
from app.services import audit_service
from app.core.estados import (
    COD_EJECUTADA, COD_PARC_EJECUTADA, COD_PENDIENTE,
    COD_RECHAZADA, COD_CONCERTADA, COD_PARC_CONCERTADA,
)
from app.models.bot_instancia import TIPOS_COMPRA, TIPOS_VENTA


class ConfirmacionError(Exception):
    def __init__(self, mensaje: str, status_code: int = 400) -> None:
        self.mensaje = mensaje
        self.status_code = status_code
        super().__init__(mensaje)


def _to_decimal(v) -> Decimal:
    return Decimal(str(v or 0))


# ── Internal helpers ──────────────────────────────────────────────────────────

def _revertir_posicion(db: Session, ejecucion: Ejecucion, orden: Orden) -> None:
    """Undo the position update from a rejected fill."""
    tipo = orden.tipo_orden.upper()

    posicion: Posicion | None = db.execute(
        select(Posicion).where(
            Posicion.cliente == orden.cliente,
            Posicion.especie == orden.especie,
            Posicion.moneda == orden.moneda,
            Posicion.mercado == ejecucion.mercado,
        ).with_for_update()
    ).scalar_one_or_none()

    if posicion is None:
        return

    if tipo in TIPOS_COMPRA:
        nueva_cant = max(0, (posicion.cantidad_comprada or 0) - ejecucion.cantidad)
        if nueva_cant > 0:
            # Recompute weighted average without the rejected fill
            prev_valor = (posicion.cantidad_comprada or 0) * (posicion.costo_promedio_compra or 0.0)
            fill_valor = ejecucion.cantidad * ejecucion.precio
            nuevo_valor = prev_valor - fill_valor
            posicion.costo_promedio_compra = round(nuevo_valor / nueva_cant, 4) if nueva_cant > 0 else 0.0
        posicion.cantidad_comprada = nueva_cant

    elif tipo in TIPOS_VENTA:
        nueva_cant = max(0, (posicion.cantidad_vendida or 0) - ejecucion.cantidad)
        if nueva_cant > 0:
            prev_valor = (posicion.cantidad_vendida or 0) * (posicion.costo_promedio_venta or 0.0)
            fill_valor = ejecucion.cantidad * ejecucion.precio
            nuevo_valor = prev_valor - fill_valor
            posicion.costo_promedio_venta = round(nuevo_valor / nueva_cant, 4) if nueva_cant > 0 else 0.0
        posicion.cantidad_vendida = nueva_cant

    posicion.cantidad_neta = (posicion.cantidad_comprada or 0) - (posicion.cantidad_vendida or 0)
    # Release pending qty
    posicion.cantidad_pendiente_liquidacion = max(
        0,
        (posicion.cantidad_pendiente_liquidacion or 0) - ejecucion.cantidad,
    )


def _revertir_caja(db: Session, ejecucion: Ejecucion) -> None:
    """
    Reverse all AccountEntry rows tied to this fill (mark them liquidada=False and
    create compensating entries to restore the balance).
    """
    entries: list[AccountEntry] = db.execute(
        select(AccountEntry).where(
            AccountEntry.ref_type == "ejecucion",
            AccountEntry.ref_id == ejecucion.id,
        )
    ).scalars().all()

    for entry in entries:
        account: Account | None = db.get(Account, entry.account_id)
        if account is None:
            continue
        locked: Account = db.execute(
            select(Account).where(Account.id == account.id).with_for_update()
        ).scalar_one()

        monto = _to_decimal(entry.monto)
        # Reverse the direction
        sentido_reverso = "CREDIT" if entry.sentido == "DEBIT" else "DEBIT"
        prev = _to_decimal(locked.balance_cache)
        if sentido_reverso == "CREDIT":
            nuevo_balance = prev + monto
        else:
            nuevo_balance = prev - monto

        reverso = AccountEntry(
            account_id=locked.id,
            tipo=entry.tipo,
            monto=monto,
            sentido=sentido_reverso,
            balance_post=nuevo_balance,
            ref_type="confirmacion_rechazo",
            ref_id=ejecucion.id,
            descripcion=f"Reversión por rechazo fill #{ejecucion.nro_secuencia} (orig entry #{entry.id})",
            usuario="sistema",
            liquidada=True,
        )
        db.add(reverso)
        locked.balance_cache = nuevo_balance

        # Release balance_reservado if the original was a pending debit
        if not entry.liquidada and entry.sentido == "DEBIT":
            locked.balance_reservado = max(
                Decimal("0"),
                _to_decimal(locked.balance_reservado) - monto,
            )


def recalcular_estado_orden(db: Session, orden: Orden) -> None:
    """
    Recomputes orden.instancia based on the states of all its fills/confirmaciones.

    Logic:
      - If any Confirmacion is PENDIENTE → keep in Concertada/Parcialmente Concertada.
      - If all fills with requiere_confirmacion=True are CONFIRMADA (or there are none):
          → use the standard Ejecutada / Parcialmente Ejecutada / Pendiente transition.
      - If ALL fills were RECHAZADA (and none confirmed):
          → order goes back to Pendiente.
    """
    ejecuciones: list[Ejecucion] = list(orden.ejecuciones)

    # Ignore rejected fills when counting totals
    fills_activos = [
        e for e in ejecuciones
        if not (e.requiere_confirmacion and e.confirmacion and e.confirmacion.estado == "RECHAZADA")
    ]

    qty_activa = sum(e.cantidad for e in fills_activos)
    hay_pendiente_conf = any(
        e.requiere_confirmacion
        and e.confirmacion
        and e.confirmacion.estado == "PENDIENTE"
        for e in fills_activos
    )

    if hay_pendiente_conf:
        # Keep in concertación state
        if qty_activa >= orden.cantidad_total:
            orden.instancia = "Concertada"
            orden.instancia_codigo = COD_CONCERTADA
        else:
            orden.instancia = "Parcialmente Concertada"
            orden.instancia_codigo = COD_PARC_CONCERTADA
        orden.estado_color = "orange"
    elif qty_activa >= orden.cantidad_total:
        orden.instancia = "Ejecutada"
        orden.instancia_codigo = COD_EJECUTADA
        orden.estado_color = "green"
    elif qty_activa > 0:
        orden.instancia = "Parcialmente Ejecutada"
        orden.instancia_codigo = COD_PARC_EJECUTADA
        orden.estado_color = "orange"
    else:
        # All fills were rejected — order is open again
        orden.instancia = "Pendiente"
        orden.instancia_codigo = COD_PENDIENTE
        orden.estado_color = "orange"

    # Update cantidad_ejecutada to reflect only active fills
    orden.cantidad_ejecutada = qty_activa
    if qty_activa > 0:
        total_valor = sum(e.cantidad * e.precio for e in fills_activos)
        orden.precio_promedio = round(total_valor / qty_activa, 4)
    else:
        orden.precio_promedio = 0.0

    orden.version = (orden.version or 0) + 1


# ── Public API ────────────────────────────────────────────────────────────────

def obtener_confirmacion(db: Session, ejecucion_id: int) -> Confirmacion | None:
    return db.execute(
        select(Confirmacion).where(Confirmacion.ejecucion_id == ejecucion_id)
    ).scalar_one_or_none()


def confirmar(
    db: Session,
    ejecucion_id: int,
    usuario: str = "sistema",
) -> Confirmacion:
    """
    Confirms a pending fill. The order transitions toward Ejecutada/Parcialmente Ejecutada.
    Also marks the fill (and its entries) as liquidada=True if settlement date has passed.
    """
    conf = obtener_confirmacion(db, ejecucion_id)
    if conf is None:
        raise ConfirmacionError(f"No existe confirmación para ejecución {ejecucion_id}.", 404)
    if conf.estado != "PENDIENTE":
        raise ConfirmacionError(
            f"La confirmación ya está en estado '{conf.estado}'.", 400
        )

    conf.estado = "CONFIRMADA"
    conf.usuario_confirma = usuario
    conf.fecha_confirmacion = datetime.now(timezone.utc).replace(tzinfo=None)

    orden: Orden = conf.ejecucion.orden
    recalcular_estado_orden(db, orden)

    audit_service.registrar(
        db,
        tabla="confirmaciones",
        operacion="UPDATE",
        record_id=conf.id,
        descripcion=(
            f"Fill #{conf.ejecucion.nro_secuencia} de {orden.nro_orden} CONFIRMADO "
            f"por {usuario}."
        ),
        datos_despues=conf.to_dict(),
        usuario=usuario,
    )

    return conf


def rechazar(
    db: Session,
    ejecucion_id: int,
    motivo: str,
    usuario: str = "sistema",
) -> Confirmacion:
    """
    Rejects a pending fill.
    - Reverses the position update.
    - Creates compensating AccountEntry rows to restore cash.
    - Recalculates order state.
    """
    conf = obtener_confirmacion(db, ejecucion_id)
    if conf is None:
        raise ConfirmacionError(f"No existe confirmación para ejecución {ejecucion_id}.", 404)
    if conf.estado != "PENDIENTE":
        raise ConfirmacionError(
            f"La confirmación ya está en estado '{conf.estado}'.", 400
        )

    ejecucion: Ejecucion = conf.ejecucion
    orden: Orden = ejecucion.orden

    conf.estado = "RECHAZADA"
    conf.motivo_rechazo = motivo
    conf.usuario_confirma = usuario
    conf.fecha_confirmacion = datetime.now(timezone.utc).replace(tzinfo=None)

    # Reverse financial impacts
    _revertir_posicion(db, ejecucion, orden)
    _revertir_caja(db, ejecucion)

    recalcular_estado_orden(db, orden)

    audit_service.registrar(
        db,
        tabla="confirmaciones",
        operacion="UPDATE",
        record_id=conf.id,
        descripcion=(
            f"Fill #{ejecucion.nro_secuencia} de {orden.nro_orden} RECHAZADO "
            f"por {usuario}. Motivo: {motivo}"
        ),
        datos_despues={**conf.to_dict(), "instancia_orden": orden.instancia},
        usuario=usuario,
    )

    return conf
