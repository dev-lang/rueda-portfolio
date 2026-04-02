"""
Operador model — links a user account to a trading desk.

A desk groups orders for P&L by cost center.
Desks: ACCIONES | RENTA_FIJA | DERIVADOS | FCI
"""

from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Integer, String

from app.db.base import Base


class Operador(Base):
    __tablename__ = "operadores"

    id             = Column(Integer, primary_key=True)
    nombre         = Column(String(100), nullable=False)
    # Must match users.username — not an FK so the table can be seeded independently
    username       = Column(String(50), nullable=False, unique=True, index=True)
    # Trading desk — used as cost center for P&L attribution
    desk           = Column(String(15), nullable=False)   # ACCIONES|RENTA_FIJA|DERIVADOS|FCI
    # Linked client — orders placed by this operator default to this client
    cliente_codigo = Column(String(20), nullable=True, index=True)
    activo         = Column(Boolean, nullable=False, default=True)
    created_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    def to_dict(self) -> dict:
        return {
            "id":             self.id,
            "nombre":         self.nombre,
            "username":       self.username,
            "desk":           self.desk,
            "cliente_codigo": self.cliente_codigo,
            "activo":         self.activo,
            "created_at":     self.created_at.isoformat() if self.created_at else None,
        }
