import json
from sqlalchemy import Column, Integer, String, Text, DateTime
from datetime import datetime, timezone
from app.db.base import Base


class AuditLog(Base):
    """Immutable audit trail for all state-changing operations on orders."""

    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True)
    tabla = Column(String(50), nullable=False, index=True)
    operacion = Column(String(20), nullable=False)  # CREATE, UPDATE, CANCEL, EXECUTE
    record_id = Column(Integer, nullable=False, index=True)
    usuario = Column(String(50), default="sistema")
    descripcion = Column(String(300))
    datos_antes = Column(Text)   # JSON snapshot before change
    datos_despues = Column(Text) # JSON snapshot after change
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), index=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tabla": self.tabla,
            "operacion": self.operacion,
            "record_id": self.record_id,
            "usuario": self.usuario,
            "descripcion": self.descripcion,
            "datos_antes": json.loads(self.datos_antes) if self.datos_antes else None,
            "datos_despues": json.loads(self.datos_despues) if self.datos_despues else None,
            "timestamp": self.created_at.strftime("%d/%m/%Y %H:%M:%S") if self.created_at else None,
        }
