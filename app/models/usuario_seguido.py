"""
User watchlist for tracking specific instruments.

One row per (user, especie) pair. Optional price targets for alerts.
"""

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from app.db.base import Base


class UsuarioSeguido(Base):
    """
    Track which instruments a user is following.
    Optional target prices for buy/sell alerts.
    """
    __tablename__ = "usuario_seguido"

    id = Column(Integer, primary_key=True)
    usuario_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    especie = Column(String(20), ForeignKey("especies_mercado.especie"), nullable=False, index=True)

    # Optional price targets for alerts
    precio_compra_meta = Column(Float, nullable=True)  # Target buy price
    precio_venta_meta = Column(Float, nullable=True)   # Target sell price

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    __table_args__ = (
        UniqueConstraint("usuario_id", "especie", name="uq_usuario_seguido"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "usuario_id": self.usuario_id,
            "especie": self.especie,
            "precio_compra_meta": self.precio_compra_meta,
            "precio_venta_meta": self.precio_venta_meta,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
