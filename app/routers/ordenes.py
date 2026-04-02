import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.core.rate_limiter import limiter

logger = logging.getLogger(__name__)
from app.db.session import get_db
from app.models.user import User
from app.schemas.orden import OrdenCreate, OrdenModify
from app.services import orden_service
from app.services.alerta_service import evaluar_alertas_orden
from app.core.socketio import sio

router = APIRouter(prefix="/api/ordenes", tags=["ordenes"])


@router.get("/blotter")
def get_blotter(
    fecha: date | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Intraday blotter: all orders for the given date (default today),
    ordered chronologically. No pagination — designed for dense trading view.
    """
    return {"ordenes": orden_service.listar_blotter(db, fecha)}


@router.get("")
def listar_ordenes(
    especie: str = "Todos",
    cliente: str = "Todos",
    estado_color: str | None = None,
    fecha_desde: date | None = None,
    fecha_hasta: date | None = None,
    page: int = 1,
    per_page: int = 20,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return orden_service.listar_ordenes(
        db, especie=especie, cliente=cliente,
        estado_color=estado_color,
        fecha_desde=fecha_desde, fecha_hasta=fecha_hasta,
        page=page, per_page=per_page,
    )


@router.get("/{orden_id}/ejecuciones")
def get_ejecuciones(
    orden_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    orden = orden_service.obtener_orden(db, orden_id)
    if not orden:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    return {
        "orden": orden.to_dict(),
        "ejecuciones": [e.to_dict() for e in orden.ejecuciones],
    }


@router.post("")
@limiter.limit("30/minute")
async def crear_orden(
    request: Request,
    payload: OrdenCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.services.riesgo_service import RiesgoLimiteError
    try:
        orden, notif, alertas = orden_service.crear_orden(db, payload, usuario=current_user.username)
    except RiesgoLimiteError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail={"tipo": "LIMITE_RIESGO", "mensaje": exc.mensaje})
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc))
    db.commit()
    db.refresh(orden)
    db.refresh(notif)
    await sio.emit("orden_nueva", orden.to_dict())
    await sio.emit("nueva_notificacion", notif.to_dict())
    if alertas:
        await sio.emit("alerta_riesgo", {"alertas": alertas, "nro_orden": orden.nro_orden})
    # Evaluate user-defined alert rules (non-blocking)
    try:
        await evaluar_alertas_orden(db, orden)
    except Exception:
        logger.warning("Error al evaluar alertas para orden %s", orden.nro_orden, exc_info=True)
    return {"success": True, "orden": orden.to_dict(), "alertas_riesgo": alertas}


@router.post("/{orden_id}/cancelar")
async def cancelar_orden(
    orden_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        orden = orden_service.cancelar_orden(db, orden_id, usuario=current_user.username)
        db.commit()
        db.refresh(orden)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))

    await sio.emit("orden_actualizada", orden.to_dict())
    return {"success": True, "orden": orden.to_dict()}


@router.patch("/{orden_id}")
async def modificar_orden(
    orden_id: int,
    payload: OrdenModify,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if payload.precio_limite is None and payload.cantidad_total is None:
        raise HTTPException(
            status_code=422,
            detail="Debe proveer al menos un campo a modificar (precio_limite o cantidad_total).",
        )
    try:
        orden = orden_service.modificar_orden(
            db, orden_id, payload.precio_limite, payload.cantidad_total,
            usuario=current_user.username,
        )
        db.commit()
        db.refresh(orden)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))

    await sio.emit("orden_actualizada", orden.to_dict())
    return {"success": True, "orden": orden.to_dict()}
