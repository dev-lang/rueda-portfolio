"""
Regulatory reports endpoints.

GET /api/reportes/cnv-byma          — Daily fills report (CNV/BYMA format)
GET /api/reportes/bcra-cambios      — BCRA foreign-currency position report
GET /api/reportes/uif-inusuales     — UIF unusual-operations detection

All endpoints accept ?formato=json (default) or ?formato=csv for download.
"""

from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.services import reportes_regulatorios_service, tipo_cambio_service

router = APIRouter(prefix="/api/reportes", tags=["reportes_regulatorios"])


@router.get("/cnv-byma")
def reporte_cnv_byma(
    fecha: date = Query(default_factory=date.today),
    formato: str = Query(default="json", description="json | csv"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Reporte diario de operaciones concertadas para CNV/BYMA.
    Incluye todos los fills del día con especie, cliente, contraparte e importes.
    """
    if formato == "csv":
        csv_data = reportes_regulatorios_service.export_cnv_byma_csv(db, fecha)
        filename = f"cnv_byma_{fecha.strftime('%Y%m%d')}.csv"
        return Response(
            content=csv_data,
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    rows = reportes_regulatorios_service.reporte_cnv_byma(db, fecha)
    return {
        "fecha": fecha.isoformat(),
        "total_operaciones": len(rows),
        "operaciones": rows,
    }


@router.get("/bcra-cambios")
def reporte_bcra_cambios(
    fecha: date = Query(default_factory=date.today),
    formato: str = Query(default="json", description="json | csv"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Reporte BCRA: posición de cambios (instrumentos en moneda extranjera).
    Valúa cada posición en ARS usando el tipo de cambio CCL vigente.
    """
    tc = tipo_cambio_service.get_tipo_cambio()
    tc_ccl = tc.get("ccl")

    if formato == "csv":
        csv_data = reportes_regulatorios_service.export_bcra_csv(db, fecha, tc_ccl=tc_ccl)
        filename = f"bcra_cambios_{fecha.strftime('%Y%m%d')}.csv"
        return Response(
            content=csv_data,
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    rows = reportes_regulatorios_service.reporte_posicion_cambios_bcra(db, fecha, tc_ccl=tc_ccl)
    return {
        "fecha": fecha.isoformat(),
        "tc_ccl_referencia": tc_ccl,
        "total_posiciones": len(rows),
        "posiciones": rows,
    }


@router.get("/uif-inusuales")
def reporte_uif_inusuales(
    fecha: date = Query(default_factory=date.today),
    umbral_monto: float = Query(default=1_000_000.0, description="Umbral ARS para alerta"),
    formato: str = Query(default="json", description="json | csv"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """
    Reporte UIF/UIAF: operaciones inusuales.
    Detecta fills con importe >= umbral_monto o clientes PEP.
    """
    if formato == "csv":
        csv_data = reportes_regulatorios_service.export_uif_csv(
            db, fecha, umbral_monto=umbral_monto
        )
        filename = f"uif_inusuales_{fecha.strftime('%Y%m%d')}.csv"
        return Response(
            content=csv_data,
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    rows = reportes_regulatorios_service.reporte_uif_inusuales(
        db, fecha, umbral_monto=umbral_monto
    )
    return {
        "fecha": fecha.isoformat(),
        "umbral_monto": umbral_monto,
        "total_alertas": len(rows),
        "operaciones_inusuales": rows,
    }
