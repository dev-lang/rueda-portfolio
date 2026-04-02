from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.schemas.limite_riesgo import LimiteRiesgoCreate, LimiteRiesgoUpdate
from app.services import riesgo_service

router = APIRouter(prefix="/api/riesgo", tags=["riesgo"])


@router.get("/cartera")
def metricas_cartera(
    cliente: str = "STD",
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Portfolio risk metrics: duration, DV01, parametric VaR (95% 1-day), FX sensitivity.
    """
    from app.services import riesgo_cartera_service
    return riesgo_cartera_service.calcular_metricas_cartera(db, cliente_codigo=cliente)


@router.get("/limites")
def listar_limites(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """List all active risk limits."""
    limites = riesgo_service.listar(db)
    return {"limites": [lim.to_dict() for lim in limites]}


@router.post("/limites", status_code=201)
def crear_limite(
    payload: LimiteRiesgoCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    try:
        lim = riesgo_service.crear(
            db,
            owner_type=payload.owner_type,
            owner_id=payload.owner_id,
            tipo_limite=payload.tipo_limite,
            especie=payload.especie,
            moneda=payload.moneda,
            valor_limite=payload.valor_limite,
            alerta_pct=payload.alerta_pct,
        )
        db.commit()
        db.refresh(lim)
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return lim.to_dict()


@router.patch("/limites/{limite_id}")
def actualizar_limite(
    limite_id: int,
    payload: LimiteRiesgoUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    try:
        lim = riesgo_service.actualizar(
            db, limite_id,
            valor_limite=payload.valor_limite,
            alerta_pct=payload.alerta_pct,
            activo=payload.activo,
        )
        db.commit()
        db.refresh(lim)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc))
    return lim.to_dict()
