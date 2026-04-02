"""
Centralised order state constants shared across services.
Import from here instead of defining inline sets in each service.
"""

# Instancias que bloquean nuevas ejecuciones (fills)
INSTANCIAS_BLOQUEANTES: frozenset[str] = frozenset({
    "Compliance Ordenes",
    "Susp.Operativa N1",
    "Rechazada",
    "Concertada",            # full fill awaiting bilateral confirmation
    "Parcialmente Concertada",  # partial fill awaiting bilateral confirmation
})

# estado_color values that block fills
COLORES_BLOQUEANTES: frozenset[str] = frozenset({"red"})

# Terminal states — no further fills or modifications allowed
INSTANCIAS_TERMINALES: frozenset[str] = frozenset({
    "Ejecutada",
    "Cancelada",
    "Rechazada",
})

# States that require bilateral confirmation (mercado-driven)
MERCADOS_CON_CONFIRMACION: frozenset[str] = frozenset({"MAE", "ROFEX"})

# Instancia codes
COD_PENDIENTE            = 1
COD_PARC_CONCERTADA      = 6
COD_CONCERTADA           = 7
COD_RECHAZADA            = 8
COD_EJECUTADA            = 9
COD_CANCELADA            = 0
COD_SUSP_OPERATIVA       = 48
COD_COMPLIANCE           = 169
COD_PARC_EJECUTADA       = 5
