"""
Counterparty service — CRUD and credit-limit enforcement.

Credit-limit check logic:
    exposure_actual = sum of fill amounts (settled OR pending) against this counterparty
                      in the given currency within the last 30 days.
    if exposure_actual + new_importe > limite → raise ContraparteLimiteError
    if (exposure_actual + new_importe) / limite >= alerta_pct / 100 → emit warning flag
"""

from decimal import Decimal
from datetime import date, timedelta

from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.models.contraparte import Contraparte, LimiteCreditoContraparte
from app.models.ejecucion import Ejecucion
from app.models.orden import Orden


class ContraparteLimiteError(Exception):
    """Raised when a fill would exceed the counterparty credit limit."""

    def __init__(self, mensaje: str, es_alerta: bool = False) -> None:
        self.mensaje = mensaje
        self.es_alerta = es_alerta  # True = warning only; False = hard block
        super().__init__(mensaje)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _to_decimal(v) -> Decimal:
    return Decimal(str(v or 0))


# ── Public API ────────────────────────────────────────────────────────────────

def listar(db: Session, solo_activos: bool = True) -> list[Contraparte]:
    stmt = select(Contraparte)
    if solo_activos:
        stmt = stmt.where(Contraparte.activo == True)
    return db.execute(stmt.order_by(Contraparte.codigo)).scalars().all()


def obtener(db: Session, contraparte_id: int) -> Contraparte | None:
    return db.get(Contraparte, contraparte_id)


def obtener_por_codigo(db: Session, codigo: str) -> Contraparte | None:
    return db.execute(
        select(Contraparte).where(Contraparte.codigo == codigo)
    ).scalar_one_or_none()


def crear(db: Session, codigo: str, nombre: str, tipo: str) -> Contraparte:
    if obtener_por_codigo(db, codigo):
        raise ValueError(f"Ya existe una contraparte con código '{codigo}'.")
    cp = Contraparte(codigo=codigo, nombre=nombre, tipo=tipo)
    db.add(cp)
    db.flush()
    return cp


def actualizar(
    db: Session,
    contraparte_id: int,
    nombre: str | None = None,
    activo: bool | None = None,
) -> Contraparte:
    cp = db.get(Contraparte, contraparte_id)
    if cp is None:
        raise ValueError(f"Contraparte {contraparte_id} no encontrada.")
    if nombre is not None:
        cp.nombre = nombre
    if activo is not None:
        cp.activo = activo
    return cp


def upsert_limite(
    db: Session,
    contraparte_id: int,
    moneda: str,
    limite: Decimal,
    alerta_pct: Decimal,
) -> LimiteCreditoContraparte:
    lim = db.execute(
        select(LimiteCreditoContraparte).where(
            LimiteCreditoContraparte.contraparte_id == contraparte_id,
            LimiteCreditoContraparte.moneda == moneda,
        )
    ).scalar_one_or_none()

    if lim is None:
        lim = LimiteCreditoContraparte(
            contraparte_id=contraparte_id,
            moneda=moneda,
            limite=limite,
            alerta_pct=alerta_pct,
        )
        db.add(lim)
    else:
        lim.limite = limite
        lim.alerta_pct = alerta_pct
    db.flush()
    return lim


def get_exposicion_actual(db: Session, contraparte_id: int, moneda: str) -> Decimal:
    """
    Sum of fill amounts (open + settled) for this counterparty in the last 30 days.
    Only considers fills where the order's moneda matches.
    """
    cutoff = date.today() - timedelta(days=30)
    result = db.execute(
        select(func.sum(Ejecucion.cantidad * Ejecucion.precio))
        .join(Orden, Ejecucion.orden_id == Orden.id)
        .where(
            Ejecucion.contraparte_id == contraparte_id,
            Orden.moneda == moneda,
            Ejecucion.fecha >= cutoff,
        )
    ).scalar()
    return _to_decimal(result)


def verificar_limite(
    db: Session,
    contraparte_id: int,
    moneda: str,
    importe: Decimal,
) -> None:
    """
    Checks the credit limit for the counterparty.
    Raises ContraparteLimiteError (hard block) if over limit.
    Raises ContraparteLimiteError(es_alerta=True) if in alert zone.
    Does nothing if no limit is configured for this (contraparte, moneda).
    """
    lim = db.execute(
        select(LimiteCreditoContraparte).where(
            LimiteCreditoContraparte.contraparte_id == contraparte_id,
            LimiteCreditoContraparte.moneda == moneda,
        )
    ).scalar_one_or_none()

    if lim is None or _to_decimal(lim.limite) == 0:
        return  # no limit configured → unlimited

    limite = _to_decimal(lim.limite)
    alerta_pct = _to_decimal(lim.alerta_pct) / 100
    exposicion = get_exposicion_actual(db, contraparte_id, moneda)
    nueva_exposicion = exposicion + _to_decimal(importe)

    if nueva_exposicion > limite:
        cp = db.get(Contraparte, contraparte_id)
        raise ContraparteLimiteError(
            f"Límite de crédito excedido para '{cp.nombre if cp else contraparte_id}': "
            f"exposición actual {float(exposicion):,.0f} + operación {float(importe):,.0f} "
            f"= {float(nueva_exposicion):,.0f} > límite {float(limite):,.0f} {moneda}.",
            es_alerta=False,
        )

    if alerta_pct > 0 and (nueva_exposicion / limite) >= alerta_pct:
        cp = db.get(Contraparte, contraparte_id)
        pct_usado = float(nueva_exposicion / limite * 100)
        raise ContraparteLimiteError(
            f"Alerta de crédito: '{cp.nombre if cp else contraparte_id}' al "
            f"{pct_usado:.1f}% del límite ({float(nueva_exposicion):,.0f} / {float(limite):,.0f} {moneda}).",
            es_alerta=True,
        )


def listar_con_exposicion(db: Session) -> list[dict]:
    """Returns all active counterparties with their current exposure per currency limit."""
    contrapartes = listar(db)
    result = []
    for cp in contrapartes:
        row = cp.to_dict()
        row["limites"] = []
        for lim in cp.limites:
            exposicion = get_exposicion_actual(db, cp.id, lim.moneda)
            limite = _to_decimal(lim.limite)
            row["limites"].append({
                **lim.to_dict(),
                "exposicion_actual": float(exposicion),
                "utilizacion_pct": float(exposicion / limite * 100) if limite > 0 else 0.0,
            })
        result.append(row)
    return result
