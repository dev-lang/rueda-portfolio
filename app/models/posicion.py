from sqlalchemy import Column, Integer, String, Float, DateTime, UniqueConstraint
from datetime import datetime, timezone
from app.db.base import Base


class Posicion(Base):
    """
    Aggregated position per (cliente, especie, moneda, mercado).

    Updated incrementally inside the same DB transaction as each Ejecucion,
    so it is always consistent with execution records.

    cantidad_neta = cantidad_comprada - cantidad_vendida
    costo_promedio_* is a weighted average updated on every fill.
    """

    __tablename__ = "posiciones"

    id = Column(Integer, primary_key=True)
    cliente = Column(String(20), nullable=False)
    especie = Column(String(20), nullable=False)
    moneda = Column(String(5), nullable=False, default="ARP")
    mercado = Column(String(20), nullable=False, default="DEFAULT")

    cantidad_comprada = Column(Integer, default=0, nullable=False)
    cantidad_vendida = Column(Integer, default=0, nullable=False)
    cantidad_neta = Column(Integer, default=0, nullable=False)
    # Qty committed in unsettled fills (not yet available to sell/liquidate)
    cantidad_pendiente_liquidacion = Column(Integer, default=0, nullable=False)

    costo_promedio_compra = Column(Float, default=0.0, nullable=False)
    costo_promedio_venta = Column(Float, default=0.0, nullable=False)

    last_updated = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), onupdate=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    __table_args__ = (
        UniqueConstraint("cliente", "especie", "moneda", "mercado", name="uq_posicion"),
    )

    @property
    def cantidad_disponible(self) -> int:
        """Net quantity available to trade (excludes pending settlement)."""
        return (self.cantidad_neta or 0) - (self.cantidad_pendiente_liquidacion or 0)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "cliente": self.cliente,
            "especie": self.especie,
            "moneda": self.moneda,
            "mercado": self.mercado,
            "cantidad_comprada": self.cantidad_comprada,
            "cantidad_vendida": self.cantidad_vendida,
            "cantidad_neta": self.cantidad_neta,
            "cantidad_pendiente_liquidacion": self.cantidad_pendiente_liquidacion,
            "cantidad_disponible": self.cantidad_disponible,
            "costo_promedio_compra": round(self.costo_promedio_compra, 4),
            "costo_promedio_venta": round(self.costo_promedio_venta, 4),
            "last_updated": (
                self.last_updated.strftime("%Y-%m-%d %H:%M:%S")
                if self.last_updated
                else None
            ),
        }
