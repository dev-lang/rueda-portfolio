from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.deps import require_role
from app.core.pagination import paginate
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.user import User

router = APIRouter(prefix="/api/audit", tags=["auditoria"])


@router.get("")
def listar_audit(
    tabla: str | None = None,
    operacion: str | None = None,
    record_id: int | None = None,
    page: int = 1,
    per_page: int = 50,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),  # audit log restricted to ADMIN
):
    """Returns audit log entries ordered by newest first, paginated."""
    stmt = select(AuditLog)
    if tabla:
        stmt = stmt.where(AuditLog.tabla == tabla)
    if operacion:
        stmt = stmt.where(AuditLog.operacion == operacion)
    if record_id is not None:
        stmt = stmt.where(AuditLog.record_id == record_id)

    logs, meta = paginate(db, stmt, page, per_page, order_by=AuditLog.created_at.desc())
    return {"logs": [log.to_dict() for log in logs], **meta}
