from sqlalchemy import Column, Integer, String, DateTime
from datetime import datetime, timezone
from app.db.base import Base


class Notificacion(Base):
    __tablename__ = "notificaciones"

    id = Column(Integer, primary_key=True)
    servicio = Column(String(20), nullable=False)
    mensaje = Column(String(300), nullable=False)
    tipo = Column(String(10), default="info")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "servicio": self.servicio,
            "mensaje": self.mensaje,
            "tipo": self.tipo,
            "timestamp": self.created_at.strftime("%H:%M:%S") if self.created_at else None,
        }
