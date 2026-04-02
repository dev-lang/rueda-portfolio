"""
User-defined alert rules — /api/alertas

GET    /api/alertas              — list own alerts (current user)
POST   /api/alertas              — create a new alert rule
PATCH  /api/alertas/{id}/toggle  — toggle activo on/off
DELETE /api/alertas/{id}         — delete an alert rule
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.alerta_usuario import AlertaUsuario, TIPOS_ALERTA
from app.models.user import User

router = APIRouter(prefix="/api/alertas", tags=["alertas"])


@router.get("")
def listar_alertas(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = (
        db.query(AlertaUsuario)
        .filter(AlertaUsuario.username == current_user.username)
        .order_by(AlertaUsuario.created_at.desc())
        .all()
    )
    return [r.to_dict() for r in rows]


@router.post("")
def crear_alerta(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tipo = payload.get("tipo", "")
    if tipo not in TIPOS_ALERTA:
        raise HTTPException(400, f"tipo inválido: {tipo}. Válidos: {sorted(TIPOS_ALERTA)}")

    try:
        umbral = float(payload["umbral"])
    except (KeyError, ValueError, TypeError):
        raise HTTPException(400, "umbral debe ser un número")
    if umbral <= 0:
        raise HTTPException(400, "umbral debe ser > 0")

    alerta = AlertaUsuario(
        username=current_user.username,
        tipo=tipo,
        cliente=payload.get("cliente") or None,
        especie=(payload.get("especie") or "").upper() or None,
        umbral=umbral,
        moneda=payload.get("moneda", "ARP"),
        activo=True,
    )
    db.add(alerta)
    db.commit()
    db.refresh(alerta)
    return alerta.to_dict()


@router.patch("/{alerta_id}/toggle")
def toggle_alerta(
    alerta_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    alerta = db.query(AlertaUsuario).filter(
        AlertaUsuario.id == alerta_id,
        AlertaUsuario.username == current_user.username,
    ).first()
    if not alerta:
        raise HTTPException(404, "Alerta no encontrada")
    alerta.activo = not alerta.activo
    db.commit()
    return {"id": alerta.id, "activo": alerta.activo}


@router.delete("/{alerta_id}")
def eliminar_alerta(
    alerta_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    alerta = db.query(AlertaUsuario).filter(
        AlertaUsuario.id == alerta_id,
        AlertaUsuario.username == current_user.username,
    ).first()
    if not alerta:
        raise HTTPException(404, "Alerta no encontrada")
    db.delete(alerta)
    db.commit()
    return {"ok": True}
