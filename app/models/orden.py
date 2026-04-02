from sqlalchemy import Column, Integer, String, Float, Date, DateTime, Boolean, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.db.base import Base


class Orden(Base):
    __tablename__ = "ordenes"

    id = Column(Integer, primary_key=True)
    nro_orden = Column(String(20), unique=True, nullable=False, index=True)
    tipo_orden = Column(String(10), nullable=False)
    fecha_orden = Column(Date, nullable=False)
    cliente = Column(String(20), nullable=False, index=True)
    razon_social = Column(String(100), nullable=False)
    especie = Column(String(20), nullable=False, index=True)
    moneda = Column(String(5), nullable=False)
    # precio_limite nullable for MERCADO orders
    precio_limite = Column(Float, nullable=True)
    cantidad_total = Column(Integer, nullable=False)
    cantidad_ejecutada = Column(Integer, default=0, nullable=False)
    precio_promedio = Column(Float, default=0.0, nullable=False)
    instancia = Column(String(50), nullable=False)
    instancia_codigo = Column(Integer, default=9)
    estado_color = Column(String(20), default="green")
    # Optimistic locking: bump on every execution to detect concurrent writes
    version = Column(Integer, default=1, nullable=False)
    # Set when the order was created by a market bot instance (NULL = human)
    bot_id = Column(Integer, ForeignKey("bot_instancias.id"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    # ── Feature 10: Blotter ────────────────────────────────────────────────
    # Operator who submitted the order (NULL = bot or legacy rows)
    usuario = Column(String(50), nullable=True)
    # Feature 15 — desk / cost center (ACCIONES|RENTA_FIJA|DERIVADOS|FCI)
    desk = Column(String(15), nullable=True)

    # ── Feature 11A: Advanced order types ─────────────────────────────────
    # LIMITE (default) or MERCADO (market order — fills at best available price)
    tipo_precio = Column(String(10), nullable=False, default="LIMITE")
    # Time-in-force: DAY (default), IOC, FOK, GTD
    time_in_force = Column(String(5), nullable=False, default="DAY")
    # Expiry date for GTD orders; NULL for non-GTD
    fecha_exp = Column(Date, nullable=True)

    # ── Feature 11B: Iceberg ───────────────────────────────────────────────
    # Visible quantity shown in orderbook; NULL = not an iceberg order
    cantidad_visible = Column(Integer, nullable=True)

    # ── Feature 11C: Stop-loss / Take-profit ───────────────────────────────
    # STOP_LOSS | TAKE_PROFIT; NULL = unconditional order
    tipo_activacion = Column(String(15), nullable=True)
    # Price threshold that triggers this order
    precio_activacion = Column(Float, nullable=True)
    # False = waiting for activation trigger; True = active/normal
    activa = Column(Boolean, nullable=False, default=True)

    ejecuciones = relationship(
        "Ejecucion", back_populates="orden", cascade="all, delete-orphan"
    )

    def to_dict(self) -> dict:
        progreso = (
            (self.cantidad_ejecutada / self.cantidad_total * 100)
            if self.cantidad_total > 0
            else 0
        )
        return {
            "id": self.id,
            "nro_orden": self.nro_orden,
            "tipo_orden": self.tipo_orden,
            "fecha_orden": self.fecha_orden.strftime("%d/%m/%Y") if self.fecha_orden else None,
            "hora": self.created_at.strftime("%H:%M:%S") if self.created_at else None,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else None,
            "cliente": self.cliente,
            "razon_social": self.razon_social,
            "especie": self.especie,
            "moneda": self.moneda,
            "tipo_precio": self.tipo_precio or "LIMITE",
            "precio_limite": self.precio_limite,
            "cantidad_total": self.cantidad_total,
            "cantidad_ejecutada": self.cantidad_ejecutada,
            "precio_promedio": self.precio_promedio,
            "instancia": self.instancia,
            "instancia_codigo": self.instancia_codigo,
            "estado_color": self.estado_color,
            "progreso": round(progreso, 1),
            "ejecutado_total": f"{self.cantidad_ejecutada:,}/{self.cantidad_total:,}",
            "usuario": self.usuario,
            "time_in_force": self.time_in_force or "DAY",
            "fecha_exp": self.fecha_exp.strftime("%d/%m/%Y") if self.fecha_exp else None,
            "cantidad_visible": self.cantidad_visible,
            "tipo_activacion": self.tipo_activacion,
            "precio_activacion": self.precio_activacion,
            "activa": self.activa if self.activa is not None else True,
            "desk": self.desk,
        }
