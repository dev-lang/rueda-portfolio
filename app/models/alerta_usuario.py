"""
AlertaUsuario — user-defined notification rules.

Each rule belongs to a specific user (username) and fires a WebSocket
event (alerta_usuario_disparada) when the condition is met.

Types:
  ORDEN_MONTO     — a new order for 'cliente'/'especie' has notional >= umbral
  POSICION_CAIDA  — unrealised P&L on a position drops below -umbral (loss)
  POSICION_SUBE   — unrealised P&L on a position exceeds +umbral (gain)
  VOLUMEN_CLIENTE — a client's total daily notional exceeds umbral
"""

from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Integer, Numeric, String

from app.db.base import Base

TIPOS_ALERTA = frozenset({
    "ORDEN_MONTO",
    "POSICION_CAIDA",
    "POSICION_SUBE",
    "VOLUMEN_CLIENTE",
})


class AlertaUsuario(Base):
    __tablename__ = "alertas_usuario"

    id          = Column(Integer, primary_key=True)
    username    = Column(String(50), nullable=False, index=True)
    tipo        = Column(String(30), nullable=False)
    cliente     = Column(String(50), nullable=True)   # NULL = all clients
    especie     = Column(String(20), nullable=True)   # NULL = all species
    umbral      = Column(Numeric(18, 2), nullable=False)
    moneda      = Column(String(5), nullable=False, default="ARP")
    activo      = Column(Boolean, default=True, nullable=False)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    ultima_vez  = Column(DateTime, nullable=True)     # last time this alert fired

    def to_dict(self) -> dict:
        return {
            "id":         self.id,
            "username":   self.username,
            "tipo":       self.tipo,
            "cliente":    self.cliente,
            "especie":    self.especie,
            "umbral":     float(self.umbral or 0),
            "moneda":     self.moneda,
            "activo":     self.activo,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "ultima_vez": self.ultima_vez.isoformat() if self.ultima_vez else None,
        }
