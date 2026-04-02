from pydantic import BaseModel, field_validator
from typing import Literal


class UserCreate(BaseModel):
    username: str
    password: str
    email: str | None = None
    role: Literal["ADMIN", "OPERADOR"] = "OPERADOR"

    @field_validator("username")
    @classmethod
    def username_clean(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 3:
            raise ValueError("El username debe tener al menos 3 caracteres")
        return v

    @field_validator("password")
    @classmethod
    def password_strong(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("La contraseña debe tener al menos 8 caracteres")
        return v


class UserUpdate(BaseModel):
    email: str | None = None
    role: Literal["ADMIN", "OPERADOR"] | None = None
    is_active: bool | None = None
    password: str | None = None

    @field_validator("password")
    @classmethod
    def password_strong(cls, v: str | None) -> str | None:
        if v is not None and len(v) < 8:
            raise ValueError("La contraseña debe tener al menos 8 caracteres")
        return v


class UserOut(BaseModel):
    id: int
    username: str
    email: str | None
    role: str
    is_active: bool
    created_at: str | None
    last_login: str | None

    model_config = {"from_attributes": True}
