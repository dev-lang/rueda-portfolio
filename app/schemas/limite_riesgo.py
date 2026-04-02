from decimal import Decimal
from pydantic import BaseModel, field_validator
from app.models.limite_riesgo import TIPOS_LIMITE


class LimiteRiesgoCreate(BaseModel):
    owner_type: str = "global"
    owner_id: int | None = None
    tipo_limite: str
    especie: str | None = None
    moneda: str = "ARP"
    valor_limite: Decimal
    alerta_pct: Decimal = Decimal("80.0")

    @field_validator("owner_type")
    @classmethod
    def owner_type_valido(cls, v: str) -> str:
        v = v.lower().strip()
        if v not in {"cliente", "global"}:
            raise ValueError("owner_type debe ser 'cliente' o 'global'.")
        return v

    @field_validator("tipo_limite")
    @classmethod
    def tipo_valido(cls, v: str) -> str:
        v = v.upper().strip()
        if v not in TIPOS_LIMITE:
            raise ValueError(f"tipo_limite debe ser uno de: {', '.join(sorted(TIPOS_LIMITE))}")
        return v

    @field_validator("valor_limite")
    @classmethod
    def valor_positivo(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("valor_limite debe ser mayor a 0.")
        return v


class LimiteRiesgoUpdate(BaseModel):
    valor_limite: Decimal | None = None
    alerta_pct: Decimal | None = None
    activo: bool | None = None
