from sqlalchemy.orm import Session
from sqlalchemy import select, func
from datetime import date

from app.models.orden import Orden
from app.models.ejecucion import Ejecucion
from app.services import audit_service
from app.core.estados import (
    INSTANCIAS_BLOQUEANTES, COLORES_BLOQUEANTES,
    MERCADOS_CON_CONFIRMACION,
    COD_EJECUTADA, COD_PARC_EJECUTADA,
    COD_CONCERTADA, COD_PARC_CONCERTADA,
)


class TransaccionError(Exception):
    """Domain error raised when an execution attempt is invalid."""

    def __init__(self, mensaje: str, status_code: int = 400) -> None:
        self.mensaje = mensaje
        self.status_code = status_code
        super().__init__(mensaje)


def ejecutar_orden(
    db: Session,
    orden_id: int,
    cantidad: int,
    precio: float,
    mercado: str = "DEFAULT",
    usuario: str = "sistema",
    contraparte_id: int | None = None,
) -> tuple[Ejecucion, Orden]:
    """
    Registers a partial or full execution (fill) for an order.

    Concurrency:
        Uses SELECT FOR UPDATE to serialize concurrent fill attempts on the
        same order row. In SQLite this serializes at the connection level;
        in PostgreSQL it produces a proper row-level lock.

    Settlement:
        fecha_liquidacion is computed from SettlementRule for the given mercado.
        Fills start as liquidada=False; the batch job in settlement_service
        finalises them when their settlement date arrives.

    Concertación:
        For mercado in {MAE, ROFEX}, the fill creates a Confirmacion record
        and transitions the order to "Concertada" / "Parcialmente Concertada"
        instead of "Ejecutada" / "Parcialmente Ejecutada".

    Returns the new Ejecucion and the updated Orden (both unflushed to the
    caller so they can be passed to PosicionService before the final commit).
    """
    from app.services.settlement_service import calcular_fecha_liquidacion
    from app.services.contraparte_service import verificar_limite, ContraparteLimiteError
    from app.models.confirmacion import Confirmacion
    from app.models.instrumento import Instrumento

    # ── 1. Lock the row ──────────────────────────────────────────────────────
    orden = db.execute(
        select(Orden).where(Orden.id == orden_id).with_for_update()
    ).scalar_one_or_none()

    if orden is None:
        raise TransaccionError(f"Orden {orden_id} no encontrada.", status_code=404)

    # ── 2. Validations ───────────────────────────────────────────────────────
    if orden.estado_color in COLORES_BLOQUEANTES or orden.instancia in INSTANCIAS_BLOQUEANTES:
        raise TransaccionError(
            f"Orden {orden.nro_orden} está bloqueada "
            f"(instancia: {orden.instancia}). No se puede ejecutar."
        )

    if orden.cantidad_ejecutada >= orden.cantidad_total:
        raise TransaccionError(
            f"Orden {orden.nro_orden} ya está completamente ejecutada."
        )

    disponible = orden.cantidad_total - orden.cantidad_ejecutada
    if cantidad > disponible:
        raise TransaccionError(
            f"Sobre-ejecución rechazada: solicitado {cantidad:,}, "
            f"disponible {disponible:,} en orden {orden.nro_orden}."
        )

    # ── 2b. Credit limit check for counterparty ───────────────────────────
    if contraparte_id is not None:
        from decimal import Decimal
        importe_est = Decimal(str(cantidad)) * Decimal(str(precio))
        try:
            verificar_limite(db, contraparte_id, orden.moneda or "ARP", importe_est)
        except ContraparteLimiteError as exc:
            if not exc.es_alerta:
                raise TransaccionError(exc.mensaje, status_code=422)
            # Soft alert: log but do not block

    # ── 3. Determine sequence number ─────────────────────────────────────────
    nro_seq = (
        db.execute(
            select(func.count(Ejecucion.id)).where(Ejecucion.orden_id == orden_id)
        ).scalar()
        or 0
    ) + 1

    # ── 4. Compute settlement date ────────────────────────────────────────────
    _instr = db.execute(
        select(Instrumento).where(Instrumento.especie == orden.especie)
    ).scalar_one_or_none()
    fecha_liq = calcular_fecha_liquidacion(
        db, mercado, date.today(), tipo_especie=_instr.tipo if _instr else None
    )
    # T+0 fills are settled immediately
    es_liquidada_inmediata = (fecha_liq == date.today())

    # ── 5. Determine if bilateral confirmation is required ────────────────────
    requiere_confirmacion = mercado.upper() in MERCADOS_CON_CONFIRMACION

    # ── 6. Create fill record ────────────────────────────────────────────────
    ejecucion = Ejecucion(
        orden_id=orden_id,
        fecha=date.today(),
        cantidad=cantidad,
        precio=precio,
        mercado=mercado,
        nro_secuencia=nro_seq,
        fecha_liquidacion=fecha_liq,
        liquidada=es_liquidada_inmediata,
        contraparte_id=contraparte_id,
        requiere_confirmacion=requiere_confirmacion,
    )
    db.add(ejecucion)
    db.flush()  # ensure this fill is included in the aggregate below

    # ── 7. Recalculate from source of truth ───────────────────────────────────
    result = db.execute(
        select(
            func.sum(Ejecucion.cantidad),
            func.sum(Ejecucion.cantidad * Ejecucion.precio),
        ).where(Ejecucion.orden_id == orden_id)
    ).one()

    total_cantidad = result[0] or 0
    total_valor = result[1] or 0.0

    orden.cantidad_ejecutada = total_cantidad
    orden.precio_promedio = (
        round(total_valor / total_cantidad, 4) if total_cantidad > 0 else 0.0
    )

    # ── 8. State transition ───────────────────────────────────────────────────
    completa = orden.cantidad_ejecutada >= orden.cantidad_total

    if requiere_confirmacion:
        # Order waits for bilateral confirmation before becoming "Ejecutada"
        if completa:
            orden.instancia = "Concertada"
            orden.instancia_codigo = COD_CONCERTADA
            orden.estado_color = "orange"
        else:
            orden.instancia = "Parcialmente Concertada"
            orden.instancia_codigo = COD_PARC_CONCERTADA
            orden.estado_color = "orange"

        # Create the bilateral confirmation record
        confirmacion = Confirmacion(
            ejecucion_id=ejecucion.id,
            estado="PENDIENTE",
            mercado=mercado,
            contraparte_id=contraparte_id,
        )
        db.add(confirmacion)
    else:
        if completa:
            orden.instancia = "Ejecutada"
            orden.instancia_codigo = COD_EJECUTADA
            orden.estado_color = "green"
        else:
            orden.instancia = "Parcialmente Ejecutada"
            orden.instancia_codigo = COD_PARC_EJECUTADA
            orden.estado_color = "orange"

    # ── 9. Bump optimistic lock version ──────────────────────────────────────
    orden.version = (orden.version or 0) + 1

    # ── 10. Audit trail ───────────────────────────────────────────────────────
    audit_service.registrar(
        db,
        tabla="ejecuciones",
        operacion="EXECUTE",
        record_id=ejecucion.id,
        descripcion=(
            f"Fill #{nro_seq} en {orden.nro_orden}: "
            f"{cantidad:,} @ {precio} [{mercado}] — "
            f"ejecutado {orden.cantidad_ejecutada:,}/{orden.cantidad_total:,} "
            f"liq:{fecha_liq.isoformat()} conf:{requiere_confirmacion}"
        ),
        datos_despues={
            "ejecucion_id": ejecucion.id,
            "orden_id": orden_id,
            "cantidad": cantidad,
            "precio": precio,
            "mercado": mercado,
            "nro_secuencia": nro_seq,
            "fecha_liquidacion": fecha_liq.isoformat(),
            "requiere_confirmacion": requiere_confirmacion,
            "instancia_resultado": orden.instancia,
            "contraparte_id": contraparte_id,
        },
        usuario=usuario,
    )

    return ejecucion, orden
