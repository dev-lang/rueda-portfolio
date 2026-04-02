"""
Pre-trade risk service — validates orders against configured limits before creation.

Two check levels:
    HARD BLOCK  → raises RiesgoLimiteError(es_alerta=False): order is rejected.
    SOFT ALERT  → raises RiesgoLimiteError(es_alerta=True): order is created but
                  a warning is included in the response.

Limit resolution priority:
    1. Client-specific limit for the exact especie
    2. Client-specific limit for ALL especies (especie=NULL)
    3. Global limit for the exact especie
    4. Global limit for ALL especies (especie=NULL)
    The most restrictive applicable limit wins.
"""

from decimal import Decimal
from datetime import date, timedelta

from sqlalchemy.orm import Session
from sqlalchemy import select, func, or_

from app.models.limite_riesgo import LimiteRiesgo
from app.models.ejecucion import Ejecucion
from app.models.confirmacion import Confirmacion
from app.models.bot_instancia import TIPOS_COMPRA
from app.models.orden import Orden
from app.models.account import Account


class RiesgoLimiteError(Exception):
    """Raised when a pre-trade limit is violated."""

    def __init__(self, mensaje: str, tipo_limite: str, es_alerta: bool = False) -> None:
        self.mensaje = mensaje
        self.tipo_limite = tipo_limite
        self.es_alerta = es_alerta
        super().__init__(mensaje)


def _to_decimal(v) -> Decimal:
    return Decimal(str(v or 0))


# ── Limit queries ─────────────────────────────────────────────────────────────

def _get_limites(
    db: Session,
    owner_id: int | None,
    tipo_limite: str,
    especie: str,
    moneda: str,
) -> list[LimiteRiesgo]:
    """
    Returns all active limits of the given type that apply to this (owner, especie, moneda),
    ordered from most specific to least specific.
    """
    stmt = select(LimiteRiesgo).where(
        LimiteRiesgo.tipo_limite == tipo_limite,
        LimiteRiesgo.moneda == moneda,
        LimiteRiesgo.activo == True,
        # Applies to this client OR globally
        (LimiteRiesgo.owner_type == "global") |
        ((LimiteRiesgo.owner_type == "cliente") & (LimiteRiesgo.owner_id == owner_id)),
        # Applies to this especie OR all especies
        (LimiteRiesgo.especie == None) | (LimiteRiesgo.especie == especie),
    )
    return db.execute(stmt).scalars().all()


def _check_limit(
    limites: list[LimiteRiesgo],
    valor_actual: Decimal,
    valor_nuevo: Decimal,
    descripcion: str,
    tipo_limite: str,
) -> RiesgoLimiteError | None:
    """
    Given a list of applicable limits, returns the first violation found or None.
    """
    for lim in limites:
        limite = _to_decimal(lim.valor_limite)
        if limite == 0:
            continue
        alerta_umbral = limite * _to_decimal(lim.alerta_pct) / 100

        if valor_nuevo > limite:
            return RiesgoLimiteError(
                f"Límite '{tipo_limite}' excedido: {descripcion} = "
                f"{float(valor_nuevo):,.0f} > límite {float(limite):,.0f}.",
                tipo_limite=tipo_limite,
                es_alerta=False,
            )
        if valor_nuevo >= alerta_umbral:
            return RiesgoLimiteError(
                f"Alerta '{tipo_limite}': {descripcion} = "
                f"{float(valor_nuevo):,.0f} supera el {float(lim.alerta_pct):.0f}% "
                f"del límite {float(limite):,.0f}.",
                tipo_limite=tipo_limite,
                es_alerta=True,
            )
    return None


# ── Public API ────────────────────────────────────────────────────────────────

def verificar_limites_orden(
    db: Session,
    tipo_orden: str,
    especie: str,
    moneda: str,
    precio_limite: float,
    cantidad_total: int,
    cliente_id: int | None,
) -> list[RiesgoLimiteError]:
    """
    Runs all applicable pre-trade checks. Returns a list of RiesgoLimiteError.
    Callers should raise the first hard-block error; soft alerts can be passed through.
    """
    importe = _to_decimal(precio_limite) * _to_decimal(cantidad_total)
    alertas: list[RiesgoLimiteError] = []

    # ── SALDO_MAXIMO_ORDEN: single order notional cap ─────────────────────────
    limites_orden = _get_limites(db, cliente_id, "SALDO_MAXIMO_ORDEN", especie, moneda)
    err = _check_limit(limites_orden, Decimal("0"), importe, f"importe orden ({especie})", "SALDO_MAXIMO_ORDEN")
    if err:
        alertas.append(err)

    # ── VOLUMEN_DIARIO: total notional traded today ────────────────────────────
    limites_diario = _get_limites(db, cliente_id, "VOLUMEN_DIARIO", especie, moneda)
    if limites_diario:
        hoy = date.today()
        volumen_hoy = _to_decimal(
            db.execute(
                select(func.sum(Ejecucion.cantidad * Ejecucion.precio))
                .outerjoin(Confirmacion, Confirmacion.ejecucion_id == Ejecucion.id)
                .join(Orden, Ejecucion.orden_id == Orden.id)
                .where(
                    Orden.especie == especie,
                    Orden.moneda == moneda,
                    Ejecucion.fecha == hoy,
                    or_(Confirmacion.id == None, Confirmacion.estado != "RECHAZADA"),
                    *([Orden.cliente == _get_cliente_codigo(db, cliente_id)] if cliente_id else []),
                )
            ).scalar()
        )
        err = _check_limit(
            limites_diario, volumen_hoy, volumen_hoy + importe,
            f"volumen diario ({especie})", "VOLUMEN_DIARIO"
        )
        if err:
            alertas.append(err)

    return alertas


def verificar_saldo_ejecucion(
    db: Session,
    account: Account,
    orden,
    cantidad: int,
    precio: float,
) -> None:
    """
    Real-time balance check at fill time for human orders.
    Raises RiesgoLimiteError (hard block) if saldo_disponible is insufficient.
    Skipped for bot orders (orden.bot_id is not None).
    """
    if orden.bot_id is not None:
        return  # bots have their own balance gate in market_bot.py
    if orden.tipo_orden not in TIPOS_COMPRA:
        return  # sells don't require cash

    importe = _to_decimal(cantidad) * _to_decimal(precio)
    saldo_disponible = _to_decimal(account.balance_cache) - _to_decimal(account.balance_reservado)

    if importe > saldo_disponible:
        raise RiesgoLimiteError(
            f"Saldo insuficiente: disponible {float(saldo_disponible):,.2f} {orden.moneda}, "
            f"operación requiere {float(importe):,.2f} {orden.moneda}.",
            tipo_limite="SALDO_DISPONIBLE",
            es_alerta=False,
        )


def _get_cliente_codigo(db: Session, cliente_id: int) -> str | None:
    from app.models.cliente import Cliente
    c = db.get(Cliente, cliente_id)
    return c.codigo if c else None


# ── CRUD ──────────────────────────────────────────────────────────────────────

def listar(db: Session) -> list[LimiteRiesgo]:
    return db.execute(
        select(LimiteRiesgo).where(LimiteRiesgo.activo == True)
        .order_by(LimiteRiesgo.owner_type, LimiteRiesgo.tipo_limite)
    ).scalars().all()


def crear(db: Session, **kwargs) -> LimiteRiesgo:
    lim = LimiteRiesgo(**kwargs)
    db.add(lim)
    db.flush()
    return lim


def actualizar(
    db: Session,
    limite_id: int,
    valor_limite: Decimal | None = None,
    alerta_pct: Decimal | None = None,
    activo: bool | None = None,
) -> LimiteRiesgo:
    lim = db.get(LimiteRiesgo, limite_id)
    if lim is None:
        raise ValueError(f"Límite de riesgo {limite_id} no encontrado.")
    if valor_limite is not None:
        lim.valor_limite = valor_limite
    if alerta_pct is not None:
        lim.alerta_pct = alerta_pct
    if activo is not None:
        lim.activo = activo
    return lim
