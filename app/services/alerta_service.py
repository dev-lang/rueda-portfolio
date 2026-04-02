"""
Alert evaluation service.

Called from routers after order creation / fill registration so that
matching AlertaUsuario rules can fire a WebSocket event.
"""

from datetime import datetime, timezone, timezone

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.socketio import sio
from app.models.alerta_usuario import AlertaUsuario


async def evaluar_alertas_orden(db: Session, orden) -> None:
    """
    Evaluate ORDEN_MONTO rules when a new order is placed.
    orden is an Orden ORM object.
    """
    if not (orden.precio_limite and orden.cantidad_total):
        return

    monto = float(orden.precio_limite) * float(orden.cantidad_total)

    alertas = (
        db.query(AlertaUsuario)
        .filter(
            AlertaUsuario.tipo == "ORDEN_MONTO",
            AlertaUsuario.activo == True,  # noqa: E712
            AlertaUsuario.moneda == (orden.moneda or "ARP"),
            or_(AlertaUsuario.cliente == None, AlertaUsuario.cliente == orden.cliente),  # noqa: E711
            or_(AlertaUsuario.especie == None, AlertaUsuario.especie == orden.especie),  # noqa: E711
        )
        .all()
    )

    for a in alertas:
        if monto >= float(a.umbral):
            await sio.emit("alerta_usuario_disparada", {
                "id":       a.id,
                "username": a.username,
                "tipo":     a.tipo,
                "mensaje":  (
                    f"Orden {orden.nro_orden} · {orden.tipo_orden} "
                    f"{orden.especie} ({orden.cliente}) "
                    f"por {monto:,.0f} {orden.moneda} "
                    f"supera umbral de {float(a.umbral):,.0f}"
                ),
            })
            a.ultima_vez = datetime.now(timezone.utc).replace(tzinfo=None)

    db.commit()


async def evaluar_alertas_posicion(db: Session, posicion) -> None:
    """
    Evaluate POSICION_CAIDA / POSICION_SUBE rules when a position is updated.
    posicion is a Posicion ORM object (must have pnl_no_realizado or be computable).
    """
    pnl = getattr(posicion, "pnl_no_realizado", None)
    if pnl is None:
        return

    pnl = float(pnl)

    tipo_buscar = "POSICION_CAIDA" if pnl < 0 else "POSICION_SUBE"
    umbral_abs  = abs(pnl)

    alertas = (
        db.query(AlertaUsuario)
        .filter(
            AlertaUsuario.tipo == tipo_buscar,
            AlertaUsuario.activo == True,  # noqa: E712
            or_(AlertaUsuario.cliente == None, AlertaUsuario.cliente == posicion.cliente),  # noqa: E711
            or_(AlertaUsuario.especie == None, AlertaUsuario.especie == posicion.especie),  # noqa: E711
        )
        .all()
    )

    for a in alertas:
        if umbral_abs >= float(a.umbral):
            signo = "▼ Caída" if tipo_buscar == "POSICION_CAIDA" else "▲ Suba"
            await sio.emit("alerta_usuario_disparada", {
                "id":       a.id,
                "username": a.username,
                "tipo":     a.tipo,
                "mensaje":  (
                    f"{signo} P&L en {posicion.especie} ({posicion.cliente}): "
                    f"{pnl:+,.0f} — supera umbral de {float(a.umbral):,.0f}"
                ),
            })
            a.ultima_vez = datetime.now(timezone.utc).replace(tzinfo=None)

    db.commit()
