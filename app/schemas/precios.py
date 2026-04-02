from datetime import date
from pydantic import BaseModel, field_validator

_TIPOS_AJUSTE = {"AJUSTE", "CORTE_MAE", "CIERRE"}


class PrecioManualRequest(BaseModel):
    especie: str
    precio: float

    @field_validator("precio")
    @classmethod
    def precio_positivo(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("precio debe ser mayor a 0")
        return v

    @field_validator("especie")
    @classmethod
    def especie_upper(cls, v: str) -> str:
        return v.upper().strip()


class CierreAjusteRequest(BaseModel):
    especie:     str
    precio:      float
    fecha:       date
    precio_tipo: str = "AJUSTE"   # AJUSTE | CORTE_MAE | CIERRE
    fuente:      str = "manual"   # BYMA | ROFEX | MAE | manual

    @field_validator("precio")
    @classmethod
    def precio_positivo(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("precio debe ser mayor a 0")
        return v

    @field_validator("especie")
    @classmethod
    def especie_upper(cls, v: str) -> str:
        return v.upper().strip()

    @field_validator("precio_tipo")
    @classmethod
    def tipo_valido(cls, v: str) -> str:
        if v.upper() not in _TIPOS_AJUSTE:
            raise ValueError(f"precio_tipo debe ser uno de: {', '.join(sorted(_TIPOS_AJUSTE))}")
        return v.upper()
