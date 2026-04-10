"""
Cuentas corrientes (ledger) API.

Endpoints:
  GET  /api/cuentas                               → list all active accounts
  GET  /api/cuentas/{id}                          → single account detail
  GET  /api/cuentas/{id}/movimientos              → paginated entry history
  POST /api/cuentas/{id}/ajuste                   → manual credit/debit (ADMIN)
  POST /api/cuentas/{id}/reconciliar              → recalculate balance from entries (ADMIN)
  GET  /api/cuentas/bots/{bot_id}/rendimiento     → bot performance metrics
  GET  /api/cuentas/operadores                    → list all operador accounts (ADMIN)
  GET  /api/cuentas/operadores/{op_id}            → single operador account (ADMIN)
  GET  /api/cuentas/operadores/{op_id}/movimientos → ledger history (ADMIN)
  POST /api/cuentas/operadores/{op_id}/deposito   → credit operador account (ADMIN)
  POST /api/cuentas/operadores/{op_id}/retiro     → debit operador account (ADMIN)
"""

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.core.get_or_404 import get_or_404, query_or_404
from app.db.session import get_db
from app.models.account import Account
from app.models.bot_instancia import BotInstancia
from app.models.cliente import Cliente
from app.models.operador import Operador
from app.models.user import User
from app.services import account_service
from app.schemas.cuentas import (
    AjusteManualRequest, InicializarCuentaBotRequest, MovimientoOperadorRequest,
)

router = APIRouter(prefix="/api/cuentas", tags=["cuentas"])


# ── Authorization helpers ──────────────────────────────────────────────────────

def _check_account_access(account: Account, current_user: User, db: Session) -> None:
    """
    Raises 403 if current_user is not authorized to access the given account.

    Rules:
    - ADMIN: unrestricted.
    - OPERADOR: can only access accounts whose owner is their assigned client
      (owner_type='cliente' AND Cliente.codigo == operador.cliente_codigo).
    - Other roles: denied.
    """
    if current_user.role == "ADMIN":
        return

    if current_user.role == "OPERADOR" and account.owner_type == "cliente":
        op = db.execute(
            select(Operador).where(
                Operador.username == current_user.username,
                Operador.activo.is_(True),
            )
        ).scalar_one_or_none()
        if op and op.cliente_codigo:
            cliente = db.get(Cliente, account.owner_id)
            if cliente and cliente.codigo == op.cliente_codigo:
                return

    raise HTTPException(status_code=403, detail="Acceso denegado.")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/proyeccion")
def proyeccion_caja(
    cliente: str = "STD",
    moneda: str = "ARP",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Real-time cash projection: current balance minus notional of all pending buy orders.
    Used by the intraday cash panel to show committed vs free cash.
    """
    if current_user.role != "ADMIN":
        op = db.execute(
            select(Operador).where(
                Operador.username == current_user.username,
                Operador.activo.is_(True),
            )
        ).scalar_one_or_none()
        if not op or op.cliente_codigo != cliente.upper():
            raise HTTPException(status_code=403, detail="Acceso denegado al cliente solicitado.")

    from app.services import proyeccion_service
    return proyeccion_service.calcular_proyeccion(db, cliente_codigo=cliente, moneda=moneda)


@router.get("")
def listar_cuentas(
    owner_type: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """Lists all active accounts, optionally filtered by owner_type (cliente|bot). ADMIN only."""
    cuentas = account_service.listar_cuentas(db, owner_type)
    return {"cuentas": [c.to_dict() for c in cuentas], "total": len(cuentas)}


@router.post("/bots/{bot_id}/inicializar")
def inicializar_cuenta_bot(
    bot_id: int,
    payload: InicializarCuentaBotRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """
    Creates a cash account for a bot that doesn't have one yet (ADMIN only).
    Records an initial BOT_ASIGNACION entry and links cuenta_id on BotInstancia.
    """
    bot = get_or_404(db, BotInstancia, bot_id, "Bot no encontrado.")
    existing = account_service.get_account(db, "bot", bot_id)
    if existing:
        raise HTTPException(status_code=422, detail="El bot ya tiene una cuenta asignada.")

    capital = Decimal(str(payload.capital_inicial))
    account = account_service.get_or_create_account(
        db, "bot", bot_id, capital_inicial=capital,
    )
    account_service.acreditar(
        db, account, capital, tipo="BOT_ASIGNACION",
        descripcion=f"Capital inicial asignado al bot {bot.nombre}",
        usuario="admin",
    )
    bot.cuenta_id = account.id
    db.commit()
    db.refresh(account)

    return {
        "account_id":      account.id,
        "capital_inicial": float(capital),
        "balance_cache":   float(account.balance_cache),
    }


@router.get("/bots/{bot_id}/rendimiento")
def rendimiento_bot(
    bot_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Performance metrics for a bot account:
    PnL realizado, capital inicial vs actual, retorno %, operaciones, volumen.
    """
    result = account_service.get_rendimiento_bot(db, bot_id)
    if not result:
        raise HTTPException(status_code=404, detail="Bot no encontrado.")
    return result


# ── Operador account endpoints (ADMIN only) ───────────────────────────────────

def _get_operador_or_404(db: Session, op_id: int) -> Operador:
    return get_or_404(db, Operador, op_id, "Operador no encontrado.")


def _get_cuenta_operador_or_404(db: Session, op_id: int, moneda: str = "ARP") -> Account:
    account = account_service.get_account(db, "operador", op_id, moneda)
    if not account:
        raise HTTPException(
            status_code=404,
            detail=f"El operador {op_id} no tiene cuenta en {moneda}. "
                   "Inicializala primero con POST /api/cuentas/operadores/{op_id}/deposito.",
        )
    return account


@router.get("/operadores")
def listar_cuentas_operadores(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """Lists cash accounts for all operadores, with their profile data."""
    operadores = db.execute(select(Operador).order_by(Operador.nombre)).scalars().all()
    result = []
    for op in operadores:
        cuenta = account_service.get_account(db, "operador", op.id)
        result.append({
            "operador": op.to_dict(),
            "cuenta":   cuenta.to_dict() if cuenta else None,
        })
    return {"operadores": result, "total": len(result)}


@router.get("/operadores/{op_id}")
def get_cuenta_operador(
    op_id: int,
    moneda: str = "ARP",
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """Detail for a single operador's cash account."""
    op = _get_operador_or_404(db, op_id)
    cuenta = _get_cuenta_operador_or_404(db, op_id, moneda)
    return {"operador": op.to_dict(), "cuenta": cuenta.to_dict()}


@router.get("/operadores/{op_id}/movimientos")
def movimientos_operador(
    op_id: int,
    moneda: str = "ARP",
    page: int = 1,
    per_page: int = 50,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """Paginated ledger history for an operador's account."""
    _get_operador_or_404(db, op_id)
    cuenta = _get_cuenta_operador_or_404(db, op_id, moneda)
    return account_service.listar_entries(db, cuenta.id, page, per_page)


@router.post("/operadores/{op_id}/deposito")
def depositar_operador(
    op_id: int,
    payload: MovimientoOperadorRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("ADMIN")),
):
    """
    Credits an operador's account. Creates the account automatically if it
    doesn't exist yet (first deposit acts as account initialisation).
    """
    op = _get_operador_or_404(db, op_id)
    account = account_service.get_or_create_account(
        db, "operador", op_id,
        moneda=payload.moneda,
        capital_inicial=Decimal("0"),
    )
    entry = account_service.ajuste_manual(
        db,
        account,
        monto=Decimal(str(payload.monto)),
        sentido="CREDIT",
        descripcion=payload.descripcion,
        usuario=current_user.username,
    )
    db.commit()
    db.refresh(entry)
    db.refresh(account)
    return {
        "operador":    op.to_dict(),
        "entry":       entry.to_dict(),
        "balance_post": float(account.balance_cache),
    }


@router.post("/operadores/{op_id}/retiro")
def retirar_operador(
    op_id: int,
    payload: MovimientoOperadorRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("ADMIN")),
):
    """Debits an operador's account. Raises 422 if insufficient balance."""
    op = _get_operador_or_404(db, op_id)
    cuenta = _get_cuenta_operador_or_404(db, op_id, payload.moneda)
    try:
        entry = account_service.ajuste_manual(
            db,
            cuenta,
            monto=Decimal(str(payload.monto)),
            sentido="DEBIT",
            descripcion=payload.descripcion,
            usuario=current_user.username,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    db.commit()
    db.refresh(entry)
    db.refresh(cuenta)
    return {
        "operador":    op.to_dict(),
        "entry":       entry.to_dict(),
        "balance_post": float(cuenta.balance_cache),
    }


# ── Generic account endpoints ─────────────────────────────────────────────────

@router.get("/{account_id}")
def get_cuenta(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    account = get_or_404(db, Account, account_id, "Cuenta no encontrada.")
    _check_account_access(account, current_user, db)
    return account.to_dict()


@router.get("/{account_id}/movimientos")
def listar_movimientos(
    account_id: int,
    page: int = 1,
    per_page: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Paginated ledger history for a single account, newest first."""
    account = get_or_404(db, Account, account_id, "Cuenta no encontrada.")
    _check_account_access(account, current_user, db)
    return account_service.listar_entries(db, account_id, page, per_page)


@router.post("/{account_id}/ajuste")
def ajuste_manual(
    account_id: int,
    payload: AjusteManualRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("ADMIN")),
):
    """
    Manual credit or debit adjustment (ADMIN only).
    Always recorded with descripcion for audit purposes.
    """
    if payload.sentido not in ("CREDIT", "DEBIT"):
        raise HTTPException(status_code=422, detail="sentido debe ser CREDIT o DEBIT.")

    account = get_or_404(db, Account, account_id, "Cuenta no encontrada.")
    if not account.activa:
        raise HTTPException(status_code=422, detail="No se puede ajustar una cuenta inactiva.")

    try:
        entry = account_service.ajuste_manual(
            db,
            account,
            monto=Decimal(str(payload.monto)),
            sentido=payload.sentido,
            descripcion=payload.descripcion,
            usuario=current_user.username,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    db.commit()
    db.refresh(entry)
    db.refresh(account)

    return {
        "entry":        entry.to_dict(),
        "balance_post": float(account.balance_cache),
    }


@router.post("/{account_id}/reconciliar")
def reconciliar(
    account_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """
    Recalculates balance_cache by summing all AccountEntry rows (source of truth).
    Use to detect and fix any drift in the cached balance.
    """
    account = query_or_404(
        db,
        select(Account).where(Account.id == account_id).with_for_update(),
        "Cuenta no encontrada.",
    )

    balance_antes = float(account.balance_cache or 0)
    balance_nuevo = account_service.reconciliar(db, account)
    db.commit()

    return {
        "account_id":      account_id,
        "balance_antes":   balance_antes,
        "balance_nuevo":   float(balance_nuevo),
        "drift":           float(balance_nuevo) - balance_antes,
    }
