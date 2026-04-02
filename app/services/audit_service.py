"""
Explicit audit logging service.

Called directly from service/router functions for full control over what
gets recorded and why. Keeps entries immutable — never updated or deleted.
"""

import json
from sqlalchemy.orm import Session
from app.models.audit_log import AuditLog


def registrar(
    db: Session,
    tabla: str,
    operacion: str,
    record_id: int,
    descripcion: str,
    datos_antes: dict | None = None,
    datos_despues: dict | None = None,
    usuario: str = "sistema",
) -> AuditLog:
    """
    Appends an audit entry to the session (not yet committed).
    The caller is responsible for committing the surrounding transaction.
    """
    log = AuditLog(
        tabla=tabla,
        operacion=operacion,
        record_id=record_id,
        usuario=usuario,
        descripcion=descripcion,
        datos_antes=json.dumps(datos_antes, default=str) if datos_antes else None,
        datos_despues=json.dumps(datos_despues, default=str) if datos_despues else None,
    )
    db.add(log)
    return log
