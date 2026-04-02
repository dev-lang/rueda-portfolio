from sqlalchemy import Column, Integer, String, Float, Date, DateTime, Boolean, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.db.base import Base


class Ejecucion(Base):
    __tablename__ = "ejecuciones"

    id = Column(Integer, primary_key=True)
    orden_id = Column(Integer, ForeignKey("ordenes.id"), nullable=False, index=True)
    fecha = Column(Date, nullable=False)
    cantidad = Column(Integer, nullable=False)
    precio = Column(Float, nullable=False)
    # Identifies the market/venue where the fill occurred (ROFEX, MAE, DEFAULT, etc.)
    mercado = Column(String(20), nullable=False, default="DEFAULT")
    nro_secuencia = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    # Settlement fields
    fecha_liquidacion       = Column(Date, nullable=True)
    liquidada               = Column(Boolean, nullable=False, default=False)
    # Bilateral confirmation fields
    contraparte_id          = Column(Integer, ForeignKey("contrapartes.id"), nullable=True)
    requiere_confirmacion   = Column(Boolean, nullable=False, default=False)

    orden        = relationship("Orden", back_populates="ejecuciones")
    comision     = relationship("Comision", back_populates="ejecucion", uselist=False)
    confirmacion = relationship("Confirmacion", back_populates="ejecucion", uselist=False)
    contraparte  = relationship("Contraparte")

    def to_dict(self) -> dict:
        d: dict = {
            "id": self.id,
            "fecha": self.fecha.strftime("%d/%m/%Y") if self.fecha else None,
            "cantidad": self.cantidad,
            "precio": self.precio,
            "mercado": self.mercado,
            "nro_secuencia": self.nro_secuencia,
            "fecha_liquidacion": (
                self.fecha_liquidacion.strftime("%d/%m/%Y") if self.fecha_liquidacion else None
            ),
            "liquidada": self.liquidada,
            "contraparte_id": self.contraparte_id,
            "contraparte_codigo": (
                self.contraparte.codigo if self.contraparte else None
            ),
            "requiere_confirmacion": self.requiere_confirmacion,
        }
        if self.comision:
            d["comision"] = self.comision.to_dict()
        if self.confirmacion:
            d["confirmacion"] = self.confirmacion.to_dict()
        return d
