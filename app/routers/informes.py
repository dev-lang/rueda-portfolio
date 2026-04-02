import asyncio
import io
from datetime import date
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.services import informe_service

router = APIRouter(prefix="/api/reports", tags=["informes"])


@router.get("/summary")
def get_summary(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return informe_service.get_summary(db)


@router.get("/positions-snapshot")
def get_positions_snapshot(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return {"snapshot": informe_service.get_positions_snapshot(db)}


@router.get("/concentracion")
def get_concentracion(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return informe_service.get_concentracion(db)


@router.get("/benchmark")
async def get_benchmark(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return await asyncio.to_thread(informe_service.get_benchmark, db)


@router.get("/export")
def exportar(
    tipo: str = "ejecuciones",
    fecha: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("ADMIN")),  # export restricted to ADMIN
):
    today = date.today().isoformat()

    if tipo == "xlsx":
        content = informe_service.export_xlsx(db)
        return Response(
            content=content,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename=rueda_export_{today}.xlsx"},
        )

    fecha_parsed: date | None = None
    if fecha:
        try:
            fecha_parsed = date.fromisoformat(fecha)
        except ValueError:
            pass

    contenido = informe_service.export_csv(db, tipo=tipo, fecha=fecha_parsed)
    filename = f"{tipo}_{today}.csv"

    return StreamingResponse(
        io.StringIO(contenido),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
