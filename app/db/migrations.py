"""
Idempotent schema migrations for columns added after initial table creation.
Run once at startup (before create_all) via run_migrations(engine).

Each ALTER TABLE is wrapped in try/except so it is safe to run on an already-
migrated database (SQLite raises OperationalError when a column already exists).
"""

import logging

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError

_log = logging.getLogger(__name__)

# Substrings that identify benign "already migrated" errors per backend.
# Anything else bubbles up so real problems (disk full, permissions, bad SQL)
# are not silently swallowed.
_BENIGN_ERROR_FRAGMENTS = (
    "duplicate column",          # SQLite / MySQL
    "already exists",            # SQLite index / PostgreSQL / MySQL
    "duplicate key name",        # MySQL index
    # Fresh-DB case: tables do not exist yet on first startup. create_all()
    # runs immediately after run_migrations() and creates every table with
    # the new columns already defined in the SQLAlchemy models, so skipping
    # ALTER/CREATE INDEX on a missing table is safe.
    "no such table",             # SQLite
    "undefined table",           # PostgreSQL
    "doesn't exist",             # MySQL ("table 'x' doesn't exist")
)


def _is_benign_migration_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(frag in msg for frag in _BENIGN_ERROR_FRAGMENTS)


def run_migrations(engine: Engine) -> None:
    _migrations = [
        # ── ejecuciones ──────────────────────────────────────────────────────
        # fecha_liquidacion: settlement date; NULL for fills created before migration
        "ALTER TABLE ejecuciones ADD COLUMN fecha_liquidacion DATE",
        # liquidada: 1=settled (cash/positions finalised), default 1 for existing rows
        "ALTER TABLE ejecuciones ADD COLUMN liquidada BOOLEAN NOT NULL DEFAULT 1",
        # contraparte_id: FK to contrapartes, nullable (optional for non-MAE/ROFEX fills)
        "ALTER TABLE ejecuciones ADD COLUMN contraparte_id INTEGER REFERENCES contrapartes(id)",
        # requiere_confirmacion: 1=bilateral confirmation required (MAE/ROFEX)
        "ALTER TABLE ejecuciones ADD COLUMN requiere_confirmacion BOOLEAN NOT NULL DEFAULT 0",

        # ── posiciones ───────────────────────────────────────────────────────
        # cantidad_pendiente_liquidacion: qty committed but not yet settled
        "ALTER TABLE posiciones ADD COLUMN cantidad_pendiente_liquidacion INTEGER NOT NULL DEFAULT 0",

        # ── accounts ─────────────────────────────────────────────────────────
        # balance_reservado: sum of pending (unsettled) debit entries
        "ALTER TABLE accounts ADD COLUMN balance_reservado NUMERIC(18,6) NOT NULL DEFAULT 0",

        # ── account_entries ──────────────────────────────────────────────────
        "ALTER TABLE account_entries ADD COLUMN fecha_liquidacion DATE",
        # liquidada: 1=cash movement finalised (existing entries are settled by default)
        "ALTER TABLE account_entries ADD COLUMN liquidada BOOLEAN NOT NULL DEFAULT 1",

        # ── clientes (feature 6/9) ────────────────────────────────────────────
        # es_cartera_propia: True = fund's proprietary book (vs. third-party clients)
        "ALTER TABLE clientes ADD COLUMN es_cartera_propia BOOLEAN NOT NULL DEFAULT 0",
        # es_pep: Persona Expuesta Políticamente — required for UIF reporting
        "ALTER TABLE clientes ADD COLUMN es_pep BOOLEAN NOT NULL DEFAULT 0",

        # ── ordenes (features 10/11A/11B/11C) ────────────────────────────────
        # Feature 10 — Blotter: operator who created the order
        "ALTER TABLE ordenes ADD COLUMN usuario VARCHAR(50)",
        # Feature 11A — Market orders: LIMITE (default) or MERCADO
        "ALTER TABLE ordenes ADD COLUMN tipo_precio VARCHAR(10) NOT NULL DEFAULT 'LIMITE'",
        # Feature 11A — Time-in-force: DAY, IOC, FOK, GTD
        "ALTER TABLE ordenes ADD COLUMN time_in_force VARCHAR(5) NOT NULL DEFAULT 'DAY'",
        # Feature 11A — GTD expiry date (NULL for non-GTD)
        "ALTER TABLE ordenes ADD COLUMN fecha_exp DATE",
        # Feature 11B — Iceberg: visible qty shown in orderbook (NULL = not iceberg)
        "ALTER TABLE ordenes ADD COLUMN cantidad_visible INTEGER",
        # Feature 11C — Stop/TP: trigger type (STOP_LOSS | TAKE_PROFIT | NULL)
        "ALTER TABLE ordenes ADD COLUMN tipo_activacion VARCHAR(15)",
        # Feature 11C — Stop/TP: activation price threshold
        "ALTER TABLE ordenes ADD COLUMN precio_activacion REAL",
        # Feature 11C — Stop/TP: False = waiting for trigger; existing rows default True
        "ALTER TABLE ordenes ADD COLUMN activa BOOLEAN NOT NULL DEFAULT 1",

        # ── ordenes (feature 15) ──────────────────────────────────────────────
        # Feature 15 — desk / cost center (ACCIONES|RENTA_FIJA|DERIVADOS|FCI)
        "ALTER TABLE ordenes ADD COLUMN desk VARCHAR(15)",

        # ── pnl_diario (feature 15) ───────────────────────────────────────────
        # Feature 15 — desk attribution for P&L by cost center
        "ALTER TABLE pnl_diario ADD COLUMN desk VARCHAR(15)",

        # ── precios_historico (feature 16) ────────────────────────────────────
        # Feature 16 — price type: CIERRE|AJUSTE|CORTE_MAE (existing rows = CIERRE)
        "ALTER TABLE precios_historico ADD COLUMN precio_tipo VARCHAR(15) NOT NULL DEFAULT 'CIERRE'",

        # ── config_sistema — market-wide macro bias for bots ──────────────────
        # mercado_sesgo: -1.0 (full bear) … 0.0 (neutral) … +1.0 (full bull)
        # Applied as an additional ±15 pp weight on every bot's buy/sell decision.
        "ALTER TABLE config_sistema ADD COLUMN mercado_sesgo REAL NOT NULL DEFAULT 0",

        # ── precios_mercado — intraday volume & VWAP ──────────────────────────
        # volumen_dia: cumulative executed quantity since fecha_volumen (resets daily)
        "ALTER TABLE precios_mercado ADD COLUMN volumen_dia INTEGER NOT NULL DEFAULT 0",
        # vwap: volume-weighted average execution price for the current day
        "ALTER TABLE precios_mercado ADD COLUMN vwap REAL NOT NULL DEFAULT 0",
        # fecha_volumen: the date volumen_dia/vwap belong to; used to detect day roll
        "ALTER TABLE precios_mercado ADD COLUMN fecha_volumen DATE",

        # ── especies_mercado — per-instrument limits ───────────────────────────
        # volumen_max_dia: circuit breaker — halt matching once this qty is reached (NULL = no limit)
        "ALTER TABLE especies_mercado ADD COLUMN volumen_max_dia INTEGER",
        # cantidad_max_orden: reject orders whose cantidad_total exceeds this (NULL = no limit)
        "ALTER TABLE especies_mercado ADD COLUMN cantidad_max_orden INTEGER",

        # ── bot_instancias — per-bot behaviour overrides ───────────────────────
        # When set, these override the corresponding field from the bot's PerfilConfig.
        # NULL means "use the profile default".
        # Max price deviation before a pending order is cancelled as stale
        "ALTER TABLE bot_instancias ADD COLUMN stale_offset_pct REAL",
        # Max fraction of available balance to allocate per order
        "ALTER TABLE bot_instancias ADD COLUMN capital_fraccion_max REAL",
        # Accumulation/Distribution cycle length (ticks per phase)
        "ALTER TABLE bot_instancias ADD COLUMN ciclo_min_ticks INTEGER",
        "ALTER TABLE bot_instancias ADD COLUMN ciclo_max_ticks INTEGER",
        # Fill-reaction: probability of placing a counter-order after a fill
        "ALTER TABLE bot_instancias ADD COLUMN fill_react_prob REAL",
        # Fill-reaction: price markup/markdown on the counter-order
        "ALTER TABLE bot_instancias ADD COLUMN fill_react_markup REAL",
        # Market order probability override (NULL = use profile default)
        "ALTER TABLE bot_instancias ADD COLUMN prob_orden_mercado REAL",

        # ── rename OTIC→LIMC / OTIV→LIMV / COMP→LIMC / VENTA→LIMV ───────────
        # Data migrations — safe to run repeatedly (UPDATE WHERE is idempotent)
        "UPDATE ordenes        SET tipo_orden  = 'LIMC' WHERE tipo_orden  = 'OTIC'",
        "UPDATE ordenes        SET tipo_orden  = 'LIMV' WHERE tipo_orden  = 'OTIV'",
        "UPDATE ordenes        SET tipo_orden  = 'LIMC' WHERE tipo_orden  = 'COMP'",
        "UPDATE ordenes        SET tipo_orden  = 'LIMV' WHERE tipo_orden  = 'VENTA'",
        "UPDATE bot_instancias SET tipos_orden = REPLACE(tipos_orden, 'OTIC',  'LIMC')",
        "UPDATE bot_instancias SET tipos_orden = REPLACE(tipos_orden, 'OTIV',  'LIMV')",
        "UPDATE bot_instancias SET tipos_orden = REPLACE(tipos_orden, 'COMP',  'LIMC')",
        "UPDATE bot_instancias SET tipos_orden = REPLACE(tipos_orden, 'VENTA', 'LIMV')",
        # Normalize duplicates that REPLACE can create (e.g. "LIMC,LIMC" → "LIMC")
        "UPDATE bot_instancias SET tipos_orden = 'LIMC'      WHERE tipos_orden = 'LIMC,LIMC'",
        "UPDATE bot_instancias SET tipos_orden = 'LIMV'      WHERE tipos_orden = 'LIMV,LIMV'",
        "UPDATE bot_instancias SET tipos_orden = 'LIMC,LIMV' WHERE tipos_orden = 'LIMV,LIMC'",

        # ── operadores — linked client account (feature client-operator) ────────
        "ALTER TABLE operadores ADD COLUMN cliente_codigo VARCHAR(20)",

        # ── alertas_usuario — user-defined notification rules ─────────────────
        # Table is created by create_all() on first run; these are safe no-ops
        # on existing databases that pre-date the feature.
        "CREATE TABLE IF NOT EXISTS alertas_usuario (id INTEGER PRIMARY KEY, username VARCHAR(50) NOT NULL, tipo VARCHAR(30) NOT NULL, cliente VARCHAR(50), especie VARCHAR(20), umbral NUMERIC(18,2) NOT NULL, moneda VARCHAR(5) NOT NULL DEFAULT 'ARP', activo BOOLEAN NOT NULL DEFAULT 1, created_at DATETIME, ultima_vez DATETIME)",
        "CREATE INDEX IF NOT EXISTS idx_alertas_username ON alertas_usuario(username)",

        # ── precios_mercado — daily OHLC (Open, High, Low, Close) ─────────────
        # Used for watchlist price range display
        "ALTER TABLE precios_mercado ADD COLUMN precio_apertura REAL",
        "ALTER TABLE precios_mercado ADD COLUMN precio_cierre REAL",
        "ALTER TABLE precios_mercado ADD COLUMN precio_minimo REAL",
        "ALTER TABLE precios_mercado ADD COLUMN precio_maximo REAL",
        "ALTER TABLE precios_mercado ADD COLUMN fecha_ohlc DATE",

        # ── usuario_seguido — user watchlist ──────────────────────────────────
        # Table is created by create_all() on first run; these are safe no-ops
        # on existing databases that pre-date the feature.
        "CREATE TABLE IF NOT EXISTS usuario_seguido (id INTEGER PRIMARY KEY, usuario_id INTEGER NOT NULL, especie VARCHAR(20) NOT NULL, precio_compra_meta REAL, precio_venta_meta REAL, created_at DATETIME, FOREIGN KEY(usuario_id) REFERENCES users(id), FOREIGN KEY(especie) REFERENCES especies_mercado(especie), UNIQUE(usuario_id, especie))",
        "CREATE INDEX IF NOT EXISTS idx_usuario_seguido_usuario_id ON usuario_seguido(usuario_id)",
        "CREATE INDEX IF NOT EXISTS idx_usuario_seguido_especie ON usuario_seguido(especie)",
        # orden: manual sort position added after initial table creation
        "ALTER TABLE usuario_seguido ADD COLUMN orden INTEGER",
        "CREATE INDEX IF NOT EXISTS idx_usuario_seguido_orden ON usuario_seguido(usuario_id, orden)",

        # ── indexes ───────────────────────────────────────────────────────────
        # CREATE INDEX IF NOT EXISTS is idempotent — safe to run on any DB state.

        # Blotter: fetch all orders for a given date
        "CREATE INDEX IF NOT EXISTS idx_ordenes_fecha ON ordenes(fecha_orden)",
        # Matching engine + bot queries: active orders by especie
        "CREATE INDEX IF NOT EXISTS idx_ordenes_especie_activa ON ordenes(especie, instancia_codigo, activa)",
        # Bot position/pending-sell queries
        "CREATE INDEX IF NOT EXISTS idx_ordenes_bot_id ON ordenes(bot_id)",
        # Risk / account queries by client code
        "CREATE INDEX IF NOT EXISTS idx_ordenes_cliente ON ordenes(cliente)",
        # Fills join: executions for an order
        "CREATE INDEX IF NOT EXISTS idx_ejecuciones_orden_id ON ejecuciones(orden_id)",
        # Account ledger queries
        "CREATE INDEX IF NOT EXISTS idx_account_entries_account_id ON account_entries(account_id)",
        # Price history queries by especie + date
        "CREATE INDEX IF NOT EXISTS idx_precios_hist_especie ON precios_historico(especie, fecha DESC)",
        # Settlement job: find fills pending liquidation up to a given date.
        # liquidada first (highly selective — only a small % is unsettled).
        "CREATE INDEX IF NOT EXISTS idx_ejecuciones_liquidacion ON ejecuciones(liquidada, fecha_liquidacion)",
        # Account entries settlement counterpart (same query shape)
        "CREATE INDEX IF NOT EXISTS idx_account_entries_liquidacion ON account_entries(liquidada, fecha_liquidacion)",
    ]

    with engine.connect() as conn:
        for stmt in _migrations:
            try:
                conn.execute(text(stmt))
            except OperationalError as exc:
                if _is_benign_migration_error(exc):
                    continue  # already migrated
                _log.error("Migración falló: %s — %s", stmt, exc)
                raise
            except Exception as exc:
                _log.error("Migración falló con error inesperado: %s — %s", stmt, exc)
                raise
        conn.commit()

    _log.info("Migraciones de esquema ejecutadas.")
