"""
Operadores (trading desks) API — Feature 15.

GET  /api/operadores           → list all operators
POST /api/operadores           → create operator (ADMIN)
PATCH /api/operadores/{id}     → update nombre / desk / activo (ADMIN)
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.core.get_or_404 import get_or_404
from app.db.session import get_db
from app.models.cliente import Cliente
from app.models.operador import Operador
from app.models.user import User
from app.schemas.operadores import OperadorCreate, OperadorUpdate

router = APIRouter(prefix="/api/operadores", tags=["operadores"])

_DESKS = {"ACCIONES", "RENTA_FIJA", "DERIVADOS", "FCI"}


@router.get("")
def listar_operadores(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    ops = db.execute(
        select(Operador).order_by(Operador.desk, Operador.nombre)
    ).scalars().all()
    return {"operadores": [o.to_dict() for o in ops]}


@router.post("", status_code=201)
def crear_operador(
    payload: OperadorCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    if payload.desk.upper() not in _DESKS:
        raise HTTPException(
            status_code=422,
            detail=f"desk debe ser uno de: {', '.join(sorted(_DESKS))}",
        )
    existing = db.execute(
        select(Operador).where(Operador.username == payload.username)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=422,
            detail=f"Ya existe un operador con username '{payload.username}'.",
        )
    if payload.cliente_codigo:
        cli = db.execute(
            select(Cliente).where(Cliente.codigo == payload.cliente_codigo.upper())
        ).scalar_one_or_none()
        if cli is None:
            raise HTTPException(status_code=422, detail=f"Cliente '{payload.cliente_codigo}' no encontrado.")
    op = Operador(
        nombre=payload.nombre,
        username=payload.username,
        desk=payload.desk.upper(),
        cliente_codigo=payload.cliente_codigo.upper() if payload.cliente_codigo else None,
    )
    db.add(op)
    db.commit()
    db.refresh(op)
    return op.to_dict()


@router.patch("/{operador_id}")
def actualizar_operador(
    operador_id: int,
    payload: OperadorUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),
):
    op = get_or_404(db, Operador, operador_id, "Operador no encontrado.")
    if payload.desk is not None:
        if payload.desk.upper() not in _DESKS:
            raise HTTPException(
                status_code=422,
                detail=f"desk debe ser uno de: {', '.join(sorted(_DESKS))}",
            )
        op.desk = payload.desk.upper()
    if payload.nombre is not None:
        op.nombre = payload.nombre
    if payload.activo is not None:
        op.activo = payload.activo
    if "cliente_codigo" in payload.model_fields_set:
        if payload.cliente_codigo:
            cli = db.execute(
                select(Cliente).where(Cliente.codigo == payload.cliente_codigo.upper())
            ).scalar_one_or_none()
            if cli is None:
                raise HTTPException(status_code=422, detail=f"Cliente '{payload.cliente_codigo}' no encontrado.")
            op.cliente_codigo = payload.cliente_codigo.upper()
        else:
            op.cliente_codigo = None
    db.commit()
    db.refresh(op)
    return op.to_dict()
