from sqlalchemy import Column, Integer, String, Boolean, DateTime
from datetime import datetime, timezone
from app.db.base import Base


class EspecieMercado(Base):
    """
    Persistent ticker registry for the Mercado section.
    Replaces the hardcoded TICKER_MAP / GRUPO_BYMA / GRUPO_MERVAL constants
    so admins can list/delist instruments without touching code.

    volumen_max_dia: circuit-breaker threshold — the matching engine stops
        filling orders once the intraday volume reaches this quantity (NULL = no limit).
    cantidad_max_orden: per-order size cap — orders whose cantidad_total exceeds
        this value are rejected at creation time (NULL = no limit).
    """
    __tablename__ = "especies_mercado"

    id = Column(Integer, primary_key=True)
    especie = Column(String(20), unique=True, nullable=False, index=True)
    yf_symbol = Column(String(30), nullable=True)   # e.g. "GGAL.BA" — null for bonds
    panel = Column(String(20), nullable=False)       # BYMA | MERVAL | OTRO
    nombre = Column(String(100), nullable=True)      # optional display name
    activo = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    # ── Per-instrument volume controls ─────────────────────────────────────────
    volumen_max_dia = Column(Integer, nullable=True)   # circuit breaker (NULL = unlimited)
    cantidad_max_orden = Column(Integer, nullable=True) # max qty per order (NULL = unlimited)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "especie": self.especie,
            "yf_symbol": self.yf_symbol,
            "panel": self.panel,
            "nombre": self.nombre,
            "activo": self.activo,
            "volumen_max_dia": self.volumen_max_dia,
            "cantidad_max_orden": self.cantidad_max_orden,
        }
