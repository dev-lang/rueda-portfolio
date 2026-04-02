"""
Cash projection service — calculates projected available balance
by subtracting notional value of all pending buy orders from the
current available balance.

Used by GET /api/cuentas/proyeccion to power the intraday cash panel.
"""

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.cliente import Cliente
from app.models.orden import Orden
from app.models.precio_mercado import PrecioMercado


from app.models.bot_instancia import TIPOS_COMPRA as _TIPOS_COMPRA


def calcular_proyeccion(
    db: Session,
    cliente_codigo: str,
    moneda: str = "ARP",
) -> dict:
    """
    Returns:
        saldo_actual       — current Account.saldo_disponible
        comprometido       — sum of (precio_ref × qty_pendiente) for all pending buys
        saldo_proyectado   — saldo_actual - comprometido
        alerta             — True if saldo_proyectado < 0
        ordenes_pendientes — list of pending buy orders driving the projection
    """
    # Resolve cliente → Account
    cliente_obj = db.execute(
        select(Cliente).where(Cliente.codigo == cliente_codigo)
    ).scalar_one_or_none()

    saldo_actual: float = 0.0
    balance_reservado: float = 0.0

    if cliente_obj:
        account = db.execute(
            select(Account).where(
                Account.owner_type == "cliente",
                Account.owner_id == cliente_obj.id,
                Account.moneda == moneda,
            )
        ).scalar_one_or_none()
        if account:
            saldo_actual = float(account.saldo_disponible)
            balance_reservado = float(account.balance_reservado or 0)

    # Pending buy orders (not yet fully executed, not cancelled)
    pending_buys = db.execute(
        select(Orden).where(
            Orden.cliente == cliente_codigo,
            Orden.moneda == moneda,
            Orden.tipo_orden.in_(_TIPOS_COMPRA),
            Orden.estado_color == "orange",
            Orden.activa == True,
        )
    ).scalars().all()

    # Build precio cache for MERCADO orders
    precio_cache: dict[str, float] = {}

    comprometido = Decimal("0")
    ordenes_detalle = []

    for o in pending_buys:
        qty_pendiente = o.cantidad_total - o.cantidad_ejecutada
        if qty_pendiente <= 0:
            continue

        if o.tipo_precio == "MERCADO":
            if o.especie not in precio_cache:
                pm = db.execute(
                    select(PrecioMercado).where(PrecioMercado.especie == o.especie)
                ).scalar_one_or_none()
                precio_cache[o.especie] = pm.precio if pm else 0.0
            precio_ref = precio_cache[o.especie]
        else:
            precio_ref = o.precio_limite or 0.0

        importe = Decimal(str(precio_ref)) * Decimal(str(qty_pendiente))
        comprometido += importe

        ordenes_detalle.append({
            "nro_orden": o.nro_orden,
            "especie": o.especie,
            "tipo_precio": o.tipo_precio,
            "precio_ref": precio_ref,
            "qty_pendiente": qty_pendiente,
            "importe": float(importe),
        })

    comprometido_f = float(comprometido)
    saldo_proyectado = saldo_actual - comprometido_f

    return {
        "cliente": cliente_codigo,
        "moneda": moneda,
        "saldo_actual": saldo_actual,
        "balance_reservado": balance_reservado,
        "comprometido": comprometido_f,
        "saldo_proyectado": saldo_proyectado,
        "alerta": saldo_proyectado < 0,
        "ordenes_pendientes": ordenes_detalle,
    }
