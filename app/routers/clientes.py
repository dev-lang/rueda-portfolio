"""
Clientes router.

GET    /api/clientes          — list all clients (authenticated)
POST   /api/clientes          — create client (ADMIN)
PATCH  /api/clientes/{codigo} — edit nombre / razon_social, cascade to ordenes (ADMIN)
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.deps import get_current_user, require_role
from app.core.get_or_404 import query_or_404
from app.db.session import get_db
from app.models.cliente import Cliente
from app.models.orden import Orden
from app.models.user import User
from app.schemas.clientes import ClienteCreate, ClienteUpdate

router = APIRouter(prefix="/api/clientes", tags=["clientes"])
_admin = require_role("ADMIN")


@router.get("")
def list_clientes(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    clientes = db.execute(select(Cliente).order_by(Cliente.codigo)).scalars().all()
    return [c.to_dict() for c in clientes]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_cliente(
    payload: ClienteCreate,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    codigo = payload.codigo.upper().strip()
    existing = db.execute(select(Cliente).where(Cliente.codigo == codigo)).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ya existe el cliente '{codigo}'.",
        )
    cliente = Cliente(
        codigo=codigo,
        nombre=payload.nombre.strip(),
        razon_social=payload.razon_social.strip(),
    )
    db.add(cliente)
    db.commit()
    db.refresh(cliente)
    return cliente.to_dict()


@router.patch("/{codigo}")
def update_cliente(
    codigo: str,
    payload: ClienteUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(_admin),
):
    codigo = codigo.upper().strip()
    cliente = query_or_404(
        db, select(Cliente).where(Cliente.codigo == codigo),
        "Cliente no encontrado.",
    )
    if payload.nombre is not None:
        cliente.nombre = payload.nombre.strip()

    if payload.razon_social is not None:
        cliente.razon_social = payload.razon_social.strip()
        # Cascade update: keep all existing orders consistent with the new legal name
        ordenes = db.execute(
            select(Orden).where(Orden.cliente == codigo)
        ).scalars().all()
        for orden in ordenes:
            orden.razon_social = payload.razon_social.strip()

    if payload.activo is not None:
        cliente.activo = payload.activo

    db.commit()
    db.refresh(cliente)
    return cliente.to_dict()
