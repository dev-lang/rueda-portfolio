from pydantic import BaseModel, Field


class OperadorCreate(BaseModel):
    nombre:         str = Field(..., min_length=2, max_length=100)
    username:       str = Field(..., min_length=2, max_length=50)
    desk:           str = Field(..., description="ACCIONES | RENTA_FIJA | DERIVADOS | FCI")
    cliente_codigo: str | None = Field(default=None, max_length=20)


class OperadorUpdate(BaseModel):
    nombre:         str | None = Field(default=None, min_length=2, max_length=100)
    desk:           str | None = None
    activo:         bool | None = None
    cliente_codigo: str | None = None
