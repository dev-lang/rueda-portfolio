"""
Firma router — admin-only management of the firm's proprietary book.

All operations target accounts owned by clients marked es_cartera_propia=True.
The primary firm account is the "STD" client. Additional cartera_propia clients
are automatically included in consolidated views.

Endpoints:
  GET  /api/firma/saldo        → consolidated balances by currency
  GET  /api/firma/movimientos  → ledger history across all firm accounts
  POST /api/firma/deposito     → credit firm account (ADMIN)
  POST /api/firma/retiro       → debit firm account (ADMIN)
  GET  /api/firma/posiciones   → net positions of all cartera_propia clients
  GET  /api/firma/pnl          → P&L rows for all cartera_propia clients
"""

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.pagination import paginate

from app.core.deps import require_role
from app.core.get_or_404 import query_or_404
from app.db.session import get_db
from app.models.account import Account
from app.models.account_entry import AccountEntry
from app.models.cliente import Cliente
from app.models.user import User
from app.services import account_service, posicion_service
from app.schemas.cuentas import MovimientoFirmaRequest

router = APIRouter(prefix="/api/firma", tags=["firma"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_cuentas_propias(db: Session) -> list[Account]:
    """Returns all active accounts for es_cartera_propia clients."""
    propias_ids = db.execute(
        select(Cliente.id).where(Cliente.es_cartera_propia == True)
    ).scalars().all()
    if not propias_ids:
        return []
    return db.execute(
        select(Account).where(
            Account.owner_type == "cliente",
            Account.owner_id.in_(propias_ids),
            Account.activa == True,
        )
    ).scalars().all()


def _get_cuenta_std(db: Session, moneda: str = "ARP") -> Account:
    """Resolves the main firm account (STD). Raises 404 if not configured."""
    std = query_or_404(
        db, select(Cliente).where(Cliente.codigo == "STD"),
        "Cliente STD no encontrado.",
    )
    account = account_service.get_account(db, "cliente", std.id, moneda)
    if account is None:
        raise HTTPException(
            status_code=404,
            detail=f"Cuenta STD en {moneda} no encontrada. "
                   "Verificá que seed_cuentas() se haya ejecutado al iniciar.",
        )
    return account


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/saldo")
def get_saldo_firma(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """
    Consolidated cash position for all firm (es_cartera_propia) accounts.
    Groups balances by currency and exposes per-account detail.
    """
    cuentas = _get_cuentas_propias(db)
    if not cuentas:
        return {"saldo": [], "total_cuentas": 0}

    cliente_ids = [c.owner_id for c in cuentas]
    cliente_map = {
        c.id: c.codigo
        for c in db.execute(
            select(Cliente).where(Cliente.id.in_(cliente_ids))
        ).scalars().all()
    }

    por_moneda: dict[str, dict] = {}
    for cuenta in cuentas:
        m = cuenta.moneda
        disponible = float((cuenta.balance_cache or 0) - (cuenta.balance_reservado or 0))
        if m not in por_moneda:
            por_moneda[m] = {
                "moneda": m,
                "balance_total": 0.0,
                "balance_disponible": 0.0,
                "cuentas": [],
            }
        por_moneda[m]["balance_total"] += float(cuenta.balance_cache or 0)
        por_moneda[m]["balance_disponible"] += disponible
        por_moneda[m]["cuentas"].append({
            "account_id":        cuenta.id,
            "cliente":           cliente_map.get(cuenta.owner_id, str(cuenta.owner_id)),
            "balance":           float(cuenta.balance_cache or 0),
            "balance_disponible": disponible,
            "capital_inicial":   float(cuenta.capital_inicial or 0),
        })

    return {"saldo": list(por_moneda.values()), "total_cuentas": len(cuentas)}


@router.get("/movimientos")
def get_movimientos_firma(
    page: int = 1,
    per_page: int = 50,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """Paginated ledger history across all firm accounts, newest first."""
    cuentas = _get_cuentas_propias(db)
    if not cuentas:
        return {"entries": [], "total": 0, "pages": 1, "current_page": 1, "per_page": per_page}

    account_ids = [c.id for c in cuentas]
    base = select(AccountEntry).where(AccountEntry.account_id.in_(account_ids))
    entries, meta = paginate(db, base, page, per_page, order_by=AccountEntry.created_at.desc())
    return {"entries": [e.to_dict() for e in entries], **meta}


@router.post("/deposito")
def depositar_firma(
    payload: MovimientoFirmaRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("ADMIN")),
):
    """Credits the firm's main account (STD). Recorded as AJUSTE_CREDITO with audit trail."""
    account = _get_cuenta_std(db, payload.moneda)
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
    return {"entry": entry.to_dict(), "balance_post": float(account.balance_cache)}


@router.post("/retiro")
def retirar_firma(
    payload: MovimientoFirmaRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("ADMIN")),
):
    """Debits the firm's main account (STD). Raises 422 if insufficient balance."""
    account = _get_cuenta_std(db, payload.moneda)
    try:
        entry = account_service.ajuste_manual(
            db,
            account,
            monto=Decimal(str(payload.monto)),
            sentido="DEBIT",
            descripcion=payload.descripcion,
            usuario=current_user.username,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    db.commit()
    db.refresh(entry)
    db.refresh(account)
    return {"entry": entry.to_dict(), "balance_post": float(account.balance_cache)}


@router.get("/posiciones")
def get_posiciones_firma(
    especie: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """
    Raw position rows for all es_cartera_propia clients.
    For an aggregated view grouped by especie, use GET /api/positions/consolidada.
    """
    propias = db.execute(
        select(Cliente.codigo).where(Cliente.es_cartera_propia == True)
    ).scalars().all()

    posiciones = []
    for codigo in propias:
        rows = posicion_service.listar_posiciones(db, cliente=codigo, especie=especie)
        posiciones.extend([p.to_dict() for p in rows])

    return {"posiciones": posiciones, "total": len(posiciones)}


@router.get("/pnl")
def get_pnl_firma(
    fecha_desde: date | None = None,
    fecha_hasta: date | None = None,
    especie: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    """P&L rows for all es_cartera_propia clients. Requires cerrar_dia to have been run."""
    from app.services import pnl_service

    propias = db.execute(
        select(Cliente.codigo).where(Cliente.es_cartera_propia == True)
    ).scalars().all()

    all_pnl = []
    for codigo in propias:
        rows = pnl_service.listar_pnl(
            db,
            fecha_desde=fecha_desde,
            fecha_hasta=fecha_hasta,
            cliente=codigo,
            especie=especie,
        )
        all_pnl.extend([r.to_dict() for r in rows])

    return {"pnl": all_pnl, "total": len(all_pnl)}
