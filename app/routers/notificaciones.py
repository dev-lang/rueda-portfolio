from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.notificacion import Notificacion
from app.models.user import User

router = APIRouter(prefix="/api/notificaciones", tags=["notificaciones"])


@router.get("")
def listar_notificaciones(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    notifs = db.execute(
        select(Notificacion).order_by(Notificacion.created_at.desc()).limit(50)
    ).scalars().all()
    return list(reversed([n.to_dict() for n in notifs]))
