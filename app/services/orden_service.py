from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.core.pagination import paginate
from datetime import date, datetime, timedelta, timezone

from app.models.orden import Orden
from app.models.notificacion import Notificacion
from app.models.precio_mercado import PrecioMercado
from app.models.especie_mercado import EspecieMercado
from app.schemas.orden import OrdenCreate
from app.services import audit_service
from app.models.bot_instancia import TIPOS_COMPRA as _TIPOS_COMPRA, TIPOS_VENTA as _TIPOS_VENTA


def listar_blotter(db: Session, fecha: date | None = None) -> list[dict]:
    """
    Returns all orders for a given date (default: today), ordered by created_at.
    Used by the intraday Blotter view — no pagination.
    """
    target = fecha or date.today()
    ordenes = db.execute(
        select(Orden)
        .where(Orden.fecha_orden == target)
        .order_by(Orden.created_at.asc())
    ).scalars().all()
    return [o.to_dict() for o in ordenes]


def listar_ordenes(
    db: Session,
    especie: str | None = None,
    cliente: str | None = None,
    estado_color: str | None = None,
    fecha_desde: date | None = None,
    fecha_hasta: date | None = None,
    page: int = 1,
    per_page: int = 20,
) -> dict:
    stmt = select(Orden)
    if especie and especie != "Todos":
        stmt = stmt.where(Orden.especie == especie)
    if cliente and cliente != "Todos":
        stmt = stmt.where(Orden.cliente == cliente)
    if estado_color:
        stmt = stmt.where(Orden.estado_color == estado_color)
    if fecha_desde:
        stmt = stmt.where(Orden.fecha_orden >= fecha_desde)
    if fecha_hasta:
        stmt = stmt.where(Orden.fecha_orden <= fecha_hasta)

    ordenes, meta = paginate(db, stmt, page, per_page, order_by=Orden.nro_orden.desc())
    return {"ordenes": [o.to_dict() for o in ordenes], **meta}


def crear_orden(
    db: Session,
    payload: OrdenCreate,
    usuario: str = "sistema",
) -> tuple[Orden, Notificacion, list]:
    """
    Creates a new order. nro_orden is derived from the DB-assigned id to avoid
    race conditions on concurrent inserts. Uses db.flush() to get the id before commit.

    Returns (orden, notificacion, alertas_riesgo) where alertas_riesgo is a list
    of soft-alert messages from the pre-trade risk check.

    Raises ValueError if the especie has no registered price in precios_mercado.
    Raises RiesgoLimiteError (hard block) if a risk limit is exceeded.
    """
    from app.services.riesgo_service import verificar_limites_orden, RiesgoLimiteError
    from app.models.cliente import Cliente
    from app.models.operador import Operador

    em_exist = db.execute(
        select(EspecieMercado).where(
            EspecieMercado.especie == payload.especie,
            EspecieMercado.activo == True,
        )
    ).scalar_one_or_none()
    if em_exist is None:
        raise ValueError(
            f"La especie '{payload.especie}' no está registrada en el sistema. "
            "Agregala desde Admin → Tickers antes de operar."
        )

    pm = db.execute(
        select(PrecioMercado).where(
            PrecioMercado.especie == payload.especie,
            PrecioMercado.precio > 0,
        )
    ).scalar_one_or_none()
    if pm is None:
        raise ValueError(
            f"La especie '{payload.especie}' no tiene precio registrado. "
            "Cargá el precio en la vista Posiciones antes de operar."
        )

    # ── Max order size check ──────────────────────────────────────────────────
    em_cfg = db.execute(
        select(EspecieMercado).where(EspecieMercado.especie == payload.especie)
    ).scalar_one_or_none()
    if em_cfg and em_cfg.cantidad_max_orden is not None:
        if payload.cantidad_total > em_cfg.cantidad_max_orden:
            raise ValueError(
                f"La cantidad {payload.cantidad_total:,} supera el máximo permitido "
                f"de {em_cfg.cantidad_max_orden:,} unidades por orden para {payload.especie}."
            )

    # For MERCADO orders use the current market price as the reference for risk checks
    precio_ref = payload.precio_limite if payload.tipo_precio == "LIMITE" else pm.precio

    if not precio_ref or precio_ref <= 0:
        raise ValueError(
            f"No hay precio de referencia válido para '{payload.especie}'. "
            "Actualizá el precio en Posiciones antes de operar a mercado."
        )

    # For MERCADO orders, reject if the price is stale (>30 min without update)
    if payload.tipo_precio != "LIMITE" and pm.last_updated is not None:
        age = datetime.now(timezone.utc).replace(tzinfo=None) - pm.last_updated
        if age > timedelta(minutes=30):
            raise ValueError(
                f"El precio de '{payload.especie}' está desactualizado "
                f"(última actualización hace {int(age.total_seconds() // 60)} min). "
                "Esperá a que el price feed lo refresque o ingresá una orden LIMITE."
            )

    # ── Pre-trade risk check ──────────────────────────────────────────────────
    cliente_obj = db.execute(
        select(Cliente).where(Cliente.codigo == payload.cliente)
    ).scalar_one_or_none()
    if cliente_obj is None:
        raise ValueError(
            f"El cliente '{payload.cliente}' no existe. "
            "Registrá el cliente antes de ingresar órdenes a su nombre."
        )
    cliente_id = cliente_obj.id

    alertas_riesgo = verificar_limites_orden(
        db,
        tipo_orden=payload.tipo_orden,
        especie=payload.especie,
        moneda=payload.moneda or "ARP",
        precio_limite=precio_ref,
        cantidad_total=payload.cantidad_total,
        cliente_id=cliente_id,
    )

    # Hard-block errors stop here
    hard_blocks = [a for a in alertas_riesgo if not a.es_alerta]
    if hard_blocks:
        raise hard_blocks[0]  # RiesgoLimiteError is a ValueError subclass — caught by callers

    # ── Pre-trade cash validation (buy orders only, human orders) ─────────────
    if payload.tipo_orden in _TIPOS_COMPRA and cliente_obj is not None:
        from decimal import Decimal
        from app.services.account_service import get_account
        cuenta = get_account(db, "cliente", cliente_obj.id, payload.moneda or "ARP")
        if cuenta is not None:
            notional = Decimal(str(precio_ref)) * Decimal(str(payload.cantidad_total))
            saldo_disp = Decimal(str(cuenta.balance_cache)) - Decimal(str(cuenta.balance_reservado))
            if notional > saldo_disp:
                raise RiesgoLimiteError(
                    f"Saldo insuficiente: disponible {float(saldo_disp):,.2f} {payload.moneda or 'ARP'}, "
                    f"orden requiere {float(notional):,.2f} {payload.moneda or 'ARP'}.",
                    tipo_limite="SALDO_DISPONIBLE",
                    es_alerta=False,
                )

    # ── Pre-trade position validation (sell orders only) ─────────────────────
    if payload.tipo_orden in _TIPOS_VENTA and cliente_obj is not None:
        from app.models.posicion import Posicion
        pos = db.execute(
            select(Posicion).where(
                Posicion.cliente == payload.cliente,
                Posicion.especie == payload.especie,
            )
        ).scalar_one_or_none()

        cantidad_neta = pos.cantidad_disponible if pos else 0

        # Subtract qty already committed in pending sell orders
        pending_sell = db.execute(
            select(func.sum(Orden.cantidad_total - Orden.cantidad_ejecutada)).where(
                Orden.cliente == payload.cliente,
                Orden.especie == payload.especie,
                Orden.tipo_orden.in_(list(_TIPOS_VENTA)),
                Orden.instancia.notin_(["Ejecutada", "Cancelada"]),
            )
        ).scalar() or 0

        disponible = cantidad_neta - pending_sell
        if payload.cantidad_total > disponible:
            raise RiesgoLimiteError(
                f"Posición insuficiente: disponible {int(disponible):,} {payload.especie}, "
                f"orden requiere {payload.cantidad_total:,}.",
                tipo_limite="POSICION_DISPONIBLE",
                es_alerta=False,
            )

    # Conditional (Stop/TP) orders start as inactive
    es_condicional = payload.tipo_activacion is not None

    # Feature 15: resolve desk — explicit override > Operador lookup > None
    desk = payload.desk
    if not desk:
        op = db.execute(
            select(Operador).where(Operador.username == usuario, Operador.activo == True)
        ).scalar_one_or_none()
        desk = op.desk if op else None

    orden = Orden(
        nro_orden="",  # placeholder, set after flush
        tipo_orden=payload.tipo_orden,
        fecha_orden=date.today(),
        cliente=payload.cliente,
        razon_social=payload.razon_social,
        especie=payload.especie,
        moneda=payload.moneda,
        tipo_precio=payload.tipo_precio,
        precio_limite=payload.precio_limite,
        cantidad_total=payload.cantidad_total,
        cantidad_ejecutada=0,
        precio_promedio=0.0,
        instancia="Pendiente",
        instancia_codigo=1,
        estado_color="orange",
        version=1,
        usuario=usuario,
        time_in_force=payload.time_in_force,
        fecha_exp=payload.fecha_exp,
        cantidad_visible=payload.cantidad_visible,
        tipo_activacion=payload.tipo_activacion,
        precio_activacion=payload.precio_activacion,
        activa=not es_condicional,
        desk=desk,
    )
    db.add(orden)
    db.flush()  # assigns orden.id without committing

    orden.nro_orden = f"OR{orden.id + 999:06d}"

    # ── Reserve cash for buy orders (human orders only) ──────────────────────
    if payload.tipo_orden in _TIPOS_COMPRA and cliente_obj is not None:
        from decimal import Decimal
        from app.services.account_service import get_account, reservar_orden
        cuenta = get_account(db, "cliente", cliente_obj.id, payload.moneda or "ARP")
        if cuenta is not None:
            monto_reserva = Decimal(str(precio_ref)) * Decimal(str(payload.cantidad_total))
            reservar_orden(db, cuenta, orden.id, monto_reserva, usuario=usuario)

    notif = Notificacion(
        servicio="SISTEMA",
        mensaje=f"Nueva orden {orden.nro_orden} creada para {orden.especie}",
        tipo="info",
    )
    db.add(notif)

    audit_service.registrar(
        db,
        tabla="ordenes",
        operacion="CREATE",
        record_id=orden.id,
        descripcion=f"Orden {orden.nro_orden} creada: {orden.tipo_orden} {orden.especie} x{orden.cantidad_total:,}",
        datos_despues=orden.to_dict(),
        usuario=usuario,
    )

    alertas_msgs = [a.mensaje for a in alertas_riesgo if a.es_alerta]
    return orden, notif, alertas_msgs


def obtener_orden(db: Session, orden_id: int) -> Orden | None:
    return db.get(Orden, orden_id)


def cancelar_orden(db: Session, orden_id: int, usuario: str = "sistema") -> Orden:
    """
    Cancels an order: sets estado_color=red, instancia=Cancelada.
    Raises ValueError for invalid transitions (already cancelled or fully executed).
    """
    orden = db.get(Orden, orden_id)
    if orden is None:
        raise ValueError(f"Orden {orden_id} no encontrada.")
    if orden.instancia == "Cancelada":
        raise ValueError(f"La orden {orden.nro_orden} ya está cancelada.")
    if orden.instancia == "Ejecutada":
        raise ValueError(
            f"La orden {orden.nro_orden} ya fue ejecutada completamente y no puede cancelarse."
        )
    if orden.instancia in ("Concertada", "Parcialmente Concertada"):
        raise ValueError(
            f"La orden {orden.nro_orden} tiene fills pendientes de confirmación bilateral. "
            "Confirmá o rechazá los fills antes de cancelar la orden."
        )

    datos_antes = orden.to_dict()
    orden.instancia = "Cancelada"
    orden.instancia_codigo = 0
    orden.estado_color = "red"
    orden.version += 1

    # ── Release any remaining cash reservation (human buy orders) ────────────
    if orden.tipo_orden in _TIPOS_COMPRA and orden.bot_id is None:
        from app.models.cliente import Cliente
        from sqlalchemy import select as _select
        from app.services.account_service import get_account, liberar_reserva_orden
        cliente_obj = db.execute(
            _select(Cliente).where(Cliente.codigo == orden.cliente)
        ).scalar_one_or_none()
        if cliente_obj:
            cuenta = get_account(db, "cliente", cliente_obj.id, orden.moneda or "ARP")
            if cuenta:
                liberar_reserva_orden(db, cuenta, orden.id, usuario=usuario)

    audit_service.registrar(
        db,
        tabla="ordenes",
        operacion="CANCEL",
        record_id=orden.id,
        descripcion=f"Orden {orden.nro_orden} cancelada.",
        datos_antes=datos_antes,
        datos_despues=orden.to_dict(),
        usuario=usuario,
    )
    return orden


def modificar_orden(
    db: Session,
    orden_id: int,
    nuevo_precio: float | None,
    nueva_cantidad: int | None,
    usuario: str = "sistema",
) -> Orden:
    """
    Updates precio_limite and/or cantidad_total on a non-terminal order.
    Raises ValueError for invalid transitions.
    """
    orden = db.get(Orden, orden_id)
    if orden is None:
        raise ValueError(f"Orden {orden_id} no encontrada.")
    if orden.instancia in ("Ejecutada", "Cancelada"):
        raise ValueError(
            f"No se puede modificar una orden en estado '{orden.instancia}'."
        )
    if nueva_cantidad is not None and nueva_cantidad < orden.cantidad_ejecutada:
        raise ValueError(
            f"La nueva cantidad ({nueva_cantidad:,}) es menor que lo ya ejecutado "
            f"({orden.cantidad_ejecutada:,}) en {orden.nro_orden}."
        )

    datos_antes = orden.to_dict()
    cambios = []

    if nuevo_precio is not None:
        orden.precio_limite = nuevo_precio
        cambios.append(f"precio_limite→{nuevo_precio}")

    if nueva_cantidad is not None:
        orden.cantidad_total = nueva_cantidad
        cambios.append(f"cantidad_total→{nueva_cantidad:,}")
        # If new quantity exactly matches executed, mark as fully executed
        if nueva_cantidad == orden.cantidad_ejecutada and nueva_cantidad > 0:
            orden.instancia = "Ejecutada"
            orden.instancia_codigo = 9
            orden.estado_color = "green"

    orden.version += 1

    audit_service.registrar(
        db,
        tabla="ordenes",
        operacion="UPDATE",
        record_id=orden.id,
        descripcion=f"Orden {orden.nro_orden} modificada: {', '.join(cambios)}",
        datos_antes=datos_antes,
        datos_despues=orden.to_dict(),
        usuario=usuario,
    )
    return orden


def obtener_filtros(db: Session) -> dict:
    especies = [
        r[0]
        for r in db.execute(select(Orden.especie).distinct().order_by(Orden.especie)).all()
    ]
    clientes = [
        r[0]
        for r in db.execute(select(Orden.cliente).distinct().order_by(Orden.cliente)).all()
    ]
    return {"especies": especies, "clientes": clientes}
