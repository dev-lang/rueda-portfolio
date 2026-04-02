from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.services import utilitario_service

router = APIRouter(prefix="/api/utils", tags=["utilitarios"])


@router.get("/stats")
def get_stats(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return utilitario_service.get_stats(db)


@router.get("/health")
def get_health(db: Session = Depends(get_db)):
    # Public endpoint — used for monitoring / load-balancer health checks
    return utilitario_service.get_health(db)


@router.post("/seed-reset")
def seed_reset(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),  # ADMIN only
):
    """
    Drops all tables and re-seeds the database.
    Only available when RESET_DB_ON_START=true in config/env.
    """
    from app.core.config import settings
    if not settings.RESET_DB_ON_START:
        raise HTTPException(
            status_code=403,
            detail="Reset no habilitado. Configurar RESET_DB_ON_START=true para activarlo.",
        )

    from app.db.base import Base, engine
    from app.db.seed import seed_database, seed_admin_user
    from app.db.session import SessionLocal

    db.close()

    try:
        Base.metadata.drop_all(bind=engine)
        Base.metadata.create_all(bind=engine)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Error al recrear el esquema de base de datos.",
        ) from exc

    fresh_db = SessionLocal()
    try:
        seed_database(fresh_db)
        seed_admin_user(fresh_db)
    except Exception as exc:
        fresh_db.rollback()
        raise HTTPException(
            status_code=500,
            detail="Error al sembrar datos iniciales.",
        ) from exc
    finally:
        fresh_db.close()

    return {"success": True, "mensaje": "Base de datos reseteada y re-sembrada."}
