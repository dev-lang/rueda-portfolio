from sqlalchemy import Column, Integer, String, Boolean, UniqueConstraint
from app.db.base import Base


class SettlementRule(Base):
    """
    Defines settlement lag (in business days) for a given market and instrument type.

    Argentine market defaults:
        BYMA    → T+2 (contado normal)
        BYMA_CI → T+0 (contado inmediato)
        MAE     → T+1 (bonos soberanos)
        ROFEX   → T+0 (daily mark-to-market)

    If no rule matches (e.g. mercado=DEFAULT), the caller should assume T+0.
    """
    __tablename__ = "settlement_rules"

    id           = Column(Integer, primary_key=True)
    mercado      = Column(String(20), nullable=False)
    tipo_especie = Column(String(20), nullable=False, default="ALL")  # ALL | BOND | EQUITY | FUTURO
    dias_habil   = Column(Integer, nullable=False, default=0)         # 0=T+0, 1=T+1, 2=T+2
    descripcion  = Column(String(100), nullable=True)
    activo       = Column(Boolean, default=True, nullable=False)

    __table_args__ = (
        UniqueConstraint("mercado", "tipo_especie", name="uq_settlement_rule"),
    )

    def to_dict(self) -> dict:
        return {
            "id":           self.id,
            "mercado":      self.mercado,
            "tipo_especie": self.tipo_especie,
            "dias_habil":   self.dias_habil,
            "descripcion":  self.descripcion,
            "activo":       self.activo,
        }
