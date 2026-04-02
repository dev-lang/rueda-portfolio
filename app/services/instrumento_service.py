"""
Instrument catalog service.

Provides CRUD for Instrumento, RentaFijaDetalle, FuturoRofexDetalle,
and LlamadoMargen (margin calls).

All write operations are transactional — callers must db.commit() / db.rollback().
"""

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.instrumento import (
    Instrumento, LlamadoMargen,
    FuturoRofexDetalle, RentaFijaDetalle,
    TIPOS_INSTRUMENTO, ESTADOS_LLAMADO,
)


class InstrumentoError(Exception):
    def __init__(self, mensaje: str, status_code: int = 400):
        self.mensaje = mensaje
        self.status_code = status_code
        super().__init__(mensaje)


# ── Instrumento CRUD ──────────────────────────────────────────────────────────

def listar(
    db: Session,
    tipo: str | None = None,
    solo_activos: bool = True,
) -> list[Instrumento]:
    stmt = (
        select(Instrumento)
        .options(
            selectinload(Instrumento.renta_fija),
            selectinload(Instrumento.futuro),
        )
    )
    if tipo:
        stmt = stmt.where(Instrumento.tipo == tipo.upper())
    if solo_activos:
        stmt = stmt.where(Instrumento.activo == True)
    return db.execute(stmt.order_by(Instrumento.especie)).scalars().all()


def obtener(db: Session, instrumento_id: int) -> Instrumento:
    inst = db.execute(
        select(Instrumento)
        .options(selectinload(Instrumento.renta_fija), selectinload(Instrumento.futuro))
        .where(Instrumento.id == instrumento_id)
    ).scalar_one_or_none()
    if not inst:
        raise InstrumentoError(f"Instrumento {instrumento_id} no encontrado.", 404)
    return inst


def obtener_por_especie(db: Session, especie: str) -> Instrumento | None:
    return db.execute(
        select(Instrumento)
        .options(selectinload(Instrumento.renta_fija), selectinload(Instrumento.futuro))
        .where(Instrumento.especie == especie.upper())
    ).scalar_one_or_none()


def crear(
    db: Session,
    especie: str,
    tipo: str,
    moneda: str = "ARP",
    mercado_principal: str | None = None,
    descripcion: str | None = None,
) -> Instrumento:
    tipo = tipo.upper()
    if tipo not in TIPOS_INSTRUMENTO:
        raise InstrumentoError(f"Tipo inválido: {tipo}. Válidos: {sorted(TIPOS_INSTRUMENTO)}")

    existing = obtener_por_especie(db, especie)
    if existing:
        raise InstrumentoError(f"Ya existe un instrumento para la especie '{especie}'.", 409)

    inst = Instrumento(
        especie=especie.upper(),
        tipo=tipo,
        moneda=moneda.upper(),
        mercado_principal=mercado_principal,
        descripcion=descripcion,
    )
    db.add(inst)
    db.flush()
    return inst


def actualizar(
    db: Session,
    instrumento_id: int,
    descripcion: str | None = None,
    mercado_principal: str | None = None,
    activo: bool | None = None,
) -> Instrumento:
    inst = obtener(db, instrumento_id)
    if descripcion is not None:
        inst.descripcion = descripcion
    if mercado_principal is not None:
        inst.mercado_principal = mercado_principal
    if activo is not None:
        inst.activo = activo
    return inst


# ── RentaFija CRUD ────────────────────────────────────────────────────────────

def upsert_renta_fija(
    db: Session,
    instrumento_id: int,
    tir_referencia: float | None = None,
    duration: float | None = None,
    fecha_vencimiento: date | None = None,
    precio_sucio: float | None = None,
    precio_limpio: float | None = None,
    tasa_cupon: float | None = None,
    frecuencia_cupon: str | None = None,
    amortiza: bool = False,
    moneda_emision: str | None = None,
    emisor: str | None = None,
) -> RentaFijaDetalle:
    inst = obtener(db, instrumento_id)
    if inst.tipo != "RENTA_FIJA":
        raise InstrumentoError(
            f"El instrumento {inst.especie} es tipo '{inst.tipo}', no RENTA_FIJA."
        )

    det = inst.renta_fija
    if det is None:
        det = RentaFijaDetalle(instrumento_id=instrumento_id)
        db.add(det)

    if tir_referencia   is not None: det.tir_referencia   = tir_referencia
    if duration         is not None: det.duration         = duration
    if fecha_vencimiento is not None: det.fecha_vencimiento = fecha_vencimiento
    if precio_sucio     is not None: det.precio_sucio     = precio_sucio
    if precio_limpio    is not None: det.precio_limpio    = precio_limpio
    if tasa_cupon       is not None: det.tasa_cupon       = tasa_cupon
    if frecuencia_cupon is not None: det.frecuencia_cupon = frecuencia_cupon
    det.amortiza = amortiza
    if moneda_emision   is not None: det.moneda_emision   = moneda_emision
    if emisor           is not None: det.emisor           = emisor
    return det


# ── Futuro ROFEX CRUD ─────────────────────────────────────────────────────────

def upsert_futuro(
    db: Session,
    instrumento_id: int,
    contrato: str | None = None,
    activo_subyacente: str | None = None,
    mes_vencimiento: date | None = None,
    precio_ajuste: float | None = None,
    margen_inicial: float | None = None,
    margen_variacion: float | None = None,
    tick_size: float | None = None,
    multiplicador: float = 1.0,
) -> FuturoRofexDetalle:
    inst = obtener(db, instrumento_id)
    if inst.tipo != "FUTURO":
        raise InstrumentoError(
            f"El instrumento {inst.especie} es tipo '{inst.tipo}', no FUTURO."
        )

    det = inst.futuro
    if det is None:
        det = FuturoRofexDetalle(instrumento_id=instrumento_id, multiplicador=multiplicador)
        db.add(det)

    if contrato          is not None: det.contrato          = contrato
    if activo_subyacente is not None: det.activo_subyacente = activo_subyacente
    if mes_vencimiento   is not None: det.mes_vencimiento   = mes_vencimiento
    if precio_ajuste     is not None: det.precio_ajuste     = precio_ajuste
    if margen_inicial    is not None: det.margen_inicial    = margen_inicial
    if margen_variacion  is not None: det.margen_variacion  = margen_variacion
    if tick_size         is not None: det.tick_size         = tick_size
    det.multiplicador = multiplicador
    return det


# ── Margin calls ──────────────────────────────────────────────────────────────

def listar_llamados(
    db: Session,
    instrumento_id: int | None = None,
    cuenta_id: int | None = None,
    estado: str | None = None,
) -> list[LlamadoMargen]:
    stmt = select(LlamadoMargen)
    if instrumento_id is not None:
        stmt = stmt.where(LlamadoMargen.instrumento_id == instrumento_id)
    if cuenta_id is not None:
        stmt = stmt.where(LlamadoMargen.cuenta_id == cuenta_id)
    if estado:
        stmt = stmt.where(LlamadoMargen.estado == estado.upper())
    return db.execute(stmt.order_by(LlamadoMargen.fecha.desc())).scalars().all()


def crear_llamado(
    db: Session,
    instrumento_id: int,
    cuenta_id: int,
    fecha: date,
    monto: float,
    descripcion: str | None = None,
    usuario: str = "sistema",
) -> LlamadoMargen:
    # Validate instrument exists and is FUTURO
    inst = obtener(db, instrumento_id)
    if inst.tipo != "FUTURO":
        raise InstrumentoError(
            f"Los llamados de margen solo aplican a instrumentos FUTURO, no '{inst.tipo}'."
        )

    llamado = LlamadoMargen(
        instrumento_id=instrumento_id,
        cuenta_id=cuenta_id,
        fecha=fecha,
        monto=monto,
        estado="PENDIENTE",
        descripcion=descripcion,
        usuario=usuario,
    )
    db.add(llamado)
    return llamado


def integrar_llamado(
    db: Session,
    llamado_id: int,
    usuario: str = "sistema",
) -> LlamadoMargen:
    llamado = db.get(LlamadoMargen, llamado_id)
    if not llamado:
        raise InstrumentoError(f"Llamado de margen {llamado_id} no encontrado.", 404)
    if llamado.estado != "PENDIENTE":
        raise InstrumentoError(
            f"El llamado {llamado_id} ya está en estado '{llamado.estado}'."
        )
    llamado.estado = "INTEGRADO"
    llamado.usuario = usuario
    return llamado


def vencer_llamados_pendientes(
    db: Session,
    hasta_fecha: date,
) -> int:
    """Mark all PENDIENTE margin calls on or before hasta_fecha as VENCIDO."""
    llamados = db.execute(
        select(LlamadoMargen).where(
            LlamadoMargen.estado == "PENDIENTE",
            LlamadoMargen.fecha <= hasta_fecha,
        )
    ).scalars().all()
    for ll in llamados:
        ll.estado = "VENCIDO"
    return len(llamados)
