from sqlalchemy import Column, Integer, Boolean, Float, String, DateTime
from datetime import datetime, timezone
from app.db.base import Base


class ConfigSistema(Base):
    """
    Single-row system configuration table (always id=1).

    auto_matching: when True, the background matching engine automatically
        crosses compatible buy/sell orders at their limit prices (price-time
        priority). When False, executions must be triggered manually via
        POST /api/transactions/execute.

    matching_mercado: the mercado string stamped on auto-generated fills
        (appears in blotter and settlement rules lookup).
    """

    __tablename__ = "config_sistema"

    id = Column(Integer, primary_key=True)
    auto_matching = Column(Boolean, default=False, nullable=False)
    matching_mercado = Column(String(20), default="DEFAULT", nullable=False)
    # Market-wide macro sentiment bias applied to all bots' buy/sell decisions.
    # Range: -1.0 (full bearish pressure) … 0.0 (neutral) … +1.0 (full bullish).
    # Each unit shifts every bot's buy probability by ±15 percentage points.
    mercado_sesgo = Column(Float, default=0.0, nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), onupdate=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    def to_dict(self) -> dict:
        return {
            "auto_matching": self.auto_matching,
            "matching_mercado": self.matching_mercado,
            "mercado_sesgo": self.mercado_sesgo if self.mercado_sesgo is not None else 0.0,
            "updated_at": (
                self.updated_at.strftime("%Y-%m-%d %H:%M:%S")
                if self.updated_at else None
            ),
        }
