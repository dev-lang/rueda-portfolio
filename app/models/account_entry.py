from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, DateTime, Numeric, ForeignKey, Boolean, Date
from sqlalchemy.orm import relationship

from app.db.base import Base

# Valid entry types
TIPOS_ENTRY = frozenset({
    "DEPOSITO",          # manual cash deposit
    "RETIRO",            # manual cash withdrawal
    "COMPRA",            # cash paid for a buy execution
    "VENTA",             # cash received from a sell execution
    "COMISION",          # commission charged on an execution
    "AJUSTE_CREDITO",    # manual credit adjustment (ADMIN only)
    "AJUSTE_DEBITO",     # manual debit adjustment (ADMIN only)
    "BOT_ASIGNACION",    # initial capital assigned to a bot account
    "BOT_DEVOLUCION",    # capital returned from bot account to origin
    # ── Order reservation lifecycle ──────────────────────────────────────────
    "RESERVA_COMPRA",    # DEBIT: cash reserved when a buy order is created
    "APLICACION_RESERVA",# CREDIT: releases reservation proportionally on fill
    "LIBERACION_RESERVA",# CREDIT: releases remaining reservation on cancel/expire
})

SENTIDOS = frozenset({"CREDIT", "DEBIT"})


class AccountEntry(Base):
    """
    Immutable ledger line for an Account.

    Rules:
      - Never updated or deleted after creation.
      - monto is always positive; direction is determined by sentido.
      - balance_post records the account balance after this entry — used
        for point-in-time balance reconstruction without full replay.
      - ref_type + ref_id link back to the originating domain object
        (ejecucion, orden, manual, bot_asignacion, …).
    """
    __tablename__ = "account_entries"

    id           = Column(Integer, primary_key=True)
    account_id   = Column(Integer, ForeignKey("accounts.id"), nullable=False, index=True)
    tipo         = Column(String(20), nullable=False)        # TIPOS_ENTRY
    monto        = Column(Numeric(18, 6), nullable=False)    # always positive
    sentido      = Column(String(6),  nullable=False)        # CREDIT | DEBIT
    balance_post = Column(Numeric(18, 6), nullable=False)    # balance after this entry
    # Optional back-reference to the originating object
    ref_type     = Column(String(30), nullable=True)         # "ejecucion" | "orden" | "manual" | …
    ref_id       = Column(Integer,    nullable=True)
    descripcion  = Column(String(300), nullable=True)
    usuario      = Column(String(50), nullable=False, default="sistema")
    created_at   = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), index=True)
    # Settlement fields — existing rows are treated as already settled (default True)
    fecha_liquidacion = Column(DateTime, nullable=True)
    liquidada         = Column(Boolean, nullable=False, default=True)

    account = relationship("Account", back_populates="entries")

    def to_dict(self) -> dict:
        return {
            "id":                 self.id,
            "account_id":         self.account_id,
            "tipo":               self.tipo,
            "monto":              float(self.monto or 0),
            "sentido":            self.sentido,
            "balance_post":       float(self.balance_post or 0),
            "ref_type":           self.ref_type,
            "ref_id":             self.ref_id,
            "descripcion":        self.descripcion,
            "usuario":            self.usuario,
            "fecha_liquidacion":  (
                self.fecha_liquidacion.strftime("%d/%m/%Y") if self.fecha_liquidacion else None
            ),
            "liquidada":          self.liquidada,
            "created_at":         (
                self.created_at.strftime("%d/%m/%Y %H:%M:%S") if self.created_at else None
            ),
        }
