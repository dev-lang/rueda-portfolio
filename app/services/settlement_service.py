"""
Settlement service — manages trade settlement lifecycle.

Key concepts:
    - Every fill (Ejecucion) gets a fecha_liquidacion computed from SettlementRule.
    - Fills start as liquidada=False (cash/position committed but not final).
    - liquidar_pendientes() is a batch job: marks settled fills & releases reservations.
    - For mercado=DEFAULT (bots) no rule is found → T+0 (settles immediately on same day).

Argentine holiday set:
    A static minimal set is provided for the current year. In production replace with
    an authoritative source (BCRA, BYMA calendar API).
"""

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session
from sqlalchemy import select, or_

from app.models.settlement_rule import SettlementRule
from app.models.ejecucion import Ejecucion
from app.models.confirmacion import Confirmacion
from app.models.account_entry import AccountEntry
from app.models.account import Account
from app.models.posicion import Posicion
from app.core.pagination import paginate

# ── Static Argentine non-settlement days (weekends handled separately) ────────
# Public holidays where BYMA/MAE/ROFEX are closed.  Update annually.
_AR_HOLIDAYS_2025: frozenset[date] = frozenset({
    date(2025, 1, 1),   # Año Nuevo
    date(2025, 3, 3),   # Carnaval
    date(2025, 3, 4),   # Carnaval
    date(2025, 4, 2),   # Malvinas
    date(2025, 4, 17),  # Jueves Santo
    date(2025, 4, 18),  # Viernes Santo
    date(2025, 5, 1),   # Día del Trabajo
    date(2025, 5, 25),  # Revolución de Mayo
    date(2025, 6, 20),  # Paso a la Inmortalidad
    date(2025, 7, 9),   # Independencia
    date(2025, 8, 18),  # San Martín (puente)
    date(2025, 10, 12), # Respeto a la Diversidad Cultural
    date(2025, 11, 20), # Soberanía Nacional (puente)
    date(2025, 11, 22), # Soberanía Nacional (puente)
    date(2025, 12, 8),  # Inmaculada Concepción
    date(2025, 12, 25), # Navidad
})

_AR_HOLIDAYS_2026: frozenset[date] = frozenset({
    date(2026, 1, 1),
    date(2026, 2, 16),  # Carnaval
    date(2026, 2, 17),  # Carnaval
    date(2026, 4, 2),   # Malvinas
    date(2026, 4, 3),   # Jueves Santo
    date(2026, 4, 4),   # Viernes Santo
    date(2026, 5, 1),   # Día del Trabajo
    date(2026, 5, 25),  # Revolución de Mayo
    date(2026, 6, 20),  # Paso a la Inmortalidad
    date(2026, 7, 9),   # Independencia
    date(2026, 8, 17),  # San Martín
    date(2026, 10, 12), # Respeto a la Diversidad Cultural
    date(2026, 11, 20), # Soberanía Nacional
    date(2026, 12, 8),  # Inmaculada Concepción
    date(2026, 12, 25), # Navidad
})

_ALL_HOLIDAYS: frozenset[date] = _AR_HOLIDAYS_2025 | _AR_HOLIDAYS_2026


def _es_dia_habil(d: date) -> bool:
    return d.weekday() < 5 and d not in _ALL_HOLIDAYS


def _sumar_dias_habil(desde: date, dias: int) -> date:
    """Add `dias` business days to `desde`, skipping weekends and holidays."""
    if dias == 0:
        return desde
    resultado = desde
    agregados = 0
    while agregados < dias:
        resultado += timedelta(days=1)
        if _es_dia_habil(resultado):
            agregados += 1
    return resultado


# Maps Instrumento.tipo values to SettlementRule.tipo_especie codes.
_TIPO_INSTR_A_RULE: dict[str, str] = {
    "ACCION":     "EQUITY",
    "RENTA_FIJA": "BOND",
    "FUTURO":     "FUTURO",
}


# ── Public API ────────────────────────────────────────────────────────────────

def calcular_fecha_liquidacion(
    db: Session,
    mercado: str,
    fecha_ejecucion: date,
    tipo_especie: str | None = None,
) -> date:
    """
    Returns the settlement date for a fill in the given market.

    tipo_especie: instrument type from Instrumento.tipo (e.g. ACCION, RENTA_FIJA,
        FUTURO). When provided, a specific rule is tried first before falling
        back to the generic "ALL" rule. Pass None to go straight to "ALL".

    Falls back to T+0 (same day) if no matching rule is found.
    """
    # Translate Instrumento.tipo to the rule code used in SettlementRule
    rule_code = _TIPO_INSTR_A_RULE.get((tipo_especie or "").upper()) if tipo_especie else None

    # Try specific rule first
    if rule_code:
        rule = db.execute(
            select(SettlementRule).where(
                SettlementRule.mercado      == mercado.upper(),
                SettlementRule.tipo_especie == rule_code,
                SettlementRule.activo       == True,
            )
        ).scalars().first()
        if rule:
            return _sumar_dias_habil(fecha_ejecucion, rule.dias_habil)

    # Fall back to the generic "ALL" rule for this market
    rule = db.execute(
        select(SettlementRule).where(
            SettlementRule.mercado      == mercado.upper(),
            SettlementRule.tipo_especie == "ALL",
            SettlementRule.activo       == True,
        )
    ).scalars().first()

    dias = rule.dias_habil if rule else 0
    return _sumar_dias_habil(fecha_ejecucion, dias)


def liquidar_pendientes(db: Session) -> int:
    """
    Batch settlement job: find all fills whose fecha_liquidacion <= today and
    mark them as liquidada=True. Also:
      - Marks the corresponding AccountEntry rows as liquidada=True.
      - Releases balance_reservado on the Account.
      - Releases cantidad_pendiente_liquidacion on the Posicion.

    Returns the count of fills settled in this run.
    Caller must commit.
    """
    hoy = date.today()
    count = 0

    pendientes: list[Ejecucion] = db.execute(
        select(Ejecucion)
        .outerjoin(Confirmacion, Confirmacion.ejecucion_id == Ejecucion.id)
        .where(
            Ejecucion.liquidada == False,
            Ejecucion.fecha_liquidacion != None,
            Ejecucion.fecha_liquidacion <= hoy,
            or_(Confirmacion.id == None, Confirmacion.estado != "RECHAZADA"),
        )
    ).scalars().all()

    for ejec in pendientes:
        # ── 1. Mark fill as settled ───────────────────────────────────────
        ejec.liquidada = True

        # ── 2. Settle related AccountEntry rows ───────────────────────────
        entries: list[AccountEntry] = db.execute(
            select(AccountEntry).where(
                AccountEntry.ref_type == "ejecucion",
                AccountEntry.ref_id == ejec.id,
                AccountEntry.liquidada == False,
            )
        ).scalars().all()

        for entry in entries:
            entry.liquidada = True
            # Release balance_reservado on the account (only for DEBIT entries)
            if entry.sentido == "DEBIT":
                account: Account | None = db.get(Account, entry.account_id)
                if account is not None:
                    monto = Decimal(str(entry.monto or 0))
                    reservado = Decimal(str(account.balance_reservado or 0))
                    account.balance_reservado = max(Decimal("0"), reservado - monto)

        # ── 3. Release pending position quantity ──────────────────────────
        orden = ejec.orden
        if orden is not None:
            posicion: Posicion | None = db.execute(
                select(Posicion).where(
                    Posicion.cliente == orden.cliente,
                    Posicion.especie == orden.especie,
                    Posicion.moneda == orden.moneda,
                    Posicion.mercado == ejec.mercado,
                )
            ).scalar_one_or_none()

            if posicion is not None and posicion.cantidad_pendiente_liquidacion > 0:
                posicion.cantidad_pendiente_liquidacion = max(
                    0,
                    posicion.cantidad_pendiente_liquidacion - ejec.cantidad,
                )

        count += 1

    return count


def listar_pendientes(db: Session, page: int = 1, per_page: int = 50) -> dict:
    """Returns pending (unsettled) fills paginated."""
    base = select(Ejecucion).where(
        Ejecucion.liquidada == False,
        Ejecucion.fecha_liquidacion != None,
    )
    fills, meta = paginate(db, base, page, per_page, order_by=Ejecucion.fecha_liquidacion.asc())
    return {"pendientes": [e.to_dict() for e in fills], **meta}
