from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import Column, Integer, String, Boolean, Numeric, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from app.db.base import Base


class Contraparte(Base):
    """
    External counterparty registry: brokers, banks, MAE participants, ROFEX clearing members.

    Every fill (Ejecucion) can be attributed to a counterparty.
    Credit limits are tracked per (contraparte, moneda) in LimiteCreditoContraparte.
    """
    __tablename__ = "contrapartes"

    id         = Column(Integer, primary_key=True)
    codigo     = Column(String(20), unique=True, nullable=False, index=True)
    nombre     = Column(String(100), nullable=False)
    tipo       = Column(String(30), nullable=False)   # BROKER | BANCO | AGENTE_EXTERNO | MAE_PARTICIPANTE | ROFEX_CLEARING
    activo     = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), onupdate=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    limites = relationship(
        "LimiteCreditoContraparte",
        back_populates="contraparte",
        cascade="all, delete-orphan",
    )

    def to_dict(self) -> dict:
        return {
            "id":        self.id,
            "codigo":    self.codigo,
            "nombre":    self.nombre,
            "tipo":      self.tipo,
            "activo":    self.activo,
        }


class LimiteCreditoContraparte(Base):
    """Per-(contraparte, moneda) credit limit with an alert threshold."""
    __tablename__ = "limites_credito_contraparte"

    id              = Column(Integer, primary_key=True)
    contraparte_id  = Column(Integer, ForeignKey("contrapartes.id"), nullable=False, index=True)
    moneda          = Column(String(5), nullable=False, default="ARP")
    limite          = Column(Numeric(18, 6), nullable=False, default=Decimal("0"))
    alerta_pct      = Column(Numeric(5, 2), nullable=False, default=Decimal("80.00"))

    contraparte = relationship("Contraparte", back_populates="limites")

    __table_args__ = (
        UniqueConstraint("contraparte_id", "moneda", name="uq_limite_contraparte_moneda"),
    )

    def to_dict(self) -> dict:
        return {
            "id":             self.id,
            "contraparte_id": self.contraparte_id,
            "moneda":         self.moneda,
            "limite":         float(self.limite or 0),
            "alerta_pct":     float(self.alerta_pct or 80),
        }
