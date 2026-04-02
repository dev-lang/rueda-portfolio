from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import Column, Integer, String, Boolean, Numeric, DateTime
from app.db.base import Base


# Valid limit types
TIPOS_LIMITE = frozenset({
    "SALDO_MAXIMO_ORDEN",   # max notional value of a single order
    "POSICION_MAXIMA",      # max net quantity in a single instrument
    "VOLUMEN_DIARIO",       # max total notional traded today (all fills)
})


class LimiteRiesgo(Base):
    """
    Pre-trade risk limit for a client or globally.

    owner_type='cliente', owner_id=<Cliente.id>  → per-client limit
    owner_type='global',  owner_id=NULL           → applies to all clients

    Per-instrument limits: set especie to a specific ticker.
    Instrument-agnostic limits: leave especie=NULL (applies to all species).
    """
    __tablename__ = "limites_riesgo"

    id          = Column(Integer, primary_key=True)
    owner_type  = Column(String(20), nullable=False, default="global")  # 'cliente' | 'global'
    owner_id    = Column(Integer, nullable=True)                         # Cliente.id or NULL
    tipo_limite = Column(String(30), nullable=False)                     # TIPOS_LIMITE
    especie     = Column(String(20), nullable=True)                      # NULL = all instruments
    moneda      = Column(String(5), nullable=False, default="ARP")
    valor_limite = Column(Numeric(18, 6), nullable=False)
    alerta_pct  = Column(Numeric(5, 2), nullable=False, default=Decimal("80.0"))
    activo      = Column(Boolean, default=True, nullable=False)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    def to_dict(self) -> dict:
        return {
            "id":           self.id,
            "owner_type":   self.owner_type,
            "owner_id":     self.owner_id,
            "tipo_limite":  self.tipo_limite,
            "especie":      self.especie,
            "moneda":       self.moneda,
            "valor_limite": float(self.valor_limite or 0),
            "alerta_pct":   float(self.alerta_pct or 80),
            "activo":       self.activo,
        }
