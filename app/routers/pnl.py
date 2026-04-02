"""
P&L daily endpoints.

GET  /api/pnl                   — list PnlDiario rows with filters
GET  /api/pnl/resumen?fecha=... — aggregated totals for a date
POST /api/pnl/cerrar-dia        — run EOD close process (ADMIN)
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.services import pnl_service, precio_service

router = APIRouter(prefix="/api/pnl", tags=["pnl"])


@router.get("")
def listar_pnl(
    fecha_desde: date | None = Query(default=None),
    fecha_hasta: date | None = Query(default=None),
    cliente: str = "Todos",
    especie: str = "Todos",
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = pnl_service.listar_pnl(
        db,
        fecha_desde=fecha_desde,
        fecha_hasta=fecha_hasta,
        cliente=cliente if cliente != "Todos" else None,
        especie=especie if especie != "Todos" else None,
    )
    return {"pnl": [r.to_dict() for r in rows]}


@router.get("/por-desk")
def pnl_por_desk(
    fecha: date = Query(default_factory=date.today),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """P&L aggregated by trading desk (cost center) for a given date. Feature 15."""
    return {
        "fecha": fecha.isoformat(),
        "desks": pnl_service.listar_pnl_por_desk(db, fecha),
    }


@router.get("/resumen")
def resumen_pnl(
    fecha: date = Query(default_factory=date.today),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return pnl_service.get_resumen_pnl(db, fecha)


@router.post("/cerrar-dia")
def cerrar_dia(
    fecha: date = Query(default_factory=date.today),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """
    Runs the EOD P&L close process for the given date.
    Computes realized and unrealized P&L for every active (cliente, especie) pair.
    Idempotent — safe to re-run for the same date.
    """
    try:
        # Feature 16: snapshot current market prices as CIERRE before computing P&L
        snaps = precio_service.snapshot_diario(db, fecha)
        n = pnl_service.run_cierre_dia(db, fecha)
        db.commit()
        return {
            "success": True,
            "fecha": fecha.isoformat(),
            "posiciones_procesadas": n,
            "precios_snapshotteados": snaps,
            "mensaje": f"Cierre de día procesado: {n} posiciones calculadas ({snaps} precios guardados).",
        }
    except Exception:
        db.rollback()
        raise
