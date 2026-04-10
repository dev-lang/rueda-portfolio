"""
User watchlist router — track and manage followed instruments.

GET    /api/seguidos/lista           — get user's watchlist with full market data
POST   /api/seguidos                 — add instrument to watchlist
DELETE /api/seguidos/{seguido_id}    — remove from watchlist
PUT    /api/seguidos/{seguido_id}    — update price targets
GET    /api/seguidos/especies        — list available species for watchlist
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.models.usuario_seguido import UsuarioSeguido
from app.models.precio_mercado import PrecioMercado
from app.models.posicion import Posicion
from app.models.especie_mercado import EspecieMercado
from app.models.operador import Operador

router = APIRouter(prefix="/api/seguidos", tags=["seguidos"])


def _cliente_codigos_usuario(db: Session, user: User) -> list[str]:
    """Return client codes accessible to this user (all for ADMIN, own for OPERADOR)."""
    if user.role == "ADMIN":
        return []  # empty = no filter (all)
    op = db.execute(
        select(Operador).where(Operador.username == user.username, Operador.activo.is_(True))
    ).scalar_one_or_none()
    if op and op.cliente_codigo:
        return [op.cliente_codigo]
    return []  # no linked client → no positions


# ────────────────────────────────────────────────────────────────────────────────
# Schemas
# ────────────────────────────────────────────────────────────────────────────────

class SeguirEspecieRequest(BaseModel):
    especie: str
    precio_compra_meta: float | None = None
    precio_venta_meta: float | None = None


class ActualizarMetasRequest(BaseModel):
    precio_compra_meta: float | None = None
    precio_venta_meta: float | None = None


class ReordenarRequest(BaseModel):
    ids: list[int]


class SeguridoResponse(BaseModel):
    id: int
    especie: str
    orden: int | None
    # Market prices
    precio_actual: float | None
    variacion_diaria: float | None
    precio_cierre: float | None
    precio_minimo_dia: float | None
    precio_maximo_dia: float | None
    # Position data (aggregated for user's entire book, not per account)
    cantidad_compra: int
    precio_promedio_compra: float
    cantidad_venta: int
    precio_promedio_venta: float
    # Targets
    precio_compra_meta: float | None
    precio_venta_meta: float | None


# ────────────────────────────────────────────────────────────────────────────────
# Endpoints
# ────────────────────────────────────────────────────────────────────────────────

@router.get("/lista")
def get_lista_seguidos(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SeguridoResponse]:
    """Get user's watchlist with complete market and position data."""

    # Get all followed instruments
    seguidos = db.execute(
        select(UsuarioSeguido)
        .where(UsuarioSeguido.usuario_id == user.id)
        .order_by(
            UsuarioSeguido.orden.is_(None).asc(),
            UsuarioSeguido.orden.asc(),
            UsuarioSeguido.especie.asc(),
        )
    ).scalars().all()

    if not seguidos:
        return []

    especies = [s.especie for s in seguidos]

    # Get prices
    precios = db.execute(
        select(PrecioMercado).where(PrecioMercado.especie.in_(especies))
    ).scalars().all()
    precios_map = {p.especie: p for p in precios}

    # Get positions aggregated by especie (single query, no N+1)
    codigos = _cliente_codigos_usuario(db, user)
    pos_query = (
        select(
            Posicion.especie,
            func.sum(Posicion.cantidad_comprada).label("total_comprada"),
            func.sum(Posicion.cantidad_vendida).label("total_vendida"),
            func.sum(Posicion.costo_promedio_compra * Posicion.cantidad_comprada).label("valor_compra"),
            func.sum(Posicion.costo_promedio_venta * Posicion.cantidad_vendida).label("valor_venta"),
        )
        .where(Posicion.especie.in_(especies))
        .group_by(Posicion.especie)
    )
    if codigos:
        pos_query = pos_query.where(Posicion.cliente.in_(codigos))
    pos_agg = {row.especie: row for row in db.execute(pos_query).all()}

    result = []
    for seg in seguidos:
        pm = precios_map.get(seg.especie)
        agg = pos_agg.get(seg.especie)

        qty_buy = int(agg.total_comprada or 0) if agg else 0
        qty_sell = int(agg.total_vendida or 0) if agg else 0
        precio_promedio_buy = (
            round((agg.valor_compra or 0) / qty_buy, 4) if agg and qty_buy > 0 else 0.0
        )
        precio_promedio_sell = (
            round((agg.valor_venta or 0) / qty_sell, 4) if agg and qty_sell > 0 else 0.0
        )

        result.append(SeguridoResponse(
            id=seg.id,
            especie=seg.especie,
            orden=seg.orden,
            precio_actual=pm.precio if pm else None,
            variacion_diaria=pm.variacion_pct if pm else None,
            precio_cierre=pm.precio_cierre if pm else None,
            precio_minimo_dia=pm.precio_minimo if pm else None,
            precio_maximo_dia=pm.precio_maximo if pm else None,
            cantidad_compra=qty_buy,
            precio_promedio_compra=round(precio_promedio_buy, 4),
            cantidad_venta=qty_sell,
            precio_promedio_venta=round(precio_promedio_sell, 4),
            precio_compra_meta=seg.precio_compra_meta,
            precio_venta_meta=seg.precio_venta_meta,
        ))

    return result


@router.post("")
def agregar_seguido(
    req: SeguirEspecieRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SeguridoResponse:
    """Add an instrument to user's watchlist."""

    # Validate especie exists
    especie_exists = db.execute(
        select(EspecieMercado)
        .where(EspecieMercado.especie == req.especie.upper())
    ).scalar()

    if not especie_exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Especie '{req.especie}' not found"
        )

    # Check if already following
    existing = db.execute(
        select(UsuarioSeguido)
        .where(
            (UsuarioSeguido.usuario_id == user.id) &
            (UsuarioSeguido.especie == req.especie.upper())
        )
    ).scalar()

    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Already following '{req.especie}'"
        )

    # Assign next order position (max + 1, or 0 if first)
    max_orden = db.execute(
        select(func.max(UsuarioSeguido.orden))
        .where(UsuarioSeguido.usuario_id == user.id)
    ).scalar()

    # Create new watchlist entry
    nuevo = UsuarioSeguido(
        usuario_id=user.id,
        especie=req.especie.upper(),
        precio_compra_meta=req.precio_compra_meta,
        precio_venta_meta=req.precio_venta_meta,
        orden=(max_orden if max_orden is not None else -1) + 1,
    )
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)

    # Return full data by calling get_lista_seguidos for this item
    pm = db.execute(
        select(PrecioMercado).where(PrecioMercado.especie == nuevo.especie)
    ).scalar()

    return SeguridoResponse(
        id=nuevo.id,
        especie=nuevo.especie,
        orden=nuevo.orden,
        precio_actual=pm.precio if pm else None,
        variacion_diaria=pm.variacion_pct if pm else None,
        precio_cierre=pm.precio_cierre if pm else None,
        precio_minimo_dia=pm.precio_minimo if pm else None,
        precio_maximo_dia=pm.precio_maximo if pm else None,
        cantidad_compra=0,
        precio_promedio_compra=0.0,
        cantidad_venta=0,
        precio_promedio_venta=0.0,
        precio_compra_meta=nuevo.precio_compra_meta,
        precio_venta_meta=nuevo.precio_venta_meta,
    )


@router.delete("/{seguido_id}")
def eliminar_seguido(
    seguido_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Remove an instrument from user's watchlist."""

    seguido = db.execute(
        select(UsuarioSeguido)
        .where(
            (UsuarioSeguido.id == seguido_id) &
            (UsuarioSeguido.usuario_id == user.id)
        )
    ).scalar()

    if not seguido:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Watchlist entry not found"
        )

    db.delete(seguido)
    db.commit()

    return {"message": f"Removed '{seguido.especie}' from watchlist"}


@router.put("/reordenar")
def reordenar_seguidos(
    req: ReordenarRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Persist manual watchlist order. Receives full ordered list of seguido IDs."""
    ids = req.ids

    if not ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Lista de IDs vacía")

    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="IDs duplicados")

    seguidos = db.execute(
        select(UsuarioSeguido).where(UsuarioSeguido.usuario_id == user.id)
    ).scalars().all()

    seguidos_map = {s.id: s for s in seguidos}

    for sid in ids:
        if sid not in seguidos_map:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"ID {sid} no pertenece a este usuario o no existe"
            )

    if set(ids) != set(seguidos_map.keys()):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La lista debe incluir todos los seguidos del usuario"
        )

    try:
        for nueva_posicion, sid in enumerate(ids):
            seguidos_map[sid].orden = nueva_posicion
        db.commit()
    except Exception:
        db.rollback()
        raise

    return {"message": "Orden actualizado", "total": len(ids)}


@router.put("/{seguido_id}")
def actualizar_metas(
    seguido_id: int,
    req: ActualizarMetasRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SeguridoResponse:
    """Update price targets for a watchlist item."""

    seguido = db.execute(
        select(UsuarioSeguido)
        .where(
            (UsuarioSeguido.id == seguido_id) &
            (UsuarioSeguido.usuario_id == user.id)
        )
    ).scalar()

    if not seguido:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Watchlist entry not found"
        )

    if req.precio_compra_meta is not None:
        seguido.precio_compra_meta = req.precio_compra_meta
    if req.precio_venta_meta is not None:
        seguido.precio_venta_meta = req.precio_venta_meta

    db.commit()
    db.refresh(seguido)

    # Get fresh data
    pm = db.execute(
        select(PrecioMercado).where(PrecioMercado.especie == seguido.especie)
    ).scalar()

    return SeguridoResponse(
        id=seguido.id,
        especie=seguido.especie,
        orden=seguido.orden,
        precio_actual=pm.precio if pm else None,
        variacion_diaria=pm.variacion_pct if pm else None,
        precio_cierre=pm.precio_cierre if pm else None,
        precio_minimo_dia=pm.precio_minimo if pm else None,
        precio_maximo_dia=pm.precio_maximo if pm else None,
        cantidad_compra=0,
        precio_promedio_compra=0.0,
        cantidad_venta=0,
        precio_promedio_venta=0.0,
        precio_compra_meta=seguido.precio_compra_meta,
        precio_venta_meta=seguido.precio_venta_meta,
    )


@router.get("/preview/{especie}")
def preview_especie(
    especie: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict:
    """Return current price data for a single especie (used in add modal preview)."""
    pm = db.execute(
        select(PrecioMercado).where(PrecioMercado.especie == especie.upper())
    ).scalar()

    if not pm:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No price data for '{especie}'")

    return pm.to_dict()


@router.get("/especies")
def list_especies_disponibles(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[str]:
    """List all available species that can be added to watchlist."""
    rows = db.execute(
        select(EspecieMercado.especie)
        .where(EspecieMercado.activo == True)
        .order_by(EspecieMercado.especie)
    ).scalars().all()
    return rows
