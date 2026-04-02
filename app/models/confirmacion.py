from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship

from app.db.base import Base

# Valid confirmation states
ESTADOS_CONFIRMACION = frozenset({"PENDIENTE", "CONFIRMADA", "RECHAZADA"})


class Confirmacion(Base):
    """
    Bilateral confirmation record for a fill (Ejecucion) in markets that require it
    (MAE, ROFEX).

    Lifecycle:
        PENDIENTE  →  CONFIRMADA  (counterparty accepted)
        PENDIENTE  →  RECHAZADA   (counterparty rejected — fill must be reversed)

    One Confirmacion per Ejecucion (1:1, enforced by unique constraint on ejecucion_id).
    """
    __tablename__ = "confirmaciones"

    id                  = Column(Integer, primary_key=True)
    ejecucion_id        = Column(Integer, ForeignKey("ejecuciones.id"), nullable=False, unique=True, index=True)
    estado              = Column(String(20), nullable=False, default="PENDIENTE")
    mercado             = Column(String(20), nullable=False)
    contraparte_id      = Column(Integer, ForeignKey("contrapartes.id"), nullable=True)
    motivo_rechazo      = Column(Text, nullable=True)
    usuario_confirma    = Column(String(50), nullable=True)
    fecha_confirmacion  = Column(DateTime, nullable=True)
    created_at          = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    ejecucion   = relationship("Ejecucion", back_populates="confirmacion")
    contraparte = relationship("Contraparte")

    def to_dict(self) -> dict:
        return {
            "id":                 self.id,
            "ejecucion_id":       self.ejecucion_id,
            "estado":             self.estado,
            "mercado":            self.mercado,
            "contraparte_id":     self.contraparte_id,
            "motivo_rechazo":     self.motivo_rechazo,
            "usuario_confirma":   self.usuario_confirma,
            "fecha_confirmacion": (
                self.fecha_confirmacion.strftime("%d/%m/%Y %H:%M:%S")
                if self.fecha_confirmacion else None
            ),
            "created_at": (
                self.created_at.strftime("%d/%m/%Y %H:%M:%S")
                if self.created_at else None
            ),
        }
