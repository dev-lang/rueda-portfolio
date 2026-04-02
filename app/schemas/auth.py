from pydantic import BaseModel


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    username:       str
    role:           str
    message:        str = "Login exitoso"
    cliente_codigo: str | None = None
