from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.deps import get_current_user
from app.core.pagination import paginate
from app.db.session import get_db
from app.models.user import User
from app.schemas.transaccion import EjecutarOrdenRequest, EjecutarOrdenResponse, RechazarRequest
from app.services import transaccion_service, posicion_service, comision_service, account_service, riesgo_service
from app.models.ejecucion import Ejecucion
from app.models.orden import Orden
from app.core.socketio import sio

router = APIRouter(prefix="/api/transactions", tags=["transacciones"])


@router.get("")
def listar_transacciones(
    cliente: str = "Todos",
    especie: str = "Todos",
    mercado: str = "Todos",
    page: int = 1,
    per_page: int = 50,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Lists all fills (Ejecuciones) joined with their parent order."""
    base = (
        select(Ejecucion, Orden)
        .join(Orden, Ejecucion.orden_id == Orden.id)
    )
    if cliente != "Todos":
        base = base.where(Orden.cliente == cliente)
    if especie != "Todos":
        base = base.where(Orden.especie == especie)
    if mercado != "Todos":
        base = base.where(Ejecucion.mercado == mercado)

    rows, meta = paginate(
        db, base, page, per_page,
        order_by=Ejecucion.created_at.desc(),
        scalars=False,
    )

    transacciones = []
    for ejec, orden in rows:
        com = ejec.comision
        transacciones.append({
            "id": ejec.id,
            "fecha": ejec.fecha.strftime("%d/%m/%Y") if ejec.fecha else None,
            "nro_orden": orden.nro_orden,
            "tipo_orden": orden.tipo_orden,
            "especie": orden.especie,
            "cliente": orden.cliente,
            "razon_social": orden.razon_social,
            "mercado": ejec.mercado,
            "cantidad": ejec.cantidad,
            "precio": ejec.precio,
            "importe": round(ejec.cantidad * ejec.precio, 2),
            "comision_total": round(com.monto_total, 2) if com else None,
            "costo_efectivo": round(com.costo_efectivo_unitario, 4) if com else None,
            "nro_secuencia": ejec.nro_secuencia,
        })

    return {"transacciones": transacciones, **meta}


@router.post("/execute", response_model=EjecutarOrdenResponse)
async def ejecutar_orden(
    payload: EjecutarOrdenRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        # ── Resolve account and check available balance before the fill ──────
        from sqlalchemy import select as _select
        from app.models.orden import Orden as _Orden
        _orden_preview = db.get(_Orden, payload.orden_id)
        if _orden_preview:
            _account = account_service.get_account_for_orden(db, _orden_preview)
            if _account:
                riesgo_service.verificar_saldo_ejecucion(
                    db, _account, _orden_preview, payload.cantidad, payload.precio
                )

        ejecucion, orden = transaccion_service.ejecutar_orden(
            db,
            orden_id=payload.orden_id,
            cantidad=payload.cantidad,
            precio=payload.precio,
            mercado=payload.mercado,
            usuario=current_user.username,
            contraparte_id=payload.contraparte_id,
        )
        comision = comision_service.calcular_comision(db, ejecucion, orden)
        posicion = posicion_service.actualizar_posicion(
            db, ejecucion, orden,
            precio_efectivo=comision.costo_efectivo_unitario,
        )
        # Ledger impact — silently skipped if no account exists for this owner
        account = account_service.get_account_for_orden(db, orden)
        if account:
            account_service.impactar_ejecucion(
                db, account, ejecucion, orden, comision,
                usuario=current_user.username,
            )
        db.commit()
        db.refresh(orden)
        db.refresh(ejecucion)
        if posicion:
            db.refresh(posicion)
    except riesgo_service.RiesgoLimiteError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail={"tipo": "LIMITE_RIESGO", "mensaje": exc.mensaje})
    except transaccion_service.TransaccionError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)
    except Exception:
        db.rollback()
        raise

    await sio.emit("orden_actualizada", orden.to_dict())
    if posicion:
        await sio.emit("posicion_actualizada", posicion.to_dict())

    return EjecutarOrdenResponse(
        success=True,
        orden=orden.to_dict(),
        ejecucion=ejecucion.to_dict(),
        mensaje=(
            f"Ejecución registrada. "
            f"Ejecutado: {orden.cantidad_ejecutada:,}/{orden.cantidad_total:,}"
        ),
    )


# ── Bilateral confirmation endpoints ─────────────────────────────────────────


@router.post("/{ejecucion_id}/confirmar")
async def confirmar_ejecucion(
    ejecucion_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Confirms a pending bilateral fill (MAE/ROFEX).
    Transitions the order toward Ejecutada / Parcialmente Ejecutada.
    """
    from app.services import confirmacion_service
    try:
        conf = confirmacion_service.confirmar(db, ejecucion_id, usuario=current_user.username)
        orden = conf.ejecucion.orden
        db.commit()
        db.refresh(conf)
        db.refresh(orden)
    except confirmacion_service.ConfirmacionError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)
    except Exception:
        db.rollback()
        raise

    await sio.emit("orden_actualizada", orden.to_dict())
    return {"success": True, "confirmacion": conf.to_dict(), "orden": orden.to_dict()}


@router.post("/{ejecucion_id}/rechazar")
async def rechazar_ejecucion(
    ejecucion_id: int,
    payload: RechazarRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Rejects a pending bilateral fill.
    Reverses position + cash impacts and recalculates order state.
    """
    from app.services import confirmacion_service
    try:
        conf = confirmacion_service.rechazar(
            db, ejecucion_id, motivo=payload.motivo, usuario=current_user.username
        )
        orden = conf.ejecucion.orden
        db.commit()
        db.refresh(conf)
        db.refresh(orden)
    except confirmacion_service.ConfirmacionError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)
    except Exception:
        db.rollback()
        raise

    await sio.emit("orden_actualizada", orden.to_dict())
    return {"success": True, "confirmacion": conf.to_dict(), "orden": orden.to_dict()}
