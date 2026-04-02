from pydantic import BaseModel


class EjecucionRead(BaseModel):
    id: int
    fecha: str
    cantidad: int
    precio: float
    mercado: str
    nro_secuencia: int

    class Config:
        from_attributes = True


class OrdenConEjecuciones(BaseModel):
    orden: dict
    ejecuciones: list[EjecucionRead]
