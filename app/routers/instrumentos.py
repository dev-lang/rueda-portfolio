"""
Instrument catalog endpoints.

GET  /api/instrumentos               — list all instruments (optional ?tipo=RENTA_FIJA)
GET  /api/instrumentos/{id}          — single instrument with detail
GET  /api/instrumentos/especie/{esp} — lookup by especie code
POST /api/instrumentos               — create (ADMIN)
PATCH /api/instrumentos/{id}         — update description/status (ADMIN)
PUT  /api/instrumentos/{id}/renta-fija  — upsert bond detail (ADMIN)
PUT  /api/instrumentos/{id}/futuro      — upsert futures detail (ADMIN)
GET  /api/instrumentos/{id}/llamados-margen         — list margin calls
POST /api/instrumentos/{id}/llamados-margen         — create margin call (ADMIN)
POST /api/instrumentos/llamados-margen/{lm_id}/integrar — mark paid (ADMIN)
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.services import instrumento_service
from app.schemas.instrumentos import (
    InstrumentoCreate, InstrumentoUpdate,
    RentaFijaUpsert, FuturoUpsert, LlamadoMargenCreate,
)

router = APIRouter(prefix="/api/instrumentos", tags=["instrumentos"])


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("")
def listar_instrumentos(
    tipo: str | None = None,
    solo_activos: bool = True,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    insts = instrumento_service.listar(db, tipo=tipo, solo_activos=solo_activos)
    return {"instrumentos": [i.to_dict() for i in insts]}


@router.get("/especie/{especie}")
def obtener_por_especie(
    especie: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    inst = instrumento_service.obtener_por_especie(db, especie)
    if not inst:
        raise HTTPException(status_code=404, detail=f"Instrumento '{especie}' no encontrado.")
    return inst.to_dict()


@router.get("/{instrumento_id}")
def obtener_instrumento(
    instrumento_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    try:
        return instrumento_service.obtener(db, instrumento_id).to_dict()
    except instrumento_service.InstrumentoError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)


@router.post("", status_code=201)
def crear_instrumento(
    payload: InstrumentoCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("ADMIN")),
):
    try:
        inst = instrumento_service.crear(
            db,
            especie=payload.especie,
            tipo=payload.tipo,
            moneda=payload.moneda,
            mercado_principal=payload.mercado_principal,
            descripcion=payload.descripcion,
        )
        db.commit()
        db.refresh(inst)
        return inst.to_dict()
    except instrumento_service.InstrumentoError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)


@router.patch("/{instrumento_id}")
def actualizar_instrumento(
    instrumento_id: int,
    payload: InstrumentoUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    try:
        inst = instrumento_service.actualizar(
            db, instrumento_id,
            descripcion=payload.descripcion,
            mercado_principal=payload.mercado_principal,
            activo=payload.activo,
        )
        db.commit()
        db.refresh(inst)
        return inst.to_dict()
    except instrumento_service.InstrumentoError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)


@router.put("/{instrumento_id}/renta-fija")
def upsert_renta_fija(
    instrumento_id: int,
    payload: RentaFijaUpsert,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    try:
        det = instrumento_service.upsert_renta_fija(db, instrumento_id, **payload.model_dump())
        db.commit()
        db.refresh(det)
        return det.to_dict()
    except instrumento_service.InstrumentoError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)


@router.put("/{instrumento_id}/futuro")
def upsert_futuro(
    instrumento_id: int,
    payload: FuturoUpsert,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    try:
        det = instrumento_service.upsert_futuro(db, instrumento_id, **payload.model_dump())
        db.commit()
        db.refresh(det)
        return det.to_dict()
    except instrumento_service.InstrumentoError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)


# ── Margin calls ──────────────────────────────────────────────────────────────

@router.get("/{instrumento_id}/llamados-margen")
def listar_llamados(
    instrumento_id: int,
    estado: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    llamados = instrumento_service.listar_llamados(
        db, instrumento_id=instrumento_id, estado=estado
    )
    return {"llamados_margen": [ll.to_dict() for ll in llamados]}


@router.post("/{instrumento_id}/llamados-margen", status_code=201)
async def crear_llamado(
    instrumento_id: int,
    payload: LlamadoMargenCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("ADMIN")),
):
    from app.core.socketio import sio
    try:
        ll = instrumento_service.crear_llamado(
            db, instrumento_id,
            cuenta_id=payload.cuenta_id,
            fecha=payload.fecha,
            monto=payload.monto,
            descripcion=payload.descripcion,
            usuario=current_user.username,
        )
        db.commit()
        db.refresh(ll)
    except instrumento_service.InstrumentoError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)

    await sio.emit("margin_call", {
        "llamado_id":    ll.id,
        "instrumento_id": ll.instrumento_id,
        "cuenta_id":     ll.cuenta_id,
        "monto":         float(ll.monto),
        "fecha":         ll.fecha.isoformat() if ll.fecha else None,
        "estado":        ll.estado,
        "descripcion":   ll.descripcion,
    })
    return ll.to_dict()


@router.post("/llamados-margen/{llamado_id}/integrar")
def integrar_llamado(
    llamado_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("ADMIN")),
):
    try:
        ll = instrumento_service.integrar_llamado(db, llamado_id, usuario=current_user.username)
        db.commit()
        db.refresh(ll)
        return ll.to_dict()
    except instrumento_service.InstrumentoError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.mensaje)
