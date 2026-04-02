from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.schemas.contraparte import ContraparteCreate, ContraparteUpdate, LimiteCreditoUpsert
from app.services import contraparte_service

router = APIRouter(prefix="/api/contrapartes", tags=["contrapartes"])


@router.get("")
def listar_contrapartes(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """List all active counterparties with their credit limits and current exposure."""
    return {"contrapartes": contraparte_service.listar_con_exposicion(db)}


@router.get("/{contraparte_id}/exposicion")
def get_exposicion(
    contraparte_id: int,
    moneda: str = "ARP",
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    cp = contraparte_service.obtener(db, contraparte_id)
    if cp is None:
        raise HTTPException(status_code=404, detail="Contraparte no encontrada.")
    exposicion = contraparte_service.get_exposicion_actual(db, contraparte_id, moneda)
    return {
        "contraparte_id": contraparte_id,
        "codigo": cp.codigo,
        "nombre": cp.nombre,
        "moneda": moneda,
        "exposicion_actual": float(exposicion),
    }


@router.post("", status_code=201)
def crear_contraparte(
    payload: ContraparteCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    try:
        cp = contraparte_service.crear(db, payload.codigo, payload.nombre, payload.tipo)
        db.commit()
        db.refresh(cp)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return cp.to_dict()


@router.patch("/{contraparte_id}")
def actualizar_contraparte(
    contraparte_id: int,
    payload: ContraparteUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    try:
        cp = contraparte_service.actualizar(
            db, contraparte_id, nombre=payload.nombre, activo=payload.activo
        )
        db.commit()
        db.refresh(cp)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return cp.to_dict()


@router.put("/{contraparte_id}/limites")
def upsert_limite(
    contraparte_id: int,
    payload: LimiteCreditoUpsert,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """Create or update the credit limit for a (counterparty, currency) pair."""
    cp = contraparte_service.obtener(db, contraparte_id)
    if cp is None:
        raise HTTPException(status_code=404, detail="Contraparte no encontrada.")
    lim = contraparte_service.upsert_limite(
        db, contraparte_id, payload.moneda, payload.limite, payload.alerta_pct
    )
    db.commit()
    db.refresh(lim)
    return lim.to_dict()
