"""
User-defined alert rules — /api/alertas

GET    /api/alertas              — list own alerts (current user)
POST   /api/alertas              — create a new alert rule
PATCH  /api/alertas/{id}/toggle  — toggle activo on/off
DELETE /api/alertas/{id}         — delete an alert rule
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.alerta_usuario import AlertaUsuario, TIPOS_ALERTA
from app.models.user import User

router = APIRouter(prefix="/api/alertas", tags=["alertas"])


class CrearAlertaRequest(BaseModel):
    tipo: str
    umbral: float
    cliente: str | None = None
    especie: str | None = None
    moneda: str = "ARP"

    @field_validator("tipo")
    @classmethod
    def tipo_valido(cls, v: str) -> str:
        if v not in TIPOS_ALERTA:
            raise ValueError(f"tipo inválido: {v}. Válidos: {sorted(TIPOS_ALERTA)}")
        return v

    @field_validator("umbral")
    @classmethod
    def umbral_positivo(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("umbral debe ser > 0")
        return v

    @field_validator("especie")
    @classmethod
    def especie_upper(cls, v: str | None) -> str | None:
        return v.upper() if v else None


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
    payload: CrearAlertaRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    alerta = AlertaUsuario(
        username=current_user.username,
        tipo=payload.tipo,
        cliente=payload.cliente or None,
        especie=payload.especie,
        umbral=payload.umbral,
        moneda=payload.moneda,
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
