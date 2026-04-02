from pydantic import BaseModel, field_validator


class EjecutarOrdenRequest(BaseModel):
    orden_id: int
    cantidad: int
    precio: float
    mercado: str = "DEFAULT"
    contraparte_id: int | None = None

    @field_validator("cantidad")
    @classmethod
    def cantidad_positiva(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("cantidad debe ser mayor a 0")
        return v

    @field_validator("precio")
    @classmethod
    def precio_positivo(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("precio debe ser mayor a 0")
        return v

    @field_validator("mercado")
    @classmethod
    def mercado_upper(cls, v: str) -> str:
        return v.upper().strip()


class EjecutarOrdenResponse(BaseModel):
    success: bool
    orden: dict
    ejecucion: dict
    mensaje: str


class RechazarRequest(BaseModel):
    motivo: str
