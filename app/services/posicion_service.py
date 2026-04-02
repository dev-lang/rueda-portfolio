from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.models.posicion import Posicion
from app.models.ejecucion import Ejecucion
from app.models.orden import Orden
from app.models.cliente import Cliente
from app.models.bot_instancia import TIPOS_COMPRA as _TIPOS_COMPRA, TIPOS_VENTA as _TIPOS_VENTA


def actualizar_posicion(
    db: Session,
    ejecucion: Ejecucion,
    orden: Orden,
    precio_efectivo: float | None = None,
) -> Posicion | None:
    """
    Upserts the position for (cliente, especie, moneda, mercado) based on
    the new fill. Must be called within the same DB transaction as the fill
    so that both roll back together on failure.

    precio_efectivo: all-in cost per unit including commissions. When provided
        (from comision_service), the weighted average reflects true economic cost.
        Falls back to ejecucion.precio when commissions are not available.

    Weighted average formula:
        new_avg = (prev_qty * prev_avg + fill_qty * fill_price) / new_total_qty
    """
    tipo = orden.tipo_orden.upper()
    if tipo not in _TIPOS_COMPRA and tipo not in _TIPOS_VENTA:
        return None  # order type does not affect positions

    precio = precio_efectivo if precio_efectivo is not None else ejecucion.precio

    posicion = db.execute(
        select(Posicion)
        .where(
            Posicion.cliente == orden.cliente,
            Posicion.especie == orden.especie,
            Posicion.moneda == orden.moneda,
            Posicion.mercado == ejecucion.mercado,
        )
        .with_for_update()
    ).scalar_one_or_none()

    if posicion is None:
        posicion = Posicion(
            cliente=orden.cliente,
            especie=orden.especie,
            moneda=orden.moneda,
            mercado=ejecucion.mercado,
        )
        db.add(posicion)

    if tipo in _TIPOS_COMPRA:
        prev_qty  = posicion.cantidad_comprada or 0
        prev_cost = posicion.costo_promedio_compra or 0.0
        nuevo_total = prev_qty + ejecucion.cantidad
        if nuevo_total > 0:
            posicion.costo_promedio_compra = round(
                (prev_qty * prev_cost + ejecucion.cantidad * precio) / nuevo_total, 4
            )
        posicion.cantidad_comprada = nuevo_total

    elif tipo in _TIPOS_VENTA:
        prev_qty  = posicion.cantidad_vendida or 0
        prev_cost = posicion.costo_promedio_venta or 0.0
        nuevo_total = prev_qty + ejecucion.cantidad
        if nuevo_total > 0:
            posicion.costo_promedio_venta = round(
                (prev_qty * prev_cost + ejecucion.cantidad * precio) / nuevo_total, 4
            )
        posicion.cantidad_vendida = nuevo_total

    posicion.cantidad_neta = (posicion.cantidad_comprada or 0) - (posicion.cantidad_vendida or 0)

    # When position goes flat, reset cost basis so the next leg starts fresh.
    # Without this, a rebuy after selling everything inherits stale weighted average.
    if posicion.cantidad_neta == 0:
        posicion.costo_promedio_compra = 0.0
        posicion.costo_promedio_venta = 0.0

    # Track unsettled quantity so cantidad_disponible stays accurate
    if not bool(ejecucion.liquidada):
        posicion.cantidad_pendiente_liquidacion = (
            (posicion.cantidad_pendiente_liquidacion or 0) + ejecucion.cantidad
        )

    return posicion


def listar_posiciones(
    db: Session,
    cliente: str | None = None,
    especie: str | None = None,
    mercado: str | None = None,
) -> list[Posicion]:
    stmt = select(Posicion)
    if cliente and cliente != "Todos":
        stmt = stmt.where(Posicion.cliente == cliente)
    if especie and especie != "Todos":
        stmt = stmt.where(Posicion.especie == especie)
    if mercado and mercado != "Todos":
        stmt = stmt.where(Posicion.mercado == mercado)
    return db.execute(
        stmt.order_by(Posicion.cliente, Posicion.especie)
    ).scalars().all()


def listar_consolidada(
    db: Session,
    especie: str | None = None,
) -> list[dict]:
    """
    Returns aggregated net position per especie across ALL clients.

    Each row includes:
      - posicion_total_neta  : total net qty (all clients)
      - posicion_propia      : net qty from cartera_propia clients
      - posicion_terceros    : net qty from third-party clients
      - costo_promedio_ponderado: weighted average cost across all positions
      - clients              : list of individual client positions

    Clients marked es_cartera_propia=True are the fund's proprietary book.
    """
    # Load all client codes flagged as cartera_propia
    propias = set(
        row[0] for row in db.execute(
            select(Cliente.codigo).where(Cliente.es_cartera_propia == True)
        ).all()
    )

    stmt = select(Posicion).where(Posicion.cantidad_neta != 0)
    if especie and especie != "Todos":
        stmt = stmt.where(Posicion.especie == especie.upper())

    posiciones = db.execute(stmt.order_by(Posicion.especie, Posicion.cliente)).scalars().all()

    # Group by (especie, moneda)
    grupos: dict[tuple, dict] = {}
    for p in posiciones:
        key = (p.especie, p.moneda)
        if key not in grupos:
            grupos[key] = {
                "especie":                  p.especie,
                "moneda":                   p.moneda,
                "posicion_total_neta":      0,
                "posicion_propia":          0,
                "posicion_terceros":        0,
                "cantidad_pendiente_liquidacion": 0,
                # for weighted avg cost
                "_costo_acumulado":         0.0,
                "_qty_acumulada":           0,
                "detalle":                  [],
            }
        g = grupos[key]
        neta = p.cantidad_neta or 0
        g["posicion_total_neta"]      += neta
        g["cantidad_pendiente_liquidacion"] += (p.cantidad_pendiente_liquidacion or 0)
        if p.cliente in propias:
            g["posicion_propia"]  += neta
        else:
            g["posicion_terceros"] += neta
        # Accumulate for weighted avg using signed quantities:
        # longs contribute positive cost; shorts reduce net cost (proceeds received)
        if neta > 0 and (p.costo_promedio_compra or 0) > 0:
            g["_costo_acumulado"] += neta * p.costo_promedio_compra
            g["_qty_acumulada"]   += neta
        elif neta < 0 and (p.costo_promedio_venta or 0) > 0:
            g["_costo_acumulado"] += neta * p.costo_promedio_venta
            g["_qty_acumulada"]   += neta
        g["detalle"].append({
            "cliente":              p.cliente,
            "es_propia":            p.cliente in propias,
            "cantidad_neta":        neta,
            "costo_promedio_compra": p.costo_promedio_compra,
            "mercado":              p.mercado,
        })

    result = []
    for g in grupos.values():
        qty = g.pop("_qty_acumulada")
        costo = g.pop("_costo_acumulado")
        g["costo_promedio_ponderado"] = round(costo / qty, 4) if qty > 0 else None
        result.append(g)

    return sorted(result, key=lambda x: x["especie"])
