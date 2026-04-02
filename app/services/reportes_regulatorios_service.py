"""
Regulatory reporting service.

Generates three mandatory reports for Argentine financial entities:

1. reporte_cnv_byma(db, fecha)
   — Daily fill report in CNV/BYMA format.
     Includes all fills for the date with instrument, client, counterparty, and amounts.

2. reporte_posicion_cambios_bcra(db, fecha)
   — BCRA foreign-currency position report.
     Lists open positions in USD-denominated instruments with ARS valuation.

3. reporte_uif_inusuales(db, fecha, umbral_monto)
   — UIF/UIAF unusual-operations detection.
     Flags fills exceeding the monetary threshold OR belonging to PEP clients.

All functions return list[dict] for JSON API responses.
Each function also exposes an export_csv() variant for file downloads.
"""

import csv
import io
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.ejecucion import Ejecucion
from app.models.orden import Orden
from app.models.posicion import Posicion
from app.models.comision import Comision
from app.models.cliente import Cliente
from app.models.contraparte import Contraparte
from app.models.bot_instancia import TIPOS_VENTA as _TIPOS_VENTA

# Monedas consideradas "extranjeras" para reporte BCRA
_MONEDAS_EXTRANJERAS = {"USD", "USX", "EUR"}

# Umbral UIF por defecto: ARS 1,000,000 (operación "inusual" a reportar)
_UMBRAL_UIF_DEFAULT = 1_000_000.0


# ── CNV / BYMA — operaciones concertadas diarias ─────────────────────────────

def reporte_cnv_byma(db: Session, fecha: date) -> list[dict]:
    """
    Daily trades report for CNV/BYMA submission.
    Includes every fill (ejecución) for the given date with associated data.
    """
    rows = db.execute(
        select(
            Ejecucion, Orden, Comision, Contraparte
        )
        .join(Orden, Ejecucion.orden_id == Orden.id)
        .outerjoin(Comision, Comision.ejecucion_id == Ejecucion.id)
        .outerjoin(Contraparte, Contraparte.id == Ejecucion.contraparte_id)
        .where(Ejecucion.fecha == fecha)
        .order_by(Ejecucion.id)
    ).all()

    result = []
    for ejec, orden, com, contra in rows:
        importe = round(ejec.cantidad * ejec.precio, 2)
        result.append({
            "nro_operacion":     ejec.id,
            "fecha":             ejec.fecha.strftime("%d/%m/%Y") if ejec.fecha else None,
            "fecha_liquidacion": ejec.fecha_liquidacion.strftime("%d/%m/%Y") if ejec.fecha_liquidacion else None,
            "nro_orden":         orden.nro_orden,
            "tipo_orden":        orden.tipo_orden,
            "especie":           orden.especie,
            "moneda":            orden.moneda,
            "cliente":           orden.cliente,
            "razon_social":      orden.razon_social,
            "mercado":           ejec.mercado,
            "cantidad":          ejec.cantidad,
            "precio":            ejec.precio,
            "importe":           importe,
            "comision_total":    round(com.monto_total, 2) if com else 0,
            "importe_neto":      round(
                importe - (com.monto_total if com else 0)
                if orden.tipo_orden.upper() in _TIPOS_VENTA
                else importe + (com.monto_total if com else 0),
                2,
            ),
            "contraparte_codigo": contra.codigo if contra else None,
            "contraparte_nombre": contra.nombre if contra else None,
            "liquidada":         ejec.liquidada,
            "nro_secuencia":     ejec.nro_secuencia,
        })
    return result


def export_cnv_byma_csv(db: Session, fecha: date) -> str:
    """Returns CSV string of the CNV/BYMA report."""
    rows = reporte_cnv_byma(db, fecha)
    if not rows:
        return ""
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


# ── BCRA — posición de cambios ────────────────────────────────────────────────

def reporte_posicion_cambios_bcra(
    db: Session,
    fecha: date,
    tc_ccl: float | None = None,
) -> list[dict]:
    """
    BCRA foreign-currency position report.
    Lists all open positions in USD/EUR-denominated instruments.
    Optionally enriches with ARS valuation if tc_ccl is provided.
    """
    posiciones = db.execute(
        select(Posicion)
        .where(
            Posicion.moneda.in_(_MONEDAS_EXTRANJERAS),
            Posicion.cantidad_neta != 0,
        )
        .order_by(Posicion.especie, Posicion.cliente)
    ).scalars().all()

    # Load client details for classification
    clientes_map: dict[str, Cliente] = {}
    codigos = list({p.cliente for p in posiciones})
    if codigos:
        for cli in db.execute(
            select(Cliente).where(Cliente.codigo.in_(codigos))
        ).scalars().all():
            clientes_map[cli.codigo] = cli

    result = []
    for p in posiciones:
        cli = clientes_map.get(p.cliente)
        row: dict = {
            "fecha":             fecha.isoformat(),
            "especie":           p.especie,
            "moneda":            p.moneda,
            "cliente":           p.cliente,
            "razon_social":      cli.razon_social if cli else p.cliente,
            "tipo_cartera":      "PROPIA" if (cli and cli.es_cartera_propia) else "TERCEROS",
            "cantidad_neta":     p.cantidad_neta,
            "costo_promedio":    p.costo_promedio_compra,
            "valor_moneda_orig": round(p.cantidad_neta * (p.costo_promedio_compra or 0), 2),
        }
        if tc_ccl:
            row["tc_ccl"] = tc_ccl
            row["valor_ars"] = round(row["valor_moneda_orig"] * tc_ccl, 2)
        result.append(row)
    return result


def export_bcra_csv(db: Session, fecha: date, tc_ccl: float | None = None) -> str:
    rows = reporte_posicion_cambios_bcra(db, fecha, tc_ccl=tc_ccl)
    if not rows:
        return ""
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


# ── UIF / UIAF — operaciones inusuales ───────────────────────────────────────

def reporte_uif_inusuales(
    db: Session,
    fecha: date,
    umbral_monto: float = _UMBRAL_UIF_DEFAULT,
) -> list[dict]:
    """
    UIF unusual-operations detection.

    An operation is flagged if ANY of:
      - importe (cantidad × precio) >= umbral_monto
      - the client is marked as PEP (Persona Expuesta Políticamente)

    Returns list of flagged fills with reason_flags list.
    """
    # Load all PEP client codes
    pep_codigos = set(
        row[0] for row in db.execute(
            select(Cliente.codigo).where(Cliente.es_pep == True)
        ).all()
    )

    rows = db.execute(
        select(Ejecucion, Orden, Contraparte)
        .join(Orden, Ejecucion.orden_id == Orden.id)
        .outerjoin(Contraparte, Contraparte.id == Ejecucion.contraparte_id)
        .where(Ejecucion.fecha == fecha)
        .order_by(Ejecucion.id)
    ).all()

    result = []
    for ejec, orden, contra in rows:
        importe = ejec.cantidad * ejec.precio
        flags = []

        if importe >= umbral_monto:
            flags.append(f"MONTO_ALTO (>= {umbral_monto:,.0f} ARS)")
        if orden.cliente in pep_codigos:
            flags.append("CLIENTE_PEP")

        if not flags:
            continue

        result.append({
            "nro_operacion":      ejec.id,
            "fecha":              ejec.fecha.strftime("%d/%m/%Y") if ejec.fecha else None,
            "nro_orden":          orden.nro_orden,
            "especie":            orden.especie,
            "moneda":             orden.moneda,
            "cliente":            orden.cliente,
            "razon_social":       orden.razon_social,
            "mercado":            ejec.mercado,
            "cantidad":           ejec.cantidad,
            "precio":             ejec.precio,
            "importe":            round(importe, 2),
            "contraparte_codigo": contra.codigo if contra else None,
            "motivos_alerta":     flags,
            "umbral_aplicado":    umbral_monto,
        })
    return result


def export_uif_csv(
    db: Session,
    fecha: date,
    umbral_monto: float = _UMBRAL_UIF_DEFAULT,
) -> str:
    rows = reporte_uif_inusuales(db, fecha, umbral_monto=umbral_monto)
    if not rows:
        return ""
    # Flatten motivos_alerta list to string for CSV
    for row in rows:
        row["motivos_alerta"] = " | ".join(row["motivos_alerta"])
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()
