from datetime import date
from pydantic import BaseModel, Field


class InstrumentoCreate(BaseModel):
    especie: str = Field(..., min_length=1, max_length=20)
    tipo: str = Field(..., min_length=1, max_length=20)
    moneda: str = Field(default="ARP", min_length=1, max_length=5)
    mercado_principal: str | None = Field(default=None, max_length=20)
    descripcion: str | None = Field(default=None, max_length=500)


class InstrumentoUpdate(BaseModel):
    descripcion: str | None = None
    mercado_principal: str | None = None
    activo: bool | None = None


class RentaFijaUpsert(BaseModel):
    tir_referencia: float | None = None
    duration: float | None = None
    fecha_vencimiento: date | None = None
    precio_sucio: float | None = None
    precio_limpio: float | None = None
    tasa_cupon: float | None = None
    frecuencia_cupon: str | None = None
    amortiza: bool = False
    moneda_emision: str | None = None
    emisor: str | None = None


class FuturoUpsert(BaseModel):
    contrato: str | None = None
    activo_subyacente: str | None = None
    mes_vencimiento: date | None = None
    precio_ajuste: float | None = None
    margen_inicial: float | None = None
    margen_variacion: float | None = None
    tick_size: float | None = None
    multiplicador: float = 1.0


class LlamadoMargenCreate(BaseModel):
    cuenta_id: int
    fecha: date
    monto: float
    descripcion: str | None = None
