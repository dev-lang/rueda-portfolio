from sqlalchemy import Column, Integer, String, Float, Date, UniqueConstraint
from app.db.base import Base


class PrecioHistorico(Base):
    """
    Daily closing price snapshot per instrument.

    One row per (especie, fecha). Written by the price_feed background task
    once per day, idempotently. Used for historical return calculations and
    benchmark comparisons.
    """

    __tablename__ = "precios_historico"

    id         = Column(Integer, primary_key=True)
    especie    = Column(String(20), nullable=False, index=True)
    fecha      = Column(Date,      nullable=False, index=True)
    precio     = Column(Float,     nullable=False)
    fuente     = Column(String(20), default="yfinance")
    # Feature 16: CIERRE (regular EOD) | AJUSTE (official BYMA/ROFEX) | CORTE_MAE (MAE RF cut-off)
    precio_tipo = Column(String(15), nullable=False, default="CIERRE")

    __table_args__ = (
        # One row per (especie, fecha, precio_tipo) — allows AJUSTE alongside CIERRE on same date
        UniqueConstraint("especie", "fecha", "precio_tipo", name="uq_precio_hist"),
    )
