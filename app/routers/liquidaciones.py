from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.services import settlement_service

router = APIRouter(prefix="/api/liquidaciones", tags=["liquidaciones"])


@router.get("/pendientes")
def listar_pendientes(
    page: int = 1,
    per_page: int = 50,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """List fills that are pending settlement (fecha_liquidacion <= today not yet processed)."""
    return settlement_service.listar_pendientes(db, page=page, per_page=per_page)


@router.post("/procesar")
def procesar_liquidaciones(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """
    Manually trigger the settlement batch job.
    In production this runs automatically at EOD; this endpoint is for manual overrides.
    """
    count = settlement_service.liquidar_pendientes(db)
    db.commit()
    return {
        "success": True,
        "liquidadas": count,
        "mensaje": f"{count} ejecución(es) liquidadas.",
    }
