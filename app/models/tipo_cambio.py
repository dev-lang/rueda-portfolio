"""
Historical FX rate records for Argentine market.

One row per (fecha, tipo). Written daily by the price_feed background task.
Used for:
  - Valuación en ARS de posiciones denominadas en USD
  - Resultado por diferencia de cambio en P&L
  - Reportes regulatorios (BCRA posición de cambios)

tipos: MEP (bolsa), CCL (contado con liqui), CABLE, OFICIAL, BNA
"""

from datetime import datetime, timezone

from sqlalchemy import Column, Date, DateTime, Float, Integer, String, UniqueConstraint

from app.db.base import Base

TIPOS_TC = frozenset({"MEP", "CCL", "CABLE", "OFICIAL", "BNA"})


class TipoCambioHistorico(Base):
    __tablename__ = "tipo_cambio_historico"

    id           = Column(Integer, primary_key=True)
    fecha        = Column(Date,    nullable=False, index=True)
    tipo         = Column(String(10), nullable=False)    # TIPOS_TC
    valor_compra = Column(Float, nullable=True)          # ARS per USD (bid)
    valor_venta  = Column(Float, nullable=False)         # ARS per USD (ask / reference)
    fuente       = Column(String(50), nullable=False, default="dolarapi.com")
    created_at   = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    __table_args__ = (
        UniqueConstraint("fecha", "tipo", name="uq_tc_fecha_tipo"),
    )

    def to_dict(self) -> dict:
        return {
            "id":           self.id,
            "fecha":        self.fecha.isoformat() if self.fecha else None,
            "tipo":         self.tipo,
            "valor_compra": self.valor_compra,
            "valor_venta":  self.valor_venta,
            "fuente":       self.fuente,
        }
