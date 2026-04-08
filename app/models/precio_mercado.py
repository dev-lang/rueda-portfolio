from sqlalchemy import Column, Integer, String, Float, DateTime, Date
from datetime import datetime, timezone
from app.db.base import Base


class PrecioMercado(Base):
    """
    Last known market price per instrument (especie).

    One row per especie, upserted on each feed refresh.
    fuente: "yfinance" for auto-fetched prices, "manual" for operator-entered.
    variacion_pct: % change vs the previous stored price.
    volumen_dia / vwap: intraday volume and volume-weighted average price;
        reset to 0 whenever fecha_volumen != today.

    OHLC fields store daily price ranges for watchlist tracking.
    """

    __tablename__ = "precios_mercado"

    id = Column(Integer, primary_key=True)
    especie = Column(String(20), nullable=False, unique=True, index=True)
    precio = Column(Float, nullable=False)
    precio_anterior = Column(Float)        # price before last update
    variacion_pct = Column(Float)          # (precio - precio_anterior) / precio_anterior * 100
    fuente = Column(String(20), default="manual")   # "yfinance" | "manual"
    last_updated = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), onupdate=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    # ── Intraday volume & VWAP ─────────────────────────────────────────────────
    volumen_dia = Column(Integer, default=0, nullable=False)
    vwap = Column(Float, default=0.0, nullable=False)
    fecha_volumen = Column(Date, nullable=True)  # date the counters belong to

    # ── Daily OHLC (Open, High, Low, Close) ────────────────────────────────────
    precio_apertura = Column(Float, nullable=True)   # Open price (today)
    precio_cierre = Column(Float, nullable=True)     # Close price (previous day or last known close)
    precio_minimo = Column(Float, nullable=True)     # Low price (today)
    precio_maximo = Column(Float, nullable=True)     # High price (today)
    fecha_ohlc = Column(Date, nullable=True)         # Date these OHLC values belong to

    def to_dict(self) -> dict:
        return {
            "especie": self.especie,
            "precio": self.precio,
            "precio_anterior": self.precio_anterior,
            "variacion_pct": round(self.variacion_pct, 2) if self.variacion_pct is not None else None,
            "fuente": self.fuente,
            "last_updated": (
                self.last_updated.strftime("%H:%M:%S")
                if self.last_updated else None
            ),
            "volumen_dia": self.volumen_dia or 0,
            "vwap": round(self.vwap, 4) if self.vwap else 0.0,
            "precio_apertura": self.precio_apertura,
            "precio_cierre": self.precio_cierre,
            "precio_minimo": self.precio_minimo,
            "precio_maximo": self.precio_maximo,
            "fecha_ohlc": self.fecha_ohlc.isoformat() if self.fecha_ohlc else None,
        }
