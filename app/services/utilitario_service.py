from datetime import datetime, timezone, timezone, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.models.orden import Orden
from app.models.ejecucion import Ejecucion
from app.models.posicion import Posicion
from app.models.notificacion import Notificacion

_SERVICIOS = ["MAEONL", "ROFEX", "Rueda HUB"]
_UMBRAL_DEGRADADO_SEG = 60


def get_stats(db: Session) -> dict:
    return {
        "ordenes_total": db.execute(select(func.count(Orden.id))).scalar() or 0,
        "ejecuciones_total": db.execute(select(func.count(Ejecucion.id))).scalar() or 0,
        "posiciones_total": db.execute(select(func.count(Posicion.id))).scalar() or 0,
        "notificaciones_total": db.execute(select(func.count(Notificacion.id))).scalar() or 0,
    }


def get_health(db: Session) -> dict:
    umbral = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=_UMBRAL_DEGRADADO_SEG)
    resultado = []

    for srv in _SERVICIOS:
        ultima = db.execute(
            select(Notificacion)
            .where(Notificacion.servicio == srv)
            .order_by(Notificacion.created_at.desc())
            .limit(1)
        ).scalar_one_or_none()

        if ultima is None:
            estado = "desconocido"
        elif ultima.created_at < umbral:
            estado = "degradado"
        elif ultima.tipo == "ok":
            estado = "ok"
        else:
            estado = "activo"

        resultado.append({
            "nombre": srv,
            "mensaje": ultima.mensaje if ultima else None,
            "timestamp": ultima.created_at.strftime("%H:%M:%S") if ultima else None,
            "tipo": ultima.tipo if ultima else None,
            "estado": estado,
        })

    return {"servicios": resultado}
