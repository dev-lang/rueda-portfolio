"""
Commission calculation service.

Commissions are calculated on each fill (Ejecucion) at a rate defined
per order type. IVA (21 %) is applied on top of the base commission.

The resulting costo_efectivo_unitario is then used by PosicionService
as the weighted-average price, so positions reflect all-in economic cost.

Uses Decimal arithmetic to avoid float rounding errors in financial calculations.
"""

from decimal import Decimal, ROUND_HALF_UP
from sqlalchemy.orm import Session
from app.models.comision import Comision
from app.models.ejecucion import Ejecucion
from app.models.orden import Orden

# Commission rates as a fraction of notional (cantidad × precio)
_TASAS: dict[str, Decimal] = {
    "LIMC": Decimal("0.003"),   # equity / bond buy
    "LIMV": Decimal("0.003"),   # equity / bond sell
}
_TASA_DEFAULT = Decimal("0.005")
_IVA_RATE = Decimal("0.21")


def _round2(d: Decimal) -> float:
    return float(d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _round4(d: Decimal) -> float:
    return float(d.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def calcular_comision(
    db: Session,
    ejecucion: Ejecucion,
    orden: Orden,
) -> Comision:
    """
    Calculates and adds the commission record to the session for a fill.

    Must be called after db.flush() inside ejecutar_orden() so that
    ejecucion.id is already assigned.

    Returns the Comision object (not yet committed).
    Raises ValueError if the fill has zero or negative quantity/price.
    """
    cantidad = ejecucion.cantidad
    precio   = ejecucion.precio

    if not cantidad or cantidad <= 0:
        raise ValueError(
            f"Ejecucion {ejecucion.id}: cantidad debe ser > 0, got {cantidad}"
        )
    if not precio or precio <= 0:
        raise ValueError(
            f"Ejecucion {ejecucion.id}: precio debe ser > 0, got {precio}"
        )

    tasa = _TASAS.get((orden.tipo_orden or "").upper(), _TASA_DEFAULT)

    d_cantidad = Decimal(str(cantidad))
    d_precio   = Decimal(str(precio))

    monto_bruto    = d_cantidad * d_precio
    monto_comision = (monto_bruto * tasa).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    iva            = (monto_comision * _IVA_RATE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    monto_total    = monto_comision + iva
    costo_efectivo = (d_precio + monto_total / d_cantidad).quantize(
        Decimal("0.0001"), rounding=ROUND_HALF_UP
    )

    comision = Comision(
        ejecucion_id=ejecucion.id,
        monto_bruto=_round2(monto_bruto),
        tasa=float(tasa),
        monto_comision=float(monto_comision),
        iva=float(iva),
        monto_total=float(monto_total),
        costo_efectivo_unitario=float(costo_efectivo),
    )
    db.add(comision)
    return comision
