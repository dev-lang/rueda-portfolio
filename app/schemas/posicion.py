from pydantic import BaseModel
from typing import Optional


class PosicionRead(BaseModel):
    id: int
    cliente: str
    especie: str
    moneda: str
    mercado: str
    cantidad_comprada: int
    cantidad_vendida: int
    cantidad_neta: int
    costo_promedio_compra: float
    costo_promedio_venta: float
    last_updated: Optional[str]

    class Config:
        from_attributes = True


class PosicionListResponse(BaseModel):
    posiciones: list[PosicionRead]
