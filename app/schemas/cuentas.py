from pydantic import BaseModel, Field


class AjusteManualRequest(BaseModel):
    monto: float = Field(..., gt=0, description="Monto positivo a acreditar o debitar")
    sentido: str = Field(..., description="CREDIT o DEBIT")
    descripcion: str = Field(..., min_length=5, max_length=300)


class InicializarCuentaBotRequest(BaseModel):
    capital_inicial: float = Field(..., gt=0, description="Capital inicial en ARP")


class MovimientoOperadorRequest(BaseModel):
    monto: float = Field(..., gt=0)
    descripcion: str = Field(..., min_length=5, max_length=300)
    moneda: str = Field("ARP")


class MovimientoFirmaRequest(BaseModel):
    monto: float = Field(..., gt=0, description="Monto positivo")
    descripcion: str = Field(..., min_length=5, max_length=300)
    moneda: str = Field("ARP", description="Moneda de la cuenta (ARP, USD, etc.)")
