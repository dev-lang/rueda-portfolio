"""
Admin router — ticker management and market bot control (ADMIN only).

GET    /api/admin/tickers           — list all tickers
POST   /api/admin/tickers           — add new ticker
PATCH  /api/admin/tickers/{especie} — update ticker (activo, yf_symbol, panel, nombre)
DELETE /api/admin/tickers/{especie} — remove ticker permanently

GET    /api/admin/bots              — list all bot instances
POST   /api/admin/bots              — create bot instance
PATCH  /api/admin/bots/{id}         — update bot (enabled, interval, variance, max_ordenes, tipos_orden)
DELETE /api/admin/bots/{id}         — remove bot instance
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.core.deps import require_role
from app.core.get_or_404 import get_or_404, query_or_404
from app.db.session import get_db
from app.models.especie_mercado import EspecieMercado
from app.models.bot_instancia import BotInstancia, TIPOS_COMPRA, TIPOS_VENTA
from app.models.user import User
from app.models.orden import Orden
from app.models.ejecucion import Ejecucion
from app.models.precio_mercado import PrecioMercado
from app.models.config_sistema import ConfigSistema
from app.schemas.admin import (
    TickerCreate, TickerUpdate,
    BotCreate, BotUpdate, BotBulkUpdate,
    ConfigUpdate,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])
_admin = require_role("ADMIN")


# ── Ticker endpoints ───────────────────────────────────────────────────────────

@router.get("/tickers")
def list_tickers(
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    tickers = db.execute(
        select(EspecieMercado).order_by(EspecieMercado.panel, EspecieMercado.especie)
    ).scalars().all()
    return [t.to_dict() for t in tickers]


@router.post("/tickers", status_code=status.HTTP_201_CREATED)
def create_ticker(
    payload: TickerCreate,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    especie = payload.especie.upper().strip()
    existing = db.execute(
        select(EspecieMercado).where(EspecieMercado.especie == especie)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"El ticker '{especie}' ya existe.",
        )
    ticker = EspecieMercado(
        especie=especie,
        yf_symbol=payload.yf_symbol,
        panel=payload.panel.upper().strip(),
        nombre=payload.nombre,
        activo=True,
    )
    db.add(ticker)
    db.commit()
    db.refresh(ticker)
    return ticker.to_dict()


@router.patch("/tickers/{especie}")
def update_ticker(
    especie: str,
    payload: TickerUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    especie = especie.upper().strip()
    ticker = query_or_404(
        db, select(EspecieMercado).where(EspecieMercado.especie == especie),
        "Ticker no encontrado.",
    )
    if payload.yf_symbol is not None:
        ticker.yf_symbol = payload.yf_symbol or None
    if payload.panel is not None:
        ticker.panel = payload.panel.upper().strip()
    if payload.activo is not None:
        ticker.activo = payload.activo
    if payload.nombre is not None:
        ticker.nombre = payload.nombre or None
    if payload.volumen_max_dia is not None:
        ticker.volumen_max_dia = payload.volumen_max_dia if payload.volumen_max_dia > 0 else None
    if payload.cantidad_max_orden is not None:
        ticker.cantidad_max_orden = payload.cantidad_max_orden if payload.cantidad_max_orden > 0 else None

    db.commit()
    db.refresh(ticker)
    return ticker.to_dict()


@router.delete("/tickers/{especie}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ticker(
    especie: str,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    especie = especie.upper().strip()
    ticker = query_or_404(
        db, select(EspecieMercado).where(EspecieMercado.especie == especie),
        "Ticker no encontrado.",
    )
    db.delete(ticker)
    db.commit()


# ── Bot instances CRUD ─────────────────────────────────────────────────────────

@router.get("/bots")
def list_bots(
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    bots = db.execute(select(BotInstancia).order_by(BotInstancia.id)).scalars().all()
    return [b.to_dict() for b in bots]


@router.post("/bots", status_code=status.HTTP_201_CREATED)
def create_bot(
    payload: BotCreate,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    nombre = payload.nombre.strip()
    if db.execute(select(BotInstancia).where(BotInstancia.nombre == nombre)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Ya existe un bot con el nombre '{nombre}'.")
    bot = BotInstancia(
        nombre=nombre,
        enabled=payload.enabled,
        interval=max(1.0, payload.interval),
        variance=max(0.0001, min(0.05, payload.variance)),
        max_ordenes=max(1, payload.max_ordenes),
        tipos_orden=",".join(payload.tipos_orden),
        perfil=payload.perfil,
        fill_rate=payload.fill_rate,
        offset_min_compra=payload.offset_min_compra,
        offset_max_compra=payload.offset_max_compra,
        offset_min_venta=payload.offset_min_venta,
        offset_max_venta=payload.offset_max_venta,
        stale_offset_pct=payload.stale_offset_pct,
        capital_fraccion_max=payload.capital_fraccion_max,
        ciclo_min_ticks=payload.ciclo_min_ticks,
        ciclo_max_ticks=payload.ciclo_max_ticks,
        fill_react_prob=payload.fill_react_prob,
        fill_react_markup=payload.fill_react_markup,
        prob_orden_mercado=payload.prob_orden_mercado,
        respetar_horario=payload.respetar_horario,
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)
    return bot.to_dict()


@router.patch("/bots/bulk")
def bulk_update_bots(
    payload: BotBulkUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    """Set respetar_horario for every bot instance at once."""
    bots = db.execute(select(BotInstancia)).scalars().all()
    for bot in bots:
        bot.respetar_horario = payload.respetar_horario
    db.commit()
    return {"updated": len(bots), "respetar_horario": payload.respetar_horario}


@router.patch("/bots/{bot_id}")
def update_bot(
    bot_id: int,
    payload: BotUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    bot = get_or_404(db, BotInstancia, bot_id, "Bot no encontrado.")
    if payload.nombre is not None:
        bot.nombre = payload.nombre.strip()
    if payload.enabled is not None:
        bot.enabled = payload.enabled
    if payload.interval is not None:
        bot.interval = max(1.0, payload.interval)
    if payload.variance is not None:
        bot.variance = max(0.0001, min(0.05, payload.variance))
    if payload.max_ordenes is not None:
        bot.max_ordenes = max(1, payload.max_ordenes)
    if payload.tipos_orden is not None:
        bot.tipos_orden = ",".join(payload.tipos_orden)
    if payload.perfil is not None:
        bot.perfil = payload.perfil
    if payload.fill_rate is not None:
        bot.fill_rate = payload.fill_rate
    if "offset_min_compra" in payload.model_fields_set:
        bot.offset_min_compra = payload.offset_min_compra
    if "offset_max_compra" in payload.model_fields_set:
        bot.offset_max_compra = payload.offset_max_compra
    if "offset_min_venta" in payload.model_fields_set:
        bot.offset_min_venta = payload.offset_min_venta
    if "offset_max_venta" in payload.model_fields_set:
        bot.offset_max_venta = payload.offset_max_venta
    # Per-bot behaviour overrides — use model_fields_set so sending null clears the override
    if "stale_offset_pct" in payload.model_fields_set:
        bot.stale_offset_pct = payload.stale_offset_pct
    if "capital_fraccion_max" in payload.model_fields_set:
        bot.capital_fraccion_max = payload.capital_fraccion_max
    if "ciclo_min_ticks" in payload.model_fields_set:
        bot.ciclo_min_ticks = payload.ciclo_min_ticks
    if "ciclo_max_ticks" in payload.model_fields_set:
        bot.ciclo_max_ticks = payload.ciclo_max_ticks
    if "fill_react_prob" in payload.model_fields_set:
        bot.fill_react_prob = payload.fill_react_prob
    if "fill_react_markup" in payload.model_fields_set:
        bot.fill_react_markup = payload.fill_react_markup
    if "prob_orden_mercado" in payload.model_fields_set:
        bot.prob_orden_mercado = payload.prob_orden_mercado
    if payload.respetar_horario is not None:
        bot.respetar_horario = payload.respetar_horario
    db.commit()
    db.refresh(bot)
    return bot.to_dict()


@router.delete("/bots/{bot_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bot(
    bot_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    bot = get_or_404(db, BotInstancia, bot_id, "Bot no encontrado.")
    db.delete(bot)
    db.commit()


# ── Bot positions ───────────────────────────────────────────────────────────────

@router.get("/bots/{bot_id}/posiciones")
def get_bot_posiciones(
    bot_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    """
    Returns per-species position summary for a single bot, derived from its
    executed fills (Orden.bot_id = bot_id).  Since all bots share the same
    'BOT' client in the posiciones table, this endpoint calculates positions
    directly from execution records so each bot's inventory is reported separately.
    """
    get_or_404(db, BotInstancia, bot_id, "Bot no encontrado.")

    # Aggregate fills by (especie, side)
    rows = db.execute(
        select(
            Orden.especie,
            Orden.tipo_orden,
            func.sum(Ejecucion.cantidad).label("cantidad"),
            func.sum(Ejecucion.cantidad * Ejecucion.precio).label("valor_total"),
        )
        .join(Ejecucion, Ejecucion.orden_id == Orden.id)
        .where(Orden.bot_id == bot_id)
        .group_by(Orden.especie, Orden.tipo_orden)
    ).all()

    # Collapse into per-especie buckets
    from collections import defaultdict
    buckets: dict[str, dict] = defaultdict(
        lambda: {"comprada": 0, "vendida": 0, "valor_compra": 0.0}
    )
    for especie, tipo, cantidad, valor_total in rows:
        t = tipo.upper()
        if t in TIPOS_COMPRA:
            buckets[especie]["comprada"] += cantidad
            buckets[especie]["valor_compra"] += valor_total or 0.0
        elif t in TIPOS_VENTA:
            buckets[especie]["vendida"] += cantidad

    if not buckets:
        return []

    # Fetch current prices in one query
    precios = {
        r[0]: r[1]
        for r in db.execute(
            select(PrecioMercado.especie, PrecioMercado.precio)
            .where(PrecioMercado.especie.in_(list(buckets.keys())))
        ).all()
    }

    result = []
    for especie, d in buckets.items():
        neta = d["comprada"] - d["vendida"]
        costo_prom = (
            round(d["valor_compra"] / d["comprada"], 4) if d["comprada"] > 0 else 0.0
        )
        precio_actual = precios.get(especie) or 0.0
        valor_mercado = round(neta * precio_actual, 2)
        pnl = round(valor_mercado - neta * costo_prom, 2) if neta > 0 and costo_prom > 0 else None
        result.append({
            "especie": especie,
            "cantidad_comprada": d["comprada"],
            "cantidad_vendida": d["vendida"],
            "cantidad_neta": neta,
            "costo_promedio": costo_prom,
            "precio_actual": precio_actual,
            "valor_mercado": valor_mercado,
            "pnl_estimado": pnl,
        })

    # Sort: positions with inventory first, then by especie name
    result.sort(key=lambda x: (-abs(x["cantidad_neta"]), x["especie"]))
    return result


# ── System config ───────────────────────────────────────────────────────────────

@router.get("/config")
def get_config(
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    cfg = db.get(ConfigSistema, 1)
    if cfg is None:
        return {"auto_matching": False, "matching_mercado": "DEFAULT", "mercado_sesgo": 0.0, "updated_at": None}
    return cfg.to_dict()


@router.patch("/config")
def update_config(
    payload: ConfigUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    cfg = db.get(ConfigSistema, 1)
    if cfg is None:
        cfg = ConfigSistema(id=1, auto_matching=False, matching_mercado="DEFAULT", mercado_sesgo=0.0)
        db.add(cfg)
    if payload.auto_matching is not None:
        cfg.auto_matching = payload.auto_matching
    if payload.matching_mercado is not None:
        cfg.matching_mercado = payload.matching_mercado.upper().strip()
    if payload.mercado_sesgo is not None:
        cfg.mercado_sesgo = max(-1.0, min(1.0, payload.mercado_sesgo))
    db.commit()
    db.refresh(cfg)
    return cfg.to_dict()


# ── Demo data reset ─────────────────────────────────────────────────────────────

@router.delete("/demo-reset", status_code=status.HTTP_200_OK)
def demo_reset(
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    """
    Wipes all transactional demo data: orders, executions, positions,
    account ledger entries, and resets account balances to zero.

    Seeds, configuration, bot instances, tickers, clients, and users
    are preserved.  This is a destructive, irreversible operation.
    """
    from sqlalchemy import delete, update, text as _text
    from app.models.orden import Orden
    from app.models.ejecucion import Ejecucion
    from app.models.posicion import Posicion
    from app.models.account import Account
    from app.models.account_entry import AccountEntry
    from app.models.notificacion import Notificacion

    # Delete in FK-safe order
    db.execute(delete(AccountEntry))
    db.execute(delete(Ejecucion))
    db.execute(delete(Orden))
    db.execute(delete(Posicion))
    db.execute(delete(Notificacion))

    # Reset account balances
    db.execute(update(Account).values(balance_cache=0, balance_reservado=0))

    # Reset SQLite autoincrement counters so new rows start from 1.
    # Whitelist-controlled: only the tables deleted above are eligible.
    _RESET_TABLES = frozenset(("ordenes", "ejecuciones", "posiciones", "account_entries", "notificaciones"))
    for tabla in _RESET_TABLES:
        try:
            db.execute(_text("DELETE FROM sqlite_sequence WHERE name=:t"), {"t": tabla})
        except Exception:
            pass  # sqlite_sequence only exists after the first INSERT

    db.commit()
    return {"ok": True, "mensaje": "Reinicio completado. Órdenes, ejecuciones, posiciones y movimientos de cuenta vaciados."}
