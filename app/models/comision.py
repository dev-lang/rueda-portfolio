from sqlalchemy import Column, Integer, Float, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.db.base import Base


class Comision(Base):
    """
    Commission record linked 1-to-1 with an Ejecucion fill.

    costo_efectivo_unitario = precio_fill + (monto_total / cantidad)
    This is the all-in cost per unit, used as the weighted-average price
    in PosicionService so positions reflect real economic cost.
    """

    __tablename__ = "comisiones"

    id = Column(Integer, primary_key=True)
    ejecucion_id = Column(
        Integer, ForeignKey("ejecuciones.id"), nullable=False, unique=True, index=True
    )

    monto_bruto = Column(Float, nullable=False)             # cantidad × precio
    tasa = Column(Float, nullable=False)                    # e.g. 0.003 (0.30 %)
    monto_comision = Column(Float, nullable=False)          # monto_bruto × tasa
    iva = Column(Float, nullable=False)                     # monto_comision × 0.21
    monto_total = Column(Float, nullable=False)             # monto_comision + iva
    costo_efectivo_unitario = Column(Float, nullable=False) # precio + monto_total/cantidad

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    ejecucion = relationship("Ejecucion", back_populates="comision")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "ejecucion_id": self.ejecucion_id,
            "monto_bruto": round(self.monto_bruto, 2),
            "tasa": self.tasa,
            "monto_comision": round(self.monto_comision, 2),
            "iva": round(self.iva, 2),
            "monto_total": round(self.monto_total, 2),
            "costo_efectivo_unitario": round(self.costo_efectivo_unitario, 4),
        }
