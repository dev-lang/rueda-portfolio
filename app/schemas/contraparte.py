from decimal import Decimal
from pydantic import BaseModel, Field, field_validator


class ContraparteCreate(BaseModel):
    codigo: str = Field(..., min_length=1, max_length=20)
    nombre: str = Field(..., min_length=1, max_length=100)
    tipo: str

    @field_validator("tipo")
    @classmethod
    def tipo_valido(cls, v: str) -> str:
        validos = {"BROKER", "BANCO", "AGENTE_EXTERNO", "MAE_PARTICIPANTE", "ROFEX_CLEARING"}
        v = v.upper().strip()
        if v not in validos:
            raise ValueError(f"tipo debe ser uno de: {', '.join(sorted(validos))}")
        return v

    @field_validator("codigo")
    @classmethod
    def codigo_upper(cls, v: str) -> str:
        return v.upper().strip()


class ContraparteUpdate(BaseModel):
    nombre: str | None = None
    activo: bool | None = None


class LimiteCreditoUpsert(BaseModel):
    moneda: str = "ARP"
    limite: Decimal
    alerta_pct: Decimal = Decimal("80.00")

    @field_validator("limite")
    @classmethod
    def limite_no_negativo(cls, v: Decimal) -> Decimal:
        if v < 0:
            raise ValueError("El límite no puede ser negativo.")
        return v
