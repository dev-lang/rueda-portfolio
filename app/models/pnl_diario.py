"""
Daily P&L snapshot per (fecha, cliente, especie, moneda).

Populated by pnl_service.run_cierre_dia() at end of each trading day.

Definitions:
  pnl_realizado    — gain/loss from buy-sell pairs closed intraday (FIFO).
                     Only fills that both open AND close on the same calendar
                     date contribute to this field.
  pnl_no_realizado — mark-to-market on the remaining open position at day close.
                     = cantidad_neta × (precio_cierre - costo_promedio_compra)
  pnl_total        — pnl_realizado + pnl_no_realizado
"""

from datetime import datetime, timezone

from sqlalchemy import Column, Date, DateTime, Float, Integer, String, UniqueConstraint

from app.db.base import Base


class PnlDiario(Base):
    __tablename__ = "pnl_diario"

    id                = Column(Integer, primary_key=True)
    fecha             = Column(Date,   nullable=False, index=True)
    cliente           = Column(String(20), nullable=False, index=True)
    especie           = Column(String(20), nullable=False)
    moneda            = Column(String(5),  nullable=False, default="ARP")

    # Intraday closed P&L
    pnl_realizado     = Column(Float, nullable=False, default=0.0)
    # Open position mark-to-market
    pnl_no_realizado  = Column(Float, nullable=False, default=0.0)
    pnl_total         = Column(Float, nullable=False, default=0.0)

    # Volume traded on this date
    volumen_comprado  = Column(Float, nullable=False, default=0.0)  # ARP notional bought
    volumen_vendido   = Column(Float, nullable=False, default=0.0)  # ARP notional sold

    # Feature 15 — desk attribution for P&L by cost center
    desk              = Column(String(15), nullable=True)

    # Reference prices
    precio_apertura   = Column(Float, nullable=True)   # first fill of the day (or prev close)
    precio_cierre     = Column(Float, nullable=True)   # closing price used for MTM
    costo_promedio    = Column(Float, nullable=True)   # position avg cost at EOD snapshot

    created_at        = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    __table_args__ = (
        UniqueConstraint("fecha", "cliente", "especie", "moneda", name="uq_pnl_diario"),
    )

    def to_dict(self) -> dict:
        return {
            "id":               self.id,
            "fecha":            self.fecha.isoformat() if self.fecha else None,
            "cliente":          self.cliente,
            "especie":          self.especie,
            "moneda":           self.moneda,
            "pnl_realizado":    round(self.pnl_realizado or 0, 2),
            "pnl_no_realizado": round(self.pnl_no_realizado or 0, 2),
            "pnl_total":        round(self.pnl_total or 0, 2),
            "volumen_comprado": round(self.volumen_comprado or 0, 2),
            "volumen_vendido":  round(self.volumen_vendido or 0, 2),
            "precio_apertura":  self.precio_apertura,
            "precio_cierre":    self.precio_cierre,
            "costo_promedio":   self.costo_promedio,
            "desk":             self.desk,
        }
