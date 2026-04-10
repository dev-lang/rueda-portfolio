"""
Ledger service — all cash account operations.

Design principles:
  - Every mutation creates an AccountEntry (append-only).
  - balance_cache is updated atomically alongside each entry.
  - Callers must hold a DB transaction; this module never commits.
  - SELECT FOR UPDATE on the Account row is done inside impactar_ejecucion
    and ajuste_manual to serialize concurrent writes to the same account.
  - If no account exists for an entity, operations are silently skipped
    (backward-compatible with pre-ledger seed data). No external code
    breaks when an account is missing.
"""

from decimal import Decimal, ROUND_HALF_UP
from sqlalchemy.orm import Session
from sqlalchemy import select, func, case

from app.models.account import Account
from app.models.account_entry import AccountEntry
from app.models.bot_instancia import TIPOS_COMPRA as _TIPOS_COMPRA
from app.core.pagination import paginate


# ── Internal helpers ──────────────────────────────────────────────────────────

def _to_decimal(value) -> Decimal:
    return Decimal(str(value or 0))


def _crear_entry(
    db: Session,
    account: Account,
    tipo: str,
    monto: Decimal,
    sentido: str,
    ref_type: str | None = None,
    ref_id: int | None = None,
    descripcion: str | None = None,
    usuario: str = "sistema",
    fecha_liquidacion=None,
    liquidada: bool = True,
) -> AccountEntry:
    """
    Creates an AccountEntry and updates account.balance_cache in-memory.
    Does NOT flush or commit — caller is responsible.

    If liquidada=False (pending settlement) and sentido=DEBIT, also increments
    account.balance_reservado so that saldo_disponible reflects the reservation.
    """
    from datetime import datetime
    monto = _to_decimal(monto)
    prev = _to_decimal(account.balance_cache)

    if sentido == "CREDIT":
        balance_post = prev + monto
    else:
        balance_post = prev - monto

    # Normalise fecha_liquidacion: accept date or datetime
    fecha_liq_dt = None
    if fecha_liquidacion is not None:
        if hasattr(fecha_liquidacion, "year") and not hasattr(fecha_liquidacion, "hour"):
            # date → datetime
            fecha_liq_dt = datetime.combine(fecha_liquidacion, datetime.min.time())
        else:
            fecha_liq_dt = fecha_liquidacion

    entry = AccountEntry(
        account_id=account.id,
        tipo=tipo,
        monto=monto,
        sentido=sentido,
        balance_post=balance_post,
        ref_type=ref_type,
        ref_id=ref_id,
        descripcion=descripcion,
        usuario=usuario,
        fecha_liquidacion=fecha_liq_dt,
        liquidada=liquidada,
    )
    db.add(entry)
    account.balance_cache = balance_post

    # Reserve funds for pending debit entries so saldo_disponible stays accurate
    if not liquidada and sentido == "DEBIT":
        account.balance_reservado = _to_decimal(account.balance_reservado) + monto

    return entry


# ── Public API ────────────────────────────────────────────────────────────────

def get_account(
    db: Session,
    owner_type: str,
    owner_id: int,
    moneda: str = "ARP",
    mercado: str = "DEFAULT",
) -> Account | None:
    return db.execute(
        select(Account).where(
            Account.owner_type == owner_type,
            Account.owner_id == owner_id,
            Account.moneda == moneda,
            Account.mercado == mercado,
            Account.activa == True,
        )
    ).scalar_one_or_none()


def get_or_create_account(
    db: Session,
    owner_type: str,
    owner_id: int,
    moneda: str = "ARP",
    mercado: str = "DEFAULT",
    capital_inicial: Decimal = Decimal("0"),
) -> Account:
    account = db.execute(
        select(Account).where(
            Account.owner_type == owner_type,
            Account.owner_id == owner_id,
            Account.moneda == moneda,
            Account.mercado == mercado,
        )
    ).scalar_one_or_none()

    if account is None:
        account = Account(
            owner_type=owner_type,
            owner_id=owner_id,
            moneda=moneda,
            mercado=mercado,
            balance_cache=capital_inicial,
            capital_inicial=capital_inicial,
        )
        db.add(account)
        db.flush()
    return account


def acreditar(
    db: Session,
    account: Account,
    monto: Decimal,
    tipo: str,
    ref_type: str | None = None,
    ref_id: int | None = None,
    descripcion: str | None = None,
    usuario: str = "sistema",
) -> AccountEntry:
    return _crear_entry(
        db, account, tipo, monto, "CREDIT",
        ref_type, ref_id, descripcion, usuario,
    )


def debitar(
    db: Session,
    account: Account,
    monto: Decimal,
    tipo: str,
    ref_type: str | None = None,
    ref_id: int | None = None,
    descripcion: str | None = None,
    usuario: str = "sistema",
) -> AccountEntry:
    monto_d = _to_decimal(monto)
    balance_actual = _to_decimal(account.balance_cache)
    if monto_d > balance_actual:
        raise ValueError(
            f"Saldo insuficiente: saldo actual {float(balance_actual):,.2f}, "
            f"débito solicitado {float(monto_d):,.2f}."
        )
    return _crear_entry(
        db, account, tipo, monto, "DEBIT",
        ref_type, ref_id, descripcion, usuario,
    )


def get_account_for_orden(db: Session, orden) -> Account | None:
    """
    Resolves the Account for an order's owner:
      - Bot order  (bot_id set)  → owner_type="bot",     owner_id=bot_id
      - Human order              → owner_type="cliente",  owner_id=Cliente.id
    Returns None if no account is found (execution proceeds without ledger impact).
    """
    if orden.bot_id is not None:
        return get_account(db, "bot", orden.bot_id, orden.moneda or "ARP")

    from app.models.cliente import Cliente
    cliente_obj = db.execute(
        select(Cliente).where(Cliente.codigo == orden.cliente)
    ).scalar_one_or_none()
    if cliente_obj is None:
        return None
    return get_account(db, "cliente", cliente_obj.id, orden.moneda or "ARP")


def impactar_ejecucion(
    db: Session,
    account: Account,
    ejecucion,
    orden,
    comision,
    usuario: str = "sistema",
) -> list[AccountEntry]:
    """
    Creates cash-account entries for a fill execution within the current transaction.

    Locks the Account row (SELECT FOR UPDATE) to serialize concurrent writes.

    Buy  (LIMC/COMP): DEBIT  — cash paid for securities
    Sell (LIMV/VENTA): CREDIT — cash received from securities
    Commission:        always DEBIT (also pending if fill is not settled)

    When ejecucion.liquidada=False, entries are stamped with fecha_liquidacion and
    DEBIT entries increment account.balance_reservado.

    Returns the list of created entries (unflushed).
    """
    # Lock the account row to prevent concurrent balance drift
    locked = db.execute(
        select(Account).where(Account.id == account.id).with_for_update()
    ).scalar_one_or_none()
    if locked is None:
        return []

    entries: list[AccountEntry] = []
    importe = _to_decimal(ejecucion.cantidad) * _to_decimal(ejecucion.precio)
    es_compra = orden.tipo_orden in _TIPOS_COMPRA

    # ── Release order reservation proportionally (human buy orders only) ──────
    # Bot orders don't use the reservation system (they gate on balance_cache > 0).
    if es_compra and orden.bot_id is None:
        aplicacion = _aplicar_reserva_fill_locked(db, locked, orden, ejecucion.cantidad)
        if aplicacion is not None:
            entries.append(aplicacion)

    tipo_principal = "COMPRA" if es_compra else "VENTA"
    sentido_principal = "DEBIT" if es_compra else "CREDIT"
    desc_principal = (
        f"{tipo_principal} {ejecucion.cantidad:,} {orden.especie} "
        f"@ {ejecucion.precio} — {orden.nro_orden} seq#{ejecucion.nro_secuencia}"
    )

    liquidada = bool(ejecucion.liquidada)
    fecha_liq = ejecucion.fecha_liquidacion

    entries.append(_crear_entry(
        db, locked, tipo_principal, importe, sentido_principal,
        ref_type="ejecucion", ref_id=ejecucion.id,
        descripcion=desc_principal, usuario=usuario,
        fecha_liquidacion=fecha_liq,
        liquidada=liquidada,
    ))

    if comision and comision.monto_total and comision.monto_total > 0:
        monto_com = _to_decimal(comision.monto_total)
        entries.append(_crear_entry(
            db, locked, "COMISION", monto_com, "DEBIT",
            ref_type="ejecucion", ref_id=ejecucion.id,
            descripcion=f"Comisión {orden.nro_orden} seq#{ejecucion.nro_secuencia}",
            usuario=usuario,
            fecha_liquidacion=fecha_liq,
            liquidada=liquidada,
        ))

    return entries


def reservar_orden(
    db: Session,
    account: Account,
    orden_id: int,
    monto: Decimal,
    usuario: str = "sistema",
) -> AccountEntry | None:
    """
    Reserves cash for a pending buy order at creation time.

    Creates a RESERVA_COMPRA entry (DEBIT, liquidada=True) that immediately
    reduces balance_cache (and therefore saldo_disponible) without touching
    balance_reservado — avoiding the double-debit that liquidada=False would cause.

    Uses SELECT FOR UPDATE to serialize concurrent writes to the same account.
    Returns None if monto <= 0 (e.g. MERCADO orders with unknown price).
    """
    monto = _to_decimal(monto)
    if monto <= 0:
        return None

    locked = db.execute(
        select(Account).where(Account.id == account.id).with_for_update()
    ).scalar_one_or_none()
    if locked is None:
        return None

    return _crear_entry(
        db, locked, "RESERVA_COMPRA", monto, "DEBIT",
        ref_type="orden", ref_id=orden_id,
        descripcion=f"Reserva orden #{orden_id} — {float(monto):,.2f}",
        usuario=usuario,
        liquidada=True,  # Immediate — not a settlement hold, avoids double-counting
    )


def _aplicar_reserva_fill_locked(
    db: Session,
    locked: Account,
    orden,
    cantidad_fill: int,
) -> AccountEntry | None:
    """
    Internal: releases a proportional portion of the order reservation on fill.
    Must be called with the Account row already locked (SELECT FOR UPDATE).

    Looks up the original RESERVA_COMPRA entry, calculates the per-unit price
    reserved, and creates an APLICACION_RESERVA (CREDIT, liquidada=True) for
    the filled proportion. This neutralises the reservation before the actual
    COMPRA DEBIT is created, preventing double-debit.
    """
    from app.models.account_entry import AccountEntry as AE

    reserva_entry = db.execute(
        select(AE).where(
            AE.account_id == locked.id,
            AE.ref_type == "orden",
            AE.ref_id == orden.id,
            AE.tipo == "RESERVA_COMPRA",
        )
    ).scalar_one_or_none()

    if reserva_entry is None:
        return None  # No reservation found — bot order or pre-feature order

    # Per-unit price at reservation time
    total_reservado = _to_decimal(reserva_entry.monto)
    qty_total = _to_decimal(orden.cantidad_total)
    if qty_total <= 0:
        return None

    precio_unitario_reserva = total_reservado / qty_total
    monto_aplicado = precio_unitario_reserva * _to_decimal(cantidad_fill)

    return _crear_entry(
        db, locked, "APLICACION_RESERVA", monto_aplicado, "CREDIT",
        ref_type="orden", ref_id=orden.id,
        descripcion=f"Aplicación reserva orden #{orden.id} — fill {cantidad_fill:,} ud.",
        usuario="sistema",
        liquidada=True,
    )


def liberar_reserva_orden(
    db: Session,
    account: Account,
    orden_id: int,
    usuario: str = "sistema",
) -> AccountEntry | None:
    """
    Releases the remaining reservation when a buy order is cancelled or expires.

    Calculates remaining = RESERVA_COMPRA - sum(APLICACION_RESERVA) and
    creates a LIBERACION_RESERVA (CREDIT, liquidada=True) for that amount.
    Safe to call multiple times; returns None if nothing to release.
    """
    from app.models.account_entry import AccountEntry as AE
    from sqlalchemy import func

    locked = db.execute(
        select(Account).where(Account.id == account.id).with_for_update()
    ).scalar_one_or_none()
    if locked is None:
        return None

    reserva = db.execute(
        select(func.sum(AE.monto)).where(
            AE.account_id == locked.id,
            AE.ref_type == "orden",
            AE.ref_id == orden_id,
            AE.tipo == "RESERVA_COMPRA",
        )
    ).scalar() or Decimal("0")

    aplicado = db.execute(
        select(func.sum(AE.monto)).where(
            AE.account_id == locked.id,
            AE.ref_type == "orden",
            AE.ref_id == orden_id,
            AE.tipo == "APLICACION_RESERVA",
        )
    ).scalar() or Decimal("0")

    remaining = _to_decimal(reserva) - _to_decimal(aplicado)
    if remaining <= Decimal("0.01"):  # ignore rounding dust
        return None

    return _crear_entry(
        db, locked, "LIBERACION_RESERVA", remaining, "CREDIT",
        ref_type="orden", ref_id=orden_id,
        descripcion=f"Liberación reserva orden #{orden_id} — cancelada/expirada",
        usuario=usuario,
        liquidada=True,
    )


def listar_cuentas(db: Session, owner_type: str | None = None) -> list[Account]:
    stmt = select(Account).where(Account.activa == True)
    if owner_type:
        stmt = stmt.where(Account.owner_type == owner_type)
    return db.execute(stmt.order_by(Account.owner_type, Account.owner_id)).scalars().all()


def listar_entries(
    db: Session,
    account_id: int,
    page: int = 1,
    per_page: int = 50,
) -> dict:
    base = select(AccountEntry).where(AccountEntry.account_id == account_id)
    entries, meta = paginate(db, base, page, per_page, order_by=AccountEntry.created_at.desc())
    return {"entries": [e.to_dict() for e in entries], **meta}


def reconciliar(db: Session, account: Account) -> Decimal:
    """
    Recalculates balance_cache from source of truth (all AccountEntry rows).
    Updates the account in-place. Caller must flush/commit.
    """
    result = db.execute(
        select(
            func.sum(
                case(
                    (AccountEntry.sentido == "CREDIT", AccountEntry.monto),
                    else_=-AccountEntry.monto,
                )
            )
        ).where(AccountEntry.account_id == account.id)
    ).scalar()

    balance = Decimal(str(result or 0))
    account.balance_cache = balance
    db.flush()
    return balance


def ajuste_manual(
    db: Session,
    account: Account,
    monto: Decimal,
    sentido: str,
    descripcion: str,
    usuario: str,
) -> AccountEntry:
    """
    Creates a manual adjustment with SELECT FOR UPDATE to serialize writes.
    Requires descripcion (auditor-friendly reason).
    Raises ValueError if a DEBIT would leave the balance negative.
    """
    locked = db.execute(
        select(Account).where(Account.id == account.id).with_for_update()
    ).scalar_one()

    if sentido == "DEBIT":
        balance_actual = _to_decimal(locked.balance_cache)
        monto_d = _to_decimal(monto)
        if monto_d > balance_actual:
            raise ValueError(
                f"Saldo insuficiente: saldo actual {float(balance_actual):,.2f}, "
                f"débito solicitado {float(monto_d):,.2f}."
            )

    tipo = "AJUSTE_CREDITO" if sentido == "CREDIT" else "AJUSTE_DEBITO"
    return _crear_entry(
        db, locked, tipo, _to_decimal(monto), sentido,
        ref_type="manual",
        descripcion=descripcion,
        usuario=usuario,
    )


def get_rendimiento_bot(db: Session, bot_id: int) -> dict:
    """
    Performance metrics for a single bot account.
    Based on AccountEntry aggregates — independent of the positions table.
    """
    from app.models.bot_instancia import BotInstancia
    from app.models.ejecucion import Ejecucion
    from app.models.orden import Orden

    bot = db.get(BotInstancia, bot_id)
    if bot is None:
        return {}

    account = get_account(db, "bot", bot_id)
    if account is None:
        return {
            "bot_id": bot_id,
            "bot_nombre": bot.nombre,
            "sin_cuenta": True,
            "mensaje": "Bot sin cuenta asignada. Asigná capital para ver métricas.",
        }

    # Aggregate entries by (tipo, sentido)
    rows = db.execute(
        select(
            AccountEntry.tipo,
            AccountEntry.sentido,
            func.sum(AccountEntry.monto).label("total"),
            func.count(AccountEntry.id).label("n"),
        )
        .where(AccountEntry.account_id == account.id)
        .group_by(AccountEntry.tipo, AccountEntry.sentido)
    ).all()

    totales: dict[tuple, Decimal] = {}
    for tipo, sentido, total, _ in rows:
        totales[(tipo, sentido)] = Decimal(str(total or 0))

    total_compras    = totales.get(("COMPRA",   "DEBIT"),  Decimal("0"))
    total_ventas     = totales.get(("VENTA",    "CREDIT"), Decimal("0"))
    total_comisiones = totales.get(("COMISION", "DEBIT"),  Decimal("0"))

    pnl_realizado  = total_ventas - total_compras - total_comisiones
    capital_ini    = _to_decimal(account.capital_inicial)
    balance_cash   = _to_decimal(account.balance_cache)

    retorno_pct = (
        float((balance_cash - capital_ini) / capital_ini * 100)
        if capital_ini > 0 else 0.0
    )

    n_operaciones = db.execute(
        select(func.count(Ejecucion.id))
        .join(Orden, Ejecucion.orden_id == Orden.id)
        .where(Orden.bot_id == bot_id)
    ).scalar() or 0

    volumen = db.execute(
        select(func.sum(Ejecucion.cantidad * Ejecucion.precio))
        .join(Orden, Ejecucion.orden_id == Orden.id)
        .where(Orden.bot_id == bot_id)
    ).scalar() or 0

    return {
        "bot_id":           bot_id,
        "bot_nombre":       bot.nombre,
        "account_id":       account.id,
        "moneda":           account.moneda,
        "capital_inicial":  float(capital_ini),
        "balance_cash":     float(balance_cash),
        "total_compras":    float(total_compras),
        "total_ventas":     float(total_ventas),
        "total_comisiones": float(total_comisiones),
        "pnl_realizado":    float(pnl_realizado),
        "retorno_pct":      round(retorno_pct, 4),
        "n_operaciones":    n_operaciones,
        "volumen_operado":  float(volumen),
    }
