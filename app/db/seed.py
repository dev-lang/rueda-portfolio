from decimal import Decimal
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.models.user import User
from app.models.cliente import Cliente
from app.models.especie_mercado import EspecieMercado
from app.models.bot_instancia import BotInstancia
from app.models.operador import Operador
from app.models.account import Account
from app.models.account_entry import AccountEntry
from app.models.settlement_rule import SettlementRule
from app.models.contraparte import Contraparte, LimiteCreditoContraparte
from app.models.limite_riesgo import LimiteRiesgo
from app.models.instrumento import Instrumento, RentaFijaDetalle, FuturoRofexDetalle
from app.models.config_sistema import ConfigSistema

# ── Clientes iniciales ────────────────────────────────────────────────────────
# (codigo, nombre, razon_social)
_CLIENTES: list[tuple[str, str, str]] = [
    ("STD",  "Cartera STD",    "Cartera Propia STD"),
    ("CLI1", "Cliente Uno",    "Inversiones Cliente Uno S.A."),
    ("CLI2", "Cliente Dos",    "Administradora Cliente Dos S.R.L."),
]

# ── Tickers de mercado ────────────────────────────────────────────────────────
# (especie, yf_symbol, panel, nombre)
_TICKERS: list[tuple[str, str | None, str, str | None]] = [
    # BYMA Panel Líder
    ("ALUA",  "ALUA.BA",  "BYMA",   "Aluar Aluminio"),
    ("BBAR",  "BBAR.BA",  "BYMA",   "Banco BBVA"),
    ("BMA",   "BMA.BA",   "BYMA",   "Banco Macro"),
    ("BYMA",  "BYMA.BA",  "BYMA",   "Bolsas y Mercados Argentinos"),
    ("CEPU",  "CEPU.BA",  "BYMA",   "Central Puerto"),
    ("COME",  "COME.BA",  "BYMA",   "Sociedad Comercial del Plata"),
    ("CRES",  "CRES.BA",  "BYMA",   "Cresud"),
    ("EDN",   "EDN.BA",   "BYMA",   "Edenor"),
    ("GGAL",  "GGAL.BA",  "BYMA",   "Grupo Financiero Galicia"),
    ("LOMA",  "LOMA.BA",  "BYMA",   "Loma Negra"),
    ("METR",  "METR.BA",  "BYMA",   "MetroGAS"),
    ("PAMP",  "PAMP.BA",  "BYMA",   "Pampa Energía"),
    ("SUPV",  "SUPV.BA",  "BYMA",   "Grupo Supervielle"),
    ("TECO2", "TECO2.BA", "BYMA",   "Telecom Argentina"),
    ("TGNO4", "TGNO4.BA", "BYMA",   "Transportadora Gas del Norte"),
    ("TGSU2", "TGSU2.BA", "BYMA",   "Transportadora Gas del Sur"),
    ("TRAN",  "TRAN.BA",  "BYMA",   "Transener"),
    ("TXAR",  "TXAR.BA",  "BYMA",   "Ternium Argentina"),
    ("VALO",  "VALO.BA",  "BYMA",   "Banco de Valores S.A."),
    ("YPFD",  "YPFD.BA",  "BYMA",   "YPF"),
    # Merval General
    ("A3",    "A3.BA",    "MERVAL", "A3 Mercados S.A."),
    ("AGRO",  "AGRO.BA",  "MERVAL", "Agrometal"),
    ("AUSO",  "AUSO.BA",  "MERVAL", "Autopistas del Sol"),
    ("BHIP",  "BHIP.BA",  "MERVAL", "Banco Hipotecario"),
    ("BOLT",  "BOLT.BA",  "MERVAL", "Boldt"),
    ("BPAT",  "BPAT.BA",  "MERVAL", "Banco Patagonia"),
    ("CADO",  "CADO.BA",  "MERVAL", "Carlos Casado"),
    ("CAPX",  "CAPX.BA",  "MERVAL", "Capex"),
    ("CARC",  "CARC.BA",  "MERVAL", "Carboclor S.A."),
    ("CECO2", "CECO2.BA", "MERVAL", "Central Costanera"),
    ("CELU",  "CELU.BA",  "MERVAL", "Celulosa"),
    ("CGPA2", "CGPA2.BA", "MERVAL", "Camuzzi Gas Pampeana S.A."),
    ("CTIO",  "CTIO.BA",  "MERVAL", "Consultatio"),
    ("CVH",   "CVH.BA",   "MERVAL", "Cablevision Holding"),
    ("DGCE",  "DGCE.BA",  "MERVAL", "Distribuidora de Gas del Centro"),
    ("DGCU2", "DGCU2.BA", "MERVAL", "Distribuidora de Gas Cuyana"),
    ("DOME",  "DOME.BA",  "MERVAL", "DOMEC Cía. de Artefactos Domésticos"),
    ("ECOG",  "ECOG.BA",  "MERVAL", "ECOGAS Inversiones S.A."),
    ("EDSH",  "EDSH.BA",  "MERVAL", "EDESA Holding S.A."),
    ("FERR",  "FERR.BA",  "MERVAL", "Ferrum"),
    ("FIPL",  "FIPL.BA",  "MERVAL", "Fiplasto"),
    ("GAMI",  "GAMI.BA",  "MERVAL", "B-Gaming S.A."),
    ("GARO",  "GARO.BA",  "MERVAL", "Garovaglio y Zorraquín S.A."),
    ("GBAN",  "GBAN.BA",  "MERVAL", "Naturgy BAN S.A."),
    ("GCDI",  "GCDI.BA",  "MERVAL", "GCDI S.A."),
    ("GCLA",  "GCLA.BA",  "MERVAL", "Grupo Clarín S.A."),
    ("GRIM",  "GRIM.BA",  "MERVAL", "Grimoldi"),
    ("HARG",  "HARG.BA",  "MERVAL", "Holcim (Argentina) S.A."),
    ("HAVA",  "HAVA.BA",  "MERVAL", "Havanna"),
    ("HSAT",  "HSAT.BA",  "MERVAL", "Holdsat S.A."),
    ("IEB",   "IEB.BA",   "MERVAL", "IEB Construcciones S.A."),
    ("INTR",  "INTR.BA",  "MERVAL", "Compañía Introductora de Buenos Aires S.A."),
    ("INVJ",  "INVJ.BA",  "MERVAL", "Inversora Juramento"),
    ("IRSA",  "IRSA.BA",  "MERVAL", "IRSA"),
    ("LEDE",  "LEDE.BA",  "MERVAL", "Ledesma"),
    ("LONG",  "LONG.BA",  "MERVAL", "Longvie"),
    ("MIRG",  "MIRG.BA",  "MERVAL", "Mirgor"),
    ("MOLA",  "MOLA.BA",  "MERVAL", "Molinos Agro S.A."),
    ("MOLI",  "MOLI.BA",  "MERVAL", "Molinos Río de la Plata"),
    ("MORI",  "MORI.BA",  "MERVAL", "Morixe"),
    ("OEST",  "OEST.BA",  "MERVAL", "Oeste"),
    ("PATA",  "PATA.BA",  "MERVAL", "S.A. Importadora y Exportadora de la Patagonia"),
    ("POLL",  "POLL.BA",  "MERVAL", "Polledo"),
    ("RAGH",  "RAGH.BA",  "MERVAL", "RAGHSA S.A."),
    ("REGE",  "REGE.BA",  "MERVAL", "García Reguera S.A."),
    ("RICH",  "RICH.BA",  "MERVAL", "Laboratorios Richmond S.A.C.I.F."),
    ("RIGO",  "RIGO.BA",  "MERVAL", "Rigolleau"),
    ("ROSE",  "ROSE.BA",  "MERVAL", "Instituto Rosenbusch S.A."),
    ("SAMI",  "SAMI.BA",  "MERVAL", "San Miguel"),
    ("SEMI",  "SEMI.BA",  "MERVAL", "Molinos Juan Semino S.A."),
]


def seed_database(_db: Session) -> None:
    """No-op — operational data (orders, executions, notifications) is not pre-seeded."""
    pass


def seed_admin_user(db: Session) -> None:
    """Creates admin + 2 operadores on first startup if no users exist."""
    from app.core.config import settings
    from app.core.security import hash_password

    if db.execute(select(User)).first():
        return  # users already exist

    admin = User(
        username=settings.ADMIN_USERNAME,
        hashed_password=hash_password(settings.ADMIN_PASSWORD),
        role="ADMIN",
        is_active=True,
    )
    op1 = User(
        username=settings.OPERADOR1_USERNAME,
        hashed_password=hash_password(settings.OPERADOR1_PASSWORD),
        role="OPERADOR",
        is_active=True,
    )
    op2 = User(
        username=settings.OPERADOR2_USERNAME,
        hashed_password=hash_password(settings.OPERADOR2_PASSWORD),
        role="OPERADOR",
        is_active=True,
    )
    db.add_all([admin, op1, op2])
    db.commit()
    print(
        f"✅ Usuarios creados: ADMIN='{settings.ADMIN_USERNAME}', "
        f"OPERADOR='{settings.OPERADOR1_USERNAME}', OPERADOR='{settings.OPERADOR2_USERNAME}'. "
        "Cambiá las contraseñas en producción."
    )


def seed_clientes(db: Session) -> None:
    """Seeds initial client registry if empty."""
    if db.execute(select(Cliente)).first():
        return
    for codigo, nombre, razon_social in _CLIENTES:
        db.add(Cliente(codigo=codigo, nombre=nombre, razon_social=razon_social))
    db.commit()
    print(f"✅ {len(_CLIENTES)} clientes iniciales creados.")


def seed_bot_instancias(db: Session) -> None:
    """Seeds 2 bot instances per profile (8 total) if the table is empty."""
    from sqlalchemy import select
    if db.execute(select(BotInstancia)).first():
        return
    bots = [
        # ── CONSERVADOR ──────────────────────────────────────────────────────
        BotInstancia(
            nombre="Conservador Alfa",
            enabled=True,
            interval=15.0,
            variance=0.004,
            max_ordenes=10,
            tipos_orden="LIMC,LIMV",
            perfil="CONSERVADOR",
            fill_rate=0.25,
        ),
        BotInstancia(
            nombre="Conservador Beta",
            enabled=True,
            interval=18.0,
            variance=0.003,
            max_ordenes=10,
            tipos_orden="LIMC,LIMV",
            perfil="CONSERVADOR",
            fill_rate=0.25,
        ),
        # ── MODERADO ─────────────────────────────────────────────────────────
        BotInstancia(
            nombre="Moderado Alfa",
            enabled=True,
            interval=7.0,
            variance=0.008,
            max_ordenes=15,
            tipos_orden="LIMC,LIMV",
            perfil="MODERADO",
            fill_rate=0.45,
        ),
        BotInstancia(
            nombre="Moderado Beta",
            enabled=True,
            interval=8.0,
            variance=0.010,
            max_ordenes=15,
            tipos_orden="LIMC,LIMV",
            perfil="MODERADO",
            fill_rate=0.45,
        ),
        # ── AGRESIVO ─────────────────────────────────────────────────────────
        BotInstancia(
            nombre="Agresivo Alfa",
            enabled=True,
            interval=3.0,
            variance=0.018,
            max_ordenes=20,
            tipos_orden="LIMC",
            perfil="AGRESIVO",
            fill_rate=0.70,
        ),
        BotInstancia(
            nombre="Agresivo Beta",
            enabled=True,
            interval=4.0,
            variance=0.015,
            max_ordenes=20,
            tipos_orden="LIMV",
            perfil="AGRESIVO",
            fill_rate=0.70,
        ),
        # ── TRADER (scalper) ─────────────────────────────────────────────────
        BotInstancia(
            nombre="Trader Alfa",
            enabled=True,
            interval=1.5,
            variance=0.001,
            max_ordenes=25,
            tipos_orden="LIMC,LIMV",
            perfil="TRADER",
            fill_rate=0.85,
        ),
        BotInstancia(
            nombre="Trader Beta",
            enabled=True,
            interval=2.0,
            variance=0.002,
            max_ordenes=25,
            tipos_orden="LIMC,LIMV",
            perfil="TRADER",
            fill_rate=0.85,
        ),
    ]
    db.add_all(bots)
    db.commit()
    print("✅ 8 instancias de bot de mercado creadas (2 por perfil: CONSERVADOR / MODERADO / AGRESIVO / TRADER).")


def seed_cuentas(db: Session) -> None:
    """
    Creates initial cash accounts for all existing clients and bots.
    Skipped if any Account already exists (idempotent).

    Clients get ARP 10,000,000 initial capital.
    Bots get ARP 5,000,000 initial capital plus a BOT_ASIGNACION entry.

    Must be called AFTER seed_clientes() and seed_bot_instancias().
    """
    if db.execute(select(Account)).first():
        return

    clientes = db.execute(select(Cliente)).scalars().all()
    for cliente in clientes:
        capital = Decimal("10000000")
        account = Account(
            owner_type="cliente",
            owner_id=cliente.id,
            moneda="ARP",
            mercado="DEFAULT",
            balance_cache=capital,
            capital_inicial=capital,
        )
        db.add(account)
        db.flush()
        # Record the initial deposit as a ledger entry
        db.add(AccountEntry(
            account_id=account.id,
            tipo="DEPOSITO",
            monto=capital,
            sentido="CREDIT",
            balance_post=capital,
            ref_type="manual",
            descripcion=f"Capital inicial cliente {cliente.codigo}",
            usuario="sistema",
        ))

    bots = db.execute(select(BotInstancia)).scalars().all()
    for bot in bots:
        capital = Decimal("5000000")
        account = Account(
            owner_type="bot",
            owner_id=bot.id,
            moneda="ARP",
            mercado="DEFAULT",
            balance_cache=capital,
            capital_inicial=capital,
        )
        db.add(account)
        db.flush()
        db.add(AccountEntry(
            account_id=account.id,
            tipo="BOT_ASIGNACION",
            monto=capital,
            sentido="CREDIT",
            balance_post=capital,
            ref_type="bot_asignacion",
            ref_id=bot.id,
            descripcion=f"Capital inicial bot '{bot.nombre}'",
            usuario="sistema",
        ))
        bot.cuenta_id = account.id

    db.commit()
    print(f"✅ Cuentas creadas: {len(clientes)} clientes + {len(bots)} bots (ARP 10M / ARP 5M).")


def seed_especies_mercado(db: Session) -> None:
    """Seeds ticker registry from the static list if empty."""
    if db.execute(select(EspecieMercado)).first():
        return
    for especie, yf_symbol, panel, nombre in _TICKERS:
        db.add(EspecieMercado(
            especie=especie,
            yf_symbol=yf_symbol,
            panel=panel,
            nombre=nombre,
            activo=True,
        ))
    db.commit()
    print(f"✅ {len(_TICKERS)} tickers de mercado registrados en DB.")


def seed_settlement_rules(db: Session) -> None:
    """Seeds Argentine market settlement rules (T+0/T+1/T+2) if empty."""
    if db.execute(select(SettlementRule)).first():
        return
    rules = [
        SettlementRule(mercado="BYMA",    tipo_especie="ALL",   dias_habil=2, descripcion="BYMA contado normal (T+2)"),
        SettlementRule(mercado="BYMA_CI", tipo_especie="ALL",   dias_habil=0, descripcion="BYMA contado inmediato (T+0)"),
        SettlementRule(mercado="MAE",     tipo_especie="ALL",   dias_habil=1, descripcion="MAE bonos soberanos (T+1)"),
        SettlementRule(mercado="ROFEX",   tipo_especie="ALL",   dias_habil=0, descripcion="ROFEX ajuste diario (T+0)"),
        SettlementRule(mercado="DEFAULT", tipo_especie="ALL",   dias_habil=0, descripcion="Mercado interno (T+0)"),
    ]
    db.add_all(rules)
    db.commit()
    print(f"✅ {len(rules)} reglas de liquidación creadas (BYMA T+2, BYMA_CI T+0, MAE T+1, ROFEX T+0).")


def seed_contrapartes(db: Session) -> None:
    """Seeds standard Argentine market counterparties if empty."""
    if db.execute(select(Contraparte)).first():
        return
    contrapartes = [
        Contraparte(codigo="BYMA_MKTMKR", nombre="BYMA Market Maker",       tipo="BROKER"),
        Contraparte(codigo="MAE_DEFAULT",  nombre="MAE Participante Default", tipo="MAE_PARTICIPANTE"),
        Contraparte(codigo="ROFEX_CLEAR",  nombre="ROFEX Clearing House",     tipo="ROFEX_CLEARING"),
        Contraparte(codigo="BANCO_AR",     nombre="Banco de la Nación Argentina", tipo="BANCO"),
        Contraparte(codigo="INTNL_BK",     nombre="Banco Internacional S.A.",     tipo="BANCO"),
    ]
    db.add_all(contrapartes)
    db.flush()

    # Add default credit limits (ARP 500M per counterparty)
    for cp in contrapartes:
        db.add(LimiteCreditoContraparte(
            contraparte_id=cp.id,
            moneda="ARP",
            limite=Decimal("500000000"),
            alerta_pct=Decimal("80.00"),
        ))
    db.commit()
    print(f"✅ {len(contrapartes)} contrapartes iniciales creadas con límite ARP 500M c/u.")


def seed_limites_riesgo(db: Session) -> None:
    """Seeds default global risk limits if empty."""
    if db.execute(select(LimiteRiesgo)).first():
        return
    limites = [
        # Global: max single-order notional ARP 100M
        LimiteRiesgo(
            owner_type="global", owner_id=None,
            tipo_limite="SALDO_MAXIMO_ORDEN",
            especie=None, moneda="ARP",
            valor_limite=Decimal("100000000"),
            alerta_pct=Decimal("80.0"),
        ),
        # Global: max daily volume ARP 1B
        LimiteRiesgo(
            owner_type="global", owner_id=None,
            tipo_limite="VOLUMEN_DIARIO",
            especie=None, moneda="ARP",
            valor_limite=Decimal("1000000000"),
            alerta_pct=Decimal("80.0"),
        ),
    ]
    db.add_all(limites)
    db.commit()
    print(f"✅ {len(limites)} límites de riesgo globales creados (max orden ARP 100M, volumen diario ARP 1B).")


def seed_instrumentos(db: Session) -> None:
    """
    Seeds a representative set of Argentine market instruments.
    Idempotent — skipped if any Instrumento already exists.

    Includes:
      - 3 renta fija (AL30D, GD30, TX26)
      - 4 futuros ROFEX (DLR/MAR26 a DLR/JUN26 — Dólar futuro)
      - 10 acciones BYMA Panel Líder (no detail table, just catalog entry)
    """
    if db.execute(select(Instrumento)).first():
        return

    from datetime import date as _date

    instrumentos_data = [
        # ── Renta Fija ────────────────────────────────────────────────────────
        {
            "inst": Instrumento(
                especie="AL30D", tipo="RENTA_FIJA", moneda="USD",
                mercado_principal="MAE",
                descripcion="BONAR 2030 (dólar linked) — bono soberano argentino",
            ),
            "rf": RentaFijaDetalle(
                tir_referencia=9.78, duration=2.13,
                fecha_vencimiento=_date(2030, 7, 9),
                tasa_cupon=0.75, frecuencia_cupon="SEMESTRAL",
                amortiza=True, moneda_emision="USD", emisor="República Argentina",
            ),
        },
        {
            "inst": Instrumento(
                especie="GD30", tipo="RENTA_FIJA", moneda="USD",
                mercado_principal="MAE",
                descripcion="GLOBAL 2030 — bono soberano bajo ley NY",
            ),
            "rf": RentaFijaDetalle(
                tir_referencia=8.17, duration=2.15,
                fecha_vencimiento=_date(2030, 7, 9),
                tasa_cupon=0.75, frecuencia_cupon="SEMESTRAL",
                amortiza=True, moneda_emision="USD", emisor="República Argentina",
            ),
        },
        {
            "inst": Instrumento(
                especie="TX26", tipo="RENTA_FIJA", moneda="ARP",
                mercado_principal="BYMA",
                descripcion="BONCER 2026 — bono CER ajustado por inflación",
            ),
            "rf": RentaFijaDetalle(
                tir_referencia=0.19, duration=0.37,
                fecha_vencimiento=_date(2026, 11, 9),
                tasa_cupon=2.0, frecuencia_cupon="SEMESTRAL",
                amortiza=False, moneda_emision="ARP", emisor="República Argentina",
            ),
        },
        # ── Futuros ROFEX (DLR — 4 vencimientos activos) ─────────────────────
        # Precios de ajuste al 2026-03-23 · fuente: PPI Cotizaciones/Futuros
        # margen_inicial ≈ 3% del nocional (1 contrato = USD 1.000)
        {
            "inst": Instrumento(
                especie="DLR/MAR26", tipo="FUTURO", moneda="ARP",
                mercado_principal="ROFEX",
                descripcion="Futuro de Dólar — vencimiento marzo 2026",
            ),
            "futuro": FuturoRofexDetalle(
                contrato="DLR/MAR26",
                activo_subyacente="Dólar Estadounidense",
                mes_vencimiento=_date(2026, 3, 31),
                precio_ajuste=1400.0,
                margen_inicial=42000.0,
                margen_variacion=0.0,
                tick_size=0.01,
                multiplicador=1000.0,
            ),
        },
        {
            "inst": Instrumento(
                especie="DLR/ABR26", tipo="FUTURO", moneda="ARP",
                mercado_principal="ROFEX",
                descripcion="Futuro de Dólar — vencimiento abril 2026",
            ),
            "futuro": FuturoRofexDetalle(
                contrato="DLR/ABR26",
                activo_subyacente="Dólar Estadounidense",
                mes_vencimiento=_date(2026, 4, 30),
                precio_ajuste=1429.0,
                margen_inicial=42900.0,
                margen_variacion=0.0,
                tick_size=0.01,
                multiplicador=1000.0,
            ),
        },
        {
            "inst": Instrumento(
                especie="DLR/MAY26", tipo="FUTURO", moneda="ARP",
                mercado_principal="ROFEX",
                descripcion="Futuro de Dólar — vencimiento mayo 2026",
            ),
            "futuro": FuturoRofexDetalle(
                contrato="DLR/MAY26",
                activo_subyacente="Dólar Estadounidense",
                mes_vencimiento=_date(2026, 5, 29),
                precio_ajuste=1459.5,
                margen_inicial=43800.0,
                margen_variacion=0.0,
                tick_size=0.01,
                multiplicador=1000.0,
            ),
        },
        {
            "inst": Instrumento(
                especie="DLR/JUN26", tipo="FUTURO", moneda="ARP",
                mercado_principal="ROFEX",
                descripcion="Futuro de Dólar — vencimiento junio 2026",
            ),
            "futuro": FuturoRofexDetalle(
                contrato="DLR/JUN26",
                activo_subyacente="Dólar Estadounidense",
                mes_vencimiento=_date(2026, 6, 30),
                precio_ajuste=1493.5,
                margen_inicial=44800.0,
                margen_variacion=0.0,
                tick_size=0.01,
                multiplicador=1000.0,
            ),
        },
    ]

    # Acciones (no detail table needed — just catalog entry)
    acciones = [
        ("GGAL", "Grupo Financiero Galicia S.A."),
        ("YPFD", "YPF S.A."),
        ("PAMP", "Pampa Energía S.A."),
        ("BBAR", "Banco BBVA Argentina S.A."),
        ("ALUA", "Aluar Aluminio Argentino S.A."),
        ("TXAR", "Ternium Argentina S.A."),
        ("CEPU", "Central Puerto S.A."),
        ("TECO2", "Telecom Argentina S.A."),
        ("SUPV", "Grupo Supervielle S.A."),
        ("LOMA", "Loma Negra C.I.A.S.A."),
    ]

    for especie, desc in acciones:
        instrumentos_data.append({
            "inst": Instrumento(
                especie=especie, tipo="ACCION", moneda="ARP",
                mercado_principal="BYMA", descripcion=desc,
            ),
        })

    for item in instrumentos_data:
        inst = item["inst"]
        db.add(inst)
        db.flush()
        if "rf" in item:
            item["rf"].instrumento_id = inst.id
            db.add(item["rf"])
        if "futuro" in item:
            item["futuro"].instrumento_id = inst.id
            db.add(item["futuro"])

    db.commit()
    print(f"✅ {len(instrumentos_data)} instrumentos creados (renta fija, futuros, acciones).")


def seed_config_sistema(db: Session) -> None:
    """Creates the single ConfigSistema row (id=1) if it doesn't exist yet."""
    if db.get(ConfigSistema, 1) is None:
        db.add(ConfigSistema(id=1, auto_matching=False, matching_mercado="DEFAULT"))
        db.commit()


def seed_cuentas_operadores(db: Session) -> None:
    """
    Creates a zero-balance ARP account for each active Operador that doesn't
    have one yet. Idempotent — safe to re-run after adding new operadores.
    Must be called AFTER seed_cuentas() so the Account table already exists.
    """
    operadores = db.execute(
        select(Operador).where(Operador.activo == True)
    ).scalars().all()

    creadas = 0
    for op in operadores:
        existing = db.execute(
            select(Account).where(
                Account.owner_type == "operador",
                Account.owner_id == op.id,
            )
        ).scalar_one_or_none()
        if existing:
            continue
        db.add(Account(
            owner_type="operador",
            owner_id=op.id,
            moneda="ARP",
            mercado="DEFAULT",
            balance_cache=Decimal("0"),
            capital_inicial=Decimal("0"),
        ))
        creadas += 1

    if creadas:
        db.commit()
        print(f"✅ {creadas} cuentas de operadores creadas (saldo inicial $0).")


def seed_cartera_propia(db: Session) -> None:
    """
    Marks the 'STD' client as cartera_propia (fund's proprietary book).
    Idempotent — safe to re-run.
    """
    std = db.execute(select(Cliente).where(Cliente.codigo == "STD")).scalar_one_or_none()
    if std and not std.es_cartera_propia:
        std.es_cartera_propia = True
        db.commit()
        print("✅ Cliente 'STD' marcado como cartera propia.")
