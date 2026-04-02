# Import all models so Base.metadata knows about every table before create_all()
# Order matters for FK resolution:
#   Account before BotInstancia (cuenta_id FK)
#   EspecieMercado before Instrumento (especie FK)
#   Instrumento before LlamadoMargen (instrumento_id FK)
#   Contraparte before Ejecucion/Confirmacion (contraparte_id FK)
from app.models.account import Account
from app.models.account_entry import AccountEntry
from app.models.orden import Orden
from app.models.contraparte import Contraparte, LimiteCreditoContraparte
from app.models.ejecucion import Ejecucion
from app.models.confirmacion import Confirmacion
from app.models.notificacion import Notificacion
from app.models.posicion import Posicion
from app.models.comision import Comision
from app.models.audit_log import AuditLog
from app.models.precio_mercado import PrecioMercado
from app.models.precio_historico import PrecioHistorico
from app.models.user import User
from app.models.refresh_token import RefreshToken
from app.models.cliente import Cliente
from app.models.especie_mercado import EspecieMercado
from app.models.bot_instancia import BotInstancia
from app.models.settlement_rule import SettlementRule
from app.models.limite_riesgo import LimiteRiesgo
# Feature 5 — instrument catalog
from app.models.instrumento import Instrumento, RentaFijaDetalle, FuturoRofexDetalle, LlamadoMargen
# Feature 7 — daily P&L
from app.models.pnl_diario import PnlDiario
# Feature 8 — FX rate history
from app.models.tipo_cambio import TipoCambioHistorico
# Feature 15 — desk / operador
from app.models.operador import Operador
# System configuration
from app.models.config_sistema import ConfigSistema
# Feature — user alert rules
from app.models.alerta_usuario import AlertaUsuario

__all__ = [
    "Account", "AccountEntry",
    "Orden", "Ejecucion", "Notificacion", "Posicion", "Comision",
    "AuditLog", "PrecioMercado", "PrecioHistorico", "User", "RefreshToken",
    "Cliente", "EspecieMercado", "BotInstancia",
    "Contraparte", "LimiteCreditoContraparte", "Confirmacion",
    "SettlementRule", "LimiteRiesgo",
    # New
    "Instrumento", "RentaFijaDetalle", "FuturoRofexDetalle", "LlamadoMargen",
    "PnlDiario",
    "TipoCambioHistorico",
    "Operador",
    "ConfigSistema",
    "AlertaUsuario",
]
