from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.services import posicion_service, precio_service, tipo_cambio_service

router = APIRouter(prefix="/api/positions", tags=["posiciones"])

_USD_MONEDAS = {"USD", "USX"}   # monedas que requieren conversión FX


def _enriquecer_con_precios(posiciones, precios, tc: dict) -> list[dict]:
    """
    Add market price, unrealized P&L, and FX valuation fields to each position.
    For USD-denominated positions, adds valor_ars using CCL rate.
    """
    result = []
    for p in posiciones:
        d = p.to_dict() if hasattr(p, "to_dict") else dict(p)
        pm = precios.get(p.especie if hasattr(p, "especie") else d["especie"])
        especie = d.get("especie") or (p.especie if hasattr(p, "especie") else None)
        moneda  = d.get("moneda")  or (p.moneda  if hasattr(p, "moneda")  else "ARP")
        qty     = d.get("cantidad_neta", 0)
        costo   = d.get("costo_promedio_compra", 0)

        if pm and pm.precio is not None and qty and costo:
            pnl, pnl_pct = precio_service.calcular_pnl(qty, costo, pm.precio)
            d["precio_mercado"]   = pm.precio
            d["variacion_pct"]    = pm.variacion_pct
            d["pnl_no_realizado"] = pnl
            d["pnl_pct"]          = pnl_pct
            d["fuente_precio"]    = pm.fuente
            # FX valuation for USD positions
            if moneda in _USD_MONEDAS:
                tc_ccl = tc.get("ccl")
                if tc_ccl:
                    d["valor_usd"] = round(qty * pm.precio, 2)
                    d["valor_ars"] = round(qty * pm.precio * tc_ccl, 2)
                    d["tc_ccl_usado"] = tc_ccl
        else:
            d["precio_mercado"]   = None
            d["variacion_pct"]    = None
            d["pnl_no_realizado"] = None
            d["pnl_pct"]          = None
            d["fuente_precio"]    = None

        result.append(d)
    return result


@router.get("")
def listar_posiciones(
    cliente: str = "Todos",
    especie: str = "Todos",
    mercado: str = "Todos",
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    posiciones = posicion_service.listar_posiciones(
        db, cliente=cliente, especie=especie, mercado=mercado
    )
    precios = precio_service.get_precios_dict(db)
    tc = tipo_cambio_service.get_tipo_cambio()
    return {"posiciones": _enriquecer_con_precios(posiciones, precios, tc)}


@router.get("/consolidada")
def posicion_consolidada(
    especie: str = "Todos",
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Aggregated net position per especie across ALL clients.
    Each row shows total, propia (cartera propia) and terceros breakdown,
    enriched with current market price and unrealized P&L.
    """
    grupos = posicion_service.listar_consolidada(db, especie=especie)
    precios = precio_service.get_precios_dict(db)
    tc = tipo_cambio_service.get_tipo_cambio()

    for g in grupos:
        esp = g["especie"]
        moneda = g.get("moneda", "ARP")
        pm = precios.get(esp)
        qty_total = g["posicion_total_neta"]
        costo_avg = g.get("costo_promedio_ponderado")

        if pm is not None and pm.precio is not None and qty_total is not None and costo_avg is not None:
            pnl, pnl_pct = precio_service.calcular_pnl(qty_total, costo_avg, pm.precio)
            g["precio_mercado"]   = pm.precio
            g["variacion_pct"]    = pm.variacion_pct
            g["pnl_no_realizado"] = pnl
            g["pnl_pct"]          = pnl_pct
            g["valor_cartera"]    = round(qty_total * pm.precio, 2)
            if moneda in _USD_MONEDAS:
                tc_ccl = tc.get("ccl")
                if tc_ccl:
                    g["valor_ars"]    = round(qty_total * pm.precio * tc_ccl, 2)
                    g["tc_ccl_usado"] = tc_ccl
        else:
            g["precio_mercado"]   = None
            g["variacion_pct"]    = None
            g["pnl_no_realizado"] = None
            g["pnl_pct"]          = None
            g["valor_cartera"]    = None

    return {
        "posiciones": grupos,
        "tc_referencia": tc,
    }
