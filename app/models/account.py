from decimal import Decimal
from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, Boolean, DateTime, Numeric, UniqueConstraint
from sqlalchemy.orm import relationship

from app.db.base import Base


class Account(Base):
    """
    Cash account for a single entity (cliente, bot) in a single currency/market.

    Owner resolution:
        owner_type="cliente"  →  owner_id = Cliente.id
        owner_type="bot"      →  owner_id = BotInstancia.id

    balance_cache is always derived from AccountEntry rows. It is updated
    atomically on every entry creation (SELECT FOR UPDATE on account row).
    Use the reconciliar() service function to verify/fix any drift.
    """
    __tablename__ = "accounts"

    id             = Column(Integer, primary_key=True)
    owner_type     = Column(String(20), nullable=False, index=True)   # "cliente" | "bot"
    owner_id       = Column(Integer,    nullable=False, index=True)
    moneda         = Column(String(5),  nullable=False, default="ARP")
    mercado        = Column(String(20), nullable=False, default="DEFAULT")
    # Cached running balance — updated atomically with each AccountEntry
    balance_cache  = Column(Numeric(18, 6), nullable=False, default=Decimal("0"))
    # Sum of pending (unsettled) debit entries — cash committed but not yet final
    balance_reservado = Column(Numeric(18, 6), nullable=False, default=Decimal("0"))
    # Immutable baseline — set at account creation, never changed by entries
    capital_inicial = Column(Numeric(18, 6), nullable=False, default=Decimal("0"))
    activa         = Column(Boolean, default=True, nullable=False)
    created_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    updated_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), onupdate=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    __table_args__ = (
        UniqueConstraint("owner_type", "owner_id", "moneda", "mercado", name="uq_account_owner"),
    )

    entries = relationship(
        "AccountEntry", back_populates="account", cascade="all, delete-orphan",
        order_by="AccountEntry.id",
    )

    @property
    def saldo_disponible(self) -> "Decimal":
        """Balance available for new orders (excludes pending/unsettled debits)."""
        from decimal import Decimal
        return (self.balance_cache or Decimal("0")) - (self.balance_reservado or Decimal("0"))

    def to_dict(self) -> dict:
        return {
            "id":                 self.id,
            "owner_type":         self.owner_type,
            "owner_id":           self.owner_id,
            "moneda":             self.moneda,
            "mercado":            self.mercado,
            "balance_cache":      float(self.balance_cache or 0),
            "balance_reservado":  float(self.balance_reservado or 0),
            "saldo_disponible":   float(self.saldo_disponible),
            "capital_inicial":    float(self.capital_inicial or 0),
            "activa":             self.activa,
            "created_at":         (
                self.created_at.strftime("%d/%m/%Y %H:%M:%S") if self.created_at else None
            ),
        }
