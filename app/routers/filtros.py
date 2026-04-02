from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.services.orden_service import obtener_filtros

router = APIRouter(prefix="/api/filtros", tags=["filtros"])


@router.get("")
def get_filtros(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return obtener_filtros(db)
