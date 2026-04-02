"""
Tipo de cambio endpoints.

GET  /api/tipo-cambio/actual         — current live FX rates (MEP, CCL, oficial)
GET  /api/tipo-cambio/historico      — historical records with optional filters
POST /api/tipo-cambio/guardar        — persist today's rates to DB (ADMIN)
"""

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.services import tipo_cambio_service

router = APIRouter(prefix="/api/tipo-cambio", tags=["tipo_cambio"])


@router.get("/actual")
def get_tipo_cambio_actual(_: User = Depends(get_current_user)):
    """Returns current live FX rates (MEP, CCL, oficial). In-memory cached 15 min."""
    return tipo_cambio_service.get_tipo_cambio()


@router.get("/historico")
def listar_historico(
    tipo: str | None = Query(default=None, description="MEP | CCL | CABLE | OFICIAL | BNA"),
    fecha_desde: date | None = Query(default=None),
    fecha_hasta: date | None = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = tipo_cambio_service.listar_historico(
        db, tipo=tipo, fecha_desde=fecha_desde, fecha_hasta=fecha_hasta
    )
    return {"tipo_cambio_historico": [r.to_dict() for r in rows]}


@router.post("/guardar")
def guardar_tipo_cambio(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """
    Fetches current FX rates from dolarapi.com and persists them to DB.
    Called automatically by the price_feed task; also available manually.
    """
    n = tipo_cambio_service.guardar_historico(db)
    return {
        "success": True,
        "registros_guardados": n,
        "fecha": date.today().isoformat(),
    }
