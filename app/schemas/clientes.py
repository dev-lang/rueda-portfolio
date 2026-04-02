from pydantic import BaseModel, Field
from typing import Optional


class ClienteCreate(BaseModel):
    codigo: str = Field(..., min_length=1, max_length=20)
    nombre: str = Field(..., min_length=1, max_length=100)
    razon_social: str = Field(..., min_length=1, max_length=200)


class ClienteUpdate(BaseModel):
    nombre: Optional[str] = Field(default=None, min_length=1, max_length=100)
    razon_social: Optional[str] = Field(default=None, min_length=1, max_length=200)
    activo: Optional[bool] = None
