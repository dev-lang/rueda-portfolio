from datetime import date
from pydantic import BaseModel, field_validator, model_validator
from typing import Optional


class OrdenCreate(BaseModel):
    tipo_orden: str = "LIMC"
    cliente: str
    razon_social: str
    especie: str
    moneda: str = "ARP"
    # Nullable for MERCADO orders; required for LIMITE orders
    precio_limite: Optional[float] = None
    cantidad_total: int

    # Feature 11A — Advanced order types
    tipo_precio: str = "LIMITE"           # LIMITE | MERCADO
    time_in_force: str = "DAY"            # DAY | IOC | FOK | GTD
    fecha_exp: Optional[date] = None      # GTD expiry

    # Feature 11B — Iceberg
    cantidad_visible: Optional[int] = None

    # Feature 11C — Stop / Take-profit
    tipo_activacion: Optional[str] = None   # STOP_LOSS | TAKE_PROFIT
    precio_activacion: Optional[float] = None

    # Feature 15 — desk override (if omitted, auto-derived from Operador.desk)
    desk: Optional[str] = None

    @field_validator("precio_limite")
    @classmethod
    def precio_positivo(cls, v: float | None) -> float | None:
        if v is not None and v <= 0:
            raise ValueError("precio_limite debe ser mayor a 0")
        return v

    @field_validator("cantidad_total")
    @classmethod
    def cantidad_positiva(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("cantidad_total debe ser mayor a 0")
        return v

    @field_validator("especie")
    @classmethod
    def especie_upper(cls, v: str) -> str:
        return v.upper().strip()

    @field_validator("tipo_orden")
    @classmethod
    def tipo_valido(cls, v: str) -> str:
        allowed = {"LIMC", "LIMV"}
        if v.upper() not in allowed:
            raise ValueError(f"tipo_orden debe ser uno de: {', '.join(sorted(allowed))}")
        return v.upper()

    @field_validator("moneda")
    @classmethod
    def moneda_valida(cls, v: str) -> str:
        allowed = {"ARP", "USD", "EUR"}
        if v.upper() not in allowed:
            raise ValueError(f"moneda debe ser una de: {', '.join(sorted(allowed))}")
        return v.upper()

    @field_validator("tipo_precio")
    @classmethod
    def tipo_precio_valido(cls, v: str) -> str:
        allowed = {"LIMITE", "MERCADO"}
        if v.upper() not in allowed:
            raise ValueError(f"tipo_precio debe ser uno de: {', '.join(sorted(allowed))}")
        return v.upper()

    @field_validator("time_in_force")
    @classmethod
    def tif_valido(cls, v: str) -> str:
        allowed = {"DAY", "IOC", "FOK", "GTD"}
        if v.upper() not in allowed:
            raise ValueError(f"time_in_force debe ser uno de: {', '.join(sorted(allowed))}")
        return v.upper()

    @field_validator("tipo_activacion")
    @classmethod
    def activacion_valida(cls, v: str | None) -> str | None:
        if v is None:
            return v
        allowed = {"STOP_LOSS", "TAKE_PROFIT"}
        if v.upper() not in allowed:
            raise ValueError(f"tipo_activacion debe ser uno de: {', '.join(sorted(allowed))}")
        return v.upper()

    @field_validator("cantidad_visible")
    @classmethod
    def visible_positivo(cls, v: int | None) -> int | None:
        if v is not None and v <= 0:
            raise ValueError("cantidad_visible debe ser mayor a 0")
        return v

    @model_validator(mode="after")
    def validar_precio_segun_tipo(self) -> "OrdenCreate":
        if self.tipo_precio == "LIMITE" and self.precio_limite is None:
            raise ValueError("precio_limite es requerido para órdenes de tipo LIMITE")
        if self.time_in_force == "GTD" and self.fecha_exp is None:
            raise ValueError("fecha_exp es requerida para órdenes GTD")
        if self.tipo_activacion is not None and self.precio_activacion is None:
            raise ValueError("precio_activacion es requerido cuando se especifica tipo_activacion")
        if self.cantidad_visible is not None and self.cantidad_visible >= self.cantidad_total:
            raise ValueError("cantidad_visible debe ser menor que cantidad_total")
        return self


class OrdenRead(BaseModel):
    id: int
    nro_orden: str
    tipo_orden: str
    fecha_orden: str
    hora: Optional[str] = None
    cliente: str
    razon_social: str
    especie: str
    moneda: str
    tipo_precio: str
    precio_limite: Optional[float]
    cantidad_total: int
    cantidad_ejecutada: int
    precio_promedio: float
    instancia: str
    instancia_codigo: int
    estado_color: str
    progreso: float
    ejecutado_total: str
    usuario: Optional[str] = None
    time_in_force: str
    fecha_exp: Optional[str] = None
    cantidad_visible: Optional[int] = None
    tipo_activacion: Optional[str] = None
    precio_activacion: Optional[float] = None
    activa: bool
    desk: Optional[str] = None

    class Config:
        from_attributes = True


class OrdenListResponse(BaseModel):
    ordenes: list[OrdenRead]
    total: int
    pages: int
    current_page: int
    per_page: int


class OrdenModify(BaseModel):
    """Partial update: only provided fields are changed."""
    precio_limite: Optional[float] = None
    cantidad_total: Optional[int] = None

    @field_validator("precio_limite")
    @classmethod
    def precio_positivo(cls, v: float | None) -> float | None:
        if v is not None and v <= 0:
            raise ValueError("precio_limite debe ser mayor a 0")
        return v

    @field_validator("cantidad_total")
    @classmethod
    def cantidad_positiva(cls, v: int | None) -> int | None:
        if v is not None and v <= 0:
            raise ValueError("cantidad_total debe ser mayor a 0")
        return v
