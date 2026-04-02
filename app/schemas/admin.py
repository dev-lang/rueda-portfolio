from pydantic import BaseModel, Field, field_validator
from typing import Optional, List

from app.models.bot_instancia import TIPOS_ORDEN_VALIDOS, PERFILES_VALIDOS


# ── Ticker schemas ─────────────────────────────────────────────────────────────

class TickerCreate(BaseModel):
    especie: str = Field(..., min_length=1, max_length=20)
    yf_symbol: Optional[str] = Field(default=None, max_length=30)
    panel: str = Field(..., min_length=1, max_length=20)
    nombre: Optional[str] = Field(default=None, max_length=100)


class TickerUpdate(BaseModel):
    yf_symbol: Optional[str] = Field(default=None, max_length=30)
    panel: Optional[str] = Field(default=None, min_length=1, max_length=20)
    activo: Optional[bool] = None
    nombre: Optional[str] = Field(default=None, max_length=100)
    volumen_max_dia: Optional[int] = None      # circuit breaker; 0 = clear limit
    cantidad_max_orden: Optional[int] = None   # max order size; 0 = clear limit


# ── Bot schemas ────────────────────────────────────────────────────────────────

class BotCreate(BaseModel):
    nombre: str = Field(..., min_length=1, max_length=100)
    enabled: bool = True
    interval: float = 5.0
    variance: float = 0.008
    max_ordenes: int = 20
    tipos_orden: List[str] = ["LIMC", "LIMV"]
    perfil: str = "MODERADO"
    fill_rate: float = 0.45
    offset_min_compra: Optional[float] = None
    offset_max_compra: Optional[float] = None
    offset_min_venta: Optional[float] = None
    offset_max_venta: Optional[float] = None
    # Per-bot behaviour overrides (None = inherit from profile)
    stale_offset_pct: Optional[float] = None
    capital_fraccion_max: Optional[float] = None
    ciclo_min_ticks: Optional[int] = None
    ciclo_max_ticks: Optional[int] = None
    fill_react_prob: Optional[float] = None
    fill_react_markup: Optional[float] = None
    prob_orden_mercado: Optional[float] = None
    respetar_horario: bool = True

    @field_validator("tipos_orden")
    @classmethod
    def check_tipos(cls, v: list[str]) -> list[str]:
        invalidos = [t for t in v if t not in TIPOS_ORDEN_VALIDOS]
        if invalidos:
            raise ValueError(f"Tipos inválidos: {invalidos}. Válidos: {list(TIPOS_ORDEN_VALIDOS)}")
        if not v:
            raise ValueError("Debe especificar al menos un tipo de orden.")
        return v

    @field_validator("perfil")
    @classmethod
    def check_perfil(cls, v: str) -> str:
        v = v.upper().strip()
        if v not in PERFILES_VALIDOS:
            raise ValueError(f"Perfil inválido: '{v}'. Válidos: {list(PERFILES_VALIDOS)}")
        return v

    @field_validator("fill_rate")
    @classmethod
    def check_fill_rate(cls, v: float) -> float:
        if not (0.0 <= v <= 1.0):
            raise ValueError("fill_rate debe estar entre 0 y 1.")
        return v


class BotUpdate(BaseModel):
    nombre: Optional[str] = None
    enabled: Optional[bool] = None
    interval: Optional[float] = None
    variance: Optional[float] = None
    max_ordenes: Optional[int] = None
    tipos_orden: Optional[List[str]] = None
    perfil: Optional[str] = None
    fill_rate: Optional[float] = None
    offset_min_compra: Optional[float] = None
    offset_max_compra: Optional[float] = None
    offset_min_venta: Optional[float] = None
    offset_max_venta: Optional[float] = None
    # Per-bot behaviour overrides (None = inherit from profile; send explicitly to clear)
    stale_offset_pct: Optional[float] = None
    capital_fraccion_max: Optional[float] = None
    ciclo_min_ticks: Optional[int] = None
    ciclo_max_ticks: Optional[int] = None
    fill_react_prob: Optional[float] = None
    fill_react_markup: Optional[float] = None
    prob_orden_mercado: Optional[float] = None
    respetar_horario: Optional[bool] = None

    @field_validator("tipos_orden")
    @classmethod
    def check_tipos(cls, v):
        if v is None:
            return v
        invalidos = [t for t in v if t not in TIPOS_ORDEN_VALIDOS]
        if invalidos:
            raise ValueError(f"Tipos inválidos: {invalidos}. Válidos: {list(TIPOS_ORDEN_VALIDOS)}")
        if not v:
            raise ValueError("Debe especificar al menos un tipo de orden.")
        return v

    @field_validator("perfil")
    @classmethod
    def check_perfil(cls, v):
        if v is None:
            return v
        v = v.upper().strip()
        if v not in PERFILES_VALIDOS:
            raise ValueError(f"Perfil inválido: '{v}'. Válidos: {list(PERFILES_VALIDOS)}")
        return v

    @field_validator("fill_rate")
    @classmethod
    def check_fill_rate(cls, v):
        if v is None:
            return v
        if not (0.0 <= v <= 1.0):
            raise ValueError("fill_rate debe estar entre 0 y 1.")
        return v


class BotBulkUpdate(BaseModel):
    respetar_horario: bool


# ── System config schema ───────────────────────────────────────────────────────

class ConfigUpdate(BaseModel):
    auto_matching: Optional[bool] = None
    matching_mercado: Optional[str] = None
    mercado_sesgo: Optional[float] = None   # -1.0 … +1.0
