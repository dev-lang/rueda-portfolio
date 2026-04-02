from sqlalchemy import Column, Integer, String, Boolean, Float, DateTime, ForeignKey
from datetime import datetime, timezone
from app.db.base import Base

# Valid order types that bots can be configured to use
TIPOS_ORDEN_VALIDOS = ("LIMC", "LIMV")
# LIMC → buy side   |   LIMV → sell side
TIPOS_COMPRA = {"LIMC"}
TIPOS_VENTA  = {"LIMV"}

PERFILES_VALIDOS = ("CONSERVADOR", "MODERADO", "AGRESIVO", "TRADER")


class BotInstancia(Base):
    """
    Persistent configuration for a single market-simulation bot.
    Multiple instances can run simultaneously, each with its own
    interval, variance, order-type whitelist, pending-order cap, and
    behavioral profile (CONSERVADOR / MODERADO / AGRESIVO).
    """
    __tablename__ = "bot_instancias"

    id          = Column(Integer, primary_key=True)
    nombre      = Column(String(50), unique=True, nullable=False)
    enabled     = Column(Boolean, default=True, nullable=False)
    # Seconds between price-movement + order-injection ticks
    interval    = Column(Float, default=5.0, nullable=False)
    # Maximum price swing per tick as a fraction (0.008 = ±0.8 %)
    variance    = Column(Float, default=0.008, nullable=False)
    # Hard cap on pending (non-executed/non-cancelled) orders for this bot
    max_ordenes = Column(Integer, default=20, nullable=False)
    # Allowed order types: "LIMC" (buy), "LIMV" (sell), or "LIMC,LIMV" (both)
    tipos_orden = Column(String(50), default="LIMC,LIMV", nullable=False)

    # ── Behavioral profile ───────────────────────────────────────────────────
    # CONSERVADOR / MODERADO / AGRESIVO — drives offset, fill_rate, burst, qty spread
    perfil      = Column(String(20), default="MODERADO", nullable=False)
    # Fraction [0,1]: probability that any one bot order receives a simulated fill
    fill_rate   = Column(Float, default=0.45, nullable=False)
    # Price offset overrides (NULL = use profile defaults)
    offset_min_compra = Column(Float, nullable=True)
    offset_max_compra = Column(Float, nullable=True)
    offset_min_venta  = Column(Float, nullable=True)
    offset_max_venta  = Column(Float, nullable=True)

    # When True the bot only operates Mon–Fri 10:00–17:00 ART (market hours).
    # Set to False to allow the bot to run outside normal market hours.
    respetar_horario = Column(Boolean, default=True, nullable=False)

    # FK to the bot's cash account (set by seed_cuentas / admin endpoint)
    cuenta_id   = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    # ── Per-bot behaviour overrides (NULL = use profile default) ─────────────
    # Max price deviation before cancelling a pending order as stale
    stale_offset_pct    = Column(Float, nullable=True)
    # Max fraction of available balance to allocate per order
    capital_fraccion_max = Column(Float, nullable=True)
    # Accumulation/Distribution cycle length in ticks per phase
    ciclo_min_ticks     = Column(Integer, nullable=True)
    ciclo_max_ticks     = Column(Integer, nullable=True)
    # Fill-reaction probability [0, 1]
    fill_react_prob     = Column(Float, nullable=True)
    # Price markup/markdown on counter-orders
    fill_react_markup   = Column(Float, nullable=True)
    # Probability [0,1] of using MERCADO instead of LIMITE (NULL = use profile default)
    prob_orden_mercado  = Column(Float, nullable=True)

    # ── helpers ──────────────────────────────────────────────────────────────
    def tipos_list(self) -> list[str]:
        return [t.strip().upper() for t in (self.tipos_orden or "").split(",") if t.strip()]

    def to_dict(self) -> dict:
        return {
            "id":                self.id,
            "nombre":            self.nombre,
            "enabled":           self.enabled,
            "interval":          self.interval,
            "variance":          self.variance,
            "max_ordenes":       self.max_ordenes,
            "tipos_orden":       self.tipos_list(),
            "perfil":            self.perfil or "MODERADO",
            "fill_rate":         self.fill_rate if self.fill_rate is not None else 0.45,
            "offset_min_compra": self.offset_min_compra,
            "offset_max_compra": self.offset_max_compra,
            "offset_min_venta":  self.offset_min_venta,
            "offset_max_venta":  self.offset_max_venta,
            "cuenta_id":         self.cuenta_id,
            "created_at":        (
                self.created_at.strftime("%d/%m/%Y %H:%M:%S") if self.created_at else None
            ),
            # Per-bot behaviour overrides (None = use profile default)
            "stale_offset_pct":    self.stale_offset_pct,
            "capital_fraccion_max": self.capital_fraccion_max,
            "ciclo_min_ticks":     self.ciclo_min_ticks,
            "ciclo_max_ticks":     self.ciclo_max_ticks,
            "fill_react_prob":     self.fill_react_prob,
            "fill_react_markup":   self.fill_react_markup,
            "prob_orden_mercado":  self.prob_orden_mercado,
            "respetar_horario":    self.respetar_horario if self.respetar_horario is not None else True,
        }
