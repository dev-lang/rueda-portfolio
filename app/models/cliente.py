from sqlalchemy import Column, Integer, String, Boolean, DateTime
from datetime import datetime, timezone
from app.db.base import Base


class Cliente(Base):
    __tablename__ = "clientes"

    id              = Column(Integer, primary_key=True)
    codigo          = Column(String(20), unique=True, nullable=False, index=True)
    nombre          = Column(String(100), nullable=False)
    razon_social    = Column(String(200), nullable=False)
    activo          = Column(Boolean, default=True, nullable=False)
    # Marks the fund's own proprietary book (cartera propia vs. terceros)
    es_cartera_propia = Column(Boolean, default=False, nullable=False)
    # PEP — Persona Expuesta Políticamente (UIF/UIAF compliance)
    es_pep          = Column(Boolean, default=False, nullable=False)
    created_at      = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    updated_at      = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), onupdate=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    def to_dict(self) -> dict:
        return {
            "id":               self.id,
            "codigo":           self.codigo,
            "nombre":           self.nombre,
            "razon_social":     self.razon_social,
            "activo":           self.activo,
            "es_cartera_propia": self.es_cartera_propia,
            "es_pep":           self.es_pep,
            "created_at": (
                self.created_at.strftime("%d/%m/%Y %H:%M:%S") if self.created_at else None
            ),
        }
