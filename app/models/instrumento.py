"""
Instrument catalog — extends EspecieMercado with financial type classification
and type-specific attributes.

Supported types:
  ACCION        — listed equity (BYMA/MERVAL)
  RENTA_FIJA    — bonds: ON, Lecap, Lete, Lede, sovereign bonds
  FUTURO        — ROFEX futures (Dólar, Soja, etc.)
  CAUCION       — repurchase agreements (caución bursátil)
  CPD           — cheques de pago diferido
  FX            — FX pairs: CCL, MEP, CABLE
  OTRO          — catch-all for instruments not fitting above

Subtable relationships:
  RentaFijaDetalle    (uselist=False) — bond attributes
  FuturoRofexDetalle  (uselist=False) — futures contract attributes
  LlamadoMargen       — margin call records (ROFEX only)
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, Date, DateTime, Float, ForeignKey,
    Integer, String, UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.db.base import Base

TIPOS_INSTRUMENTO = frozenset({
    "ACCION",
    "RENTA_FIJA",
    "FUTURO",
    "CAUCION",
    "CPD",
    "FX",
    "OTRO",
})

ESTADOS_LLAMADO = frozenset({"PENDIENTE", "INTEGRADO", "VENCIDO"})


# ── Main catalog ──────────────────────────────────────────────────────────────

class Instrumento(Base):
    """
    One row per tradeable instrument. Linked to EspecieMercado via especie.
    Contains type classification and human-readable description.
    """
    __tablename__ = "instrumentos"

    id                = Column(Integer, primary_key=True)
    especie           = Column(
        String(20), ForeignKey("especies_mercado.especie"),
        unique=True, nullable=False, index=True,
    )
    tipo              = Column(String(20), nullable=False)       # TIPOS_INSTRUMENTO
    moneda            = Column(String(5),  nullable=False, default="ARP")
    mercado_principal = Column(String(20), nullable=True)
    descripcion       = Column(String(300), nullable=True)
    activo            = Column(Boolean, nullable=False, default=True)
    created_at        = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    renta_fija    = relationship(
        "RentaFijaDetalle", back_populates="instrumento",
        uselist=False, cascade="all, delete-orphan",
    )
    futuro        = relationship(
        "FuturoRofexDetalle", back_populates="instrumento",
        uselist=False, cascade="all, delete-orphan",
    )
    llamados_margen = relationship(
        "LlamadoMargen", back_populates="instrumento",
        cascade="all, delete-orphan",
        order_by="LlamadoMargen.fecha.desc()",
    )

    def to_dict(self) -> dict:
        d: dict = {
            "id":                self.id,
            "especie":           self.especie,
            "tipo":              self.tipo,
            "moneda":            self.moneda,
            "mercado_principal": self.mercado_principal,
            "descripcion":       self.descripcion,
            "activo":            self.activo,
        }
        if self.renta_fija:
            d["renta_fija"] = self.renta_fija.to_dict()
        if self.futuro:
            d["futuro"] = self.futuro.to_dict()
        return d


# ── Fixed income detail ───────────────────────────────────────────────────────

class RentaFijaDetalle(Base):
    """
    Bond / fixed-income attributes.
    tir_referencia: yield to maturity (%).
    duration: modified duration in years.
    precio_limpio/sucio: clean and dirty price (including accrued interest).
    """
    __tablename__ = "renta_fija_detalle"

    id                = Column(Integer, primary_key=True)
    instrumento_id    = Column(
        Integer, ForeignKey("instrumentos.id"),
        unique=True, nullable=False,
    )
    tir_referencia    = Column(Float,   nullable=True)    # yield to maturity (%)
    duration          = Column(Float,   nullable=True)    # modified duration (years)
    fecha_vencimiento = Column(Date,    nullable=True)
    precio_sucio      = Column(Float,   nullable=True)    # dirty price
    precio_limpio     = Column(Float,   nullable=True)    # clean price (excl. accrued)
    tasa_cupon        = Column(Float,   nullable=True)    # annual coupon rate (%)
    frecuencia_cupon  = Column(String(20), nullable=True) # MENSUAL|TRIMESTRAL|SEMESTRAL|ANUAL
    amortiza          = Column(Boolean, nullable=False, default=False)
    moneda_emision    = Column(String(5),   nullable=True)
    emisor            = Column(String(100), nullable=True)

    instrumento = relationship("Instrumento", back_populates="renta_fija")

    def to_dict(self) -> dict:
        return {
            "tir_referencia":    self.tir_referencia,
            "duration":          self.duration,
            "fecha_vencimiento": self.fecha_vencimiento.isoformat() if self.fecha_vencimiento else None,
            "precio_sucio":      self.precio_sucio,
            "precio_limpio":     self.precio_limpio,
            "tasa_cupon":        self.tasa_cupon,
            "frecuencia_cupon":  self.frecuencia_cupon,
            "amortiza":          self.amortiza,
            "moneda_emision":    self.moneda_emision,
            "emisor":            self.emisor,
        }


# ── ROFEX futures detail ──────────────────────────────────────────────────────

class FuturoRofexDetalle(Base):
    """
    ROFEX futures contract attributes.
    precio_ajuste: daily settlement price (updated EOD by operator or feed).
    margen_inicial / margen_variacion: per-contract margin requirements in ARS.
    multiplicador: contract size (e.g. 1000 USD per Dólar contract).
    """
    __tablename__ = "futuro_rofex_detalle"

    id                = Column(Integer, primary_key=True)
    instrumento_id    = Column(
        Integer, ForeignKey("instrumentos.id"),
        unique=True, nullable=False,
    )
    contrato          = Column(String(20),  nullable=True)   # e.g. "RFX20Ago25"
    activo_subyacente = Column(String(50),  nullable=True)   # e.g. "Dólar", "Soja"
    mes_vencimiento   = Column(Date,        nullable=True)   # expiry month first day
    precio_ajuste     = Column(Float,       nullable=True)   # daily settlement price
    margen_inicial    = Column(Float,       nullable=True)   # initial margin per contract (ARS)
    margen_variacion  = Column(Float,       nullable=True)   # variation margin (ARS)
    tick_size         = Column(Float,       nullable=True)   # min price movement
    multiplicador     = Column(Float,       nullable=False, default=1.0)

    instrumento = relationship("Instrumento", back_populates="futuro")

    def to_dict(self) -> dict:
        return {
            "contrato":          self.contrato,
            "activo_subyacente": self.activo_subyacente,
            "mes_vencimiento":   self.mes_vencimiento.isoformat() if self.mes_vencimiento else None,
            "precio_ajuste":     self.precio_ajuste,
            "margen_inicial":    self.margen_inicial,
            "margen_variacion":  self.margen_variacion,
            "tick_size":         self.tick_size,
            "multiplicador":     self.multiplicador,
        }


# ── Margin calls ──────────────────────────────────────────────────────────────

class LlamadoMargen(Base):
    """
    Daily margin call for a ROFEX position.
    Generated after EOD settlement price update.
    Estado: PENDIENTE → INTEGRADO (paid) or VENCIDO (unpaid past deadline).
    """
    __tablename__ = "llamados_margen"

    id             = Column(Integer, primary_key=True)
    instrumento_id = Column(Integer, ForeignKey("instrumentos.id"), nullable=False, index=True)
    cuenta_id      = Column(Integer, ForeignKey("accounts.id"),     nullable=False, index=True)
    fecha          = Column(Date,    nullable=False, index=True)
    monto          = Column(Float,   nullable=False)              # amount required (ARS)
    estado         = Column(String(20), nullable=False, default="PENDIENTE")
    descripcion    = Column(String(300), nullable=True)
    usuario        = Column(String(50),  nullable=False, default="sistema")
    created_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    instrumento = relationship("Instrumento", back_populates="llamados_margen")

    def to_dict(self) -> dict:
        return {
            "id":             self.id,
            "instrumento_id": self.instrumento_id,
            "cuenta_id":      self.cuenta_id,
            "fecha":          self.fecha.isoformat() if self.fecha else None,
            "monto":          round(self.monto, 2),
            "estado":         self.estado,
            "descripcion":    self.descripcion,
            "usuario":        self.usuario,
            "created_at":     self.created_at.strftime("%d/%m/%Y %H:%M:%S") if self.created_at else None,
        }
