# Rueda Portfolio

Sistema de gestión de órdenes y cartera para mercados financieros argentinos (BYMA, ROFEX, MAE).
Stack: **FastAPI + Socket.IO + SQLite + SQLAlchemy + uvicorn**.

---

## Instalación

```bash
pip install -r requirements.txt
```

## Levantar el servidor

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --log-config log_config.json
```

Abrir en el navegador: **http://localhost:8000**

> El flag `--log-config log_config.json` enruta los logs de acceso HTTP a `logs/app.log` (rotación automática a 10 MB, 5 backups) y deja la consola en nivel WARNING únicamente. Sin este flag, uvicorn imprime cada request en la terminal, lo que puede saturar la consola del IDE si el servidor corre por períodos prolongados.

---

## Usuarios demo

Al iniciar el servidor por primera vez se crean automáticamente los siguientes usuarios:

| Usuario | Contraseña | Rol |
|---|---|---|
| `admin` | `Admin2024!` | ADMIN |
| `operador1` | `Operador1_2024!` | OPERADOR |
| `operador2` | `Operador2_2024!` | OPERADOR |

> Las credenciales se leen del archivo `.env` (variables `ADMIN_PASSWORD`, `OPERADOR1_PASSWORD`, `OPERADOR2_PASSWORD`). Los valores de la tabla corresponden al `.env` incluido en el repo.

> **ADMIN**: acceso total, incluye gestión de usuarios, bots, auditoría y operaciones administrativas.
> **OPERADOR**: acceso operativo (órdenes, posiciones, reportes). Sin acceso a configuración de sistema.

---

## Características del sistema

### Gestión de órdenes
- Blotter intradiario con actualización en tiempo real vía WebSocket
- Tipos de orden: `LIMC` (compra límite), `LIMV` (venta límite)
- Precio límite y precio de mercado (`MERCADO`)
- Órdenes condicionales: Stop Loss y Take Profit con precio de activación
- Time-in-force: `DAY`, `IOC`, `FOK`, `GTD`
- Iceberg orders (cantidad visible configurable)
- Modificación de precio y cantidad sobre órdenes abiertas
- Cancelación con liberación automática de reserva de efectivo
- Duplicar orden desde el modal de detalle (pre-rellena el formulario)
- Filtro de fecha (`desde` / `hasta`) en la vista Estado de Órdenes
- Asignación por desk de operadores

### Ejecución y transacciones
- Ejecución parcial y total de órdenes (fills múltiples)
- Cálculo de precio promedio ponderado
- Integración de comisiones por fill
- Confirmación bilateral de fills concertados
- Liquidación por regla configurable (T+0 / T+1 / T+2 según mercado)

### Control de riesgo pre-trade
- Validación de **saldo disponible** antes de crear órdenes de compra (hard-block)
- Límites de riesgo configurables (notional máximo, concentración, DV01, VaR)
- Alertas soft (advertencia) y hard-block (rechazo) por tipo de límite
- VaR paramétrico, DV01 y sensibilidad FX de cartera
- Exposición a contrapartes con límites de crédito

### Cuentas y contabilidad
- Libro mayor append-only: `Account` + `AccountEntry` (débitos / créditos)
- Reserva de efectivo al crear órdenes de compra (`RESERVA_COMPRA`)
- Liberación proporcional de reserva en cada fill (`APLICACION_RESERVA`)
- Liberación de saldo remanente al cancelar (`LIBERACION_RESERVA`)
- Ajustes manuales de crédito / débito (ADMIN)
- Conciliación de posiciones y saldos
- Rendimiento de bots por cuenta

### Posiciones y P&L
- Tracking de posiciones en tiempo real por especie y cliente
- Valorización a precio de mercado (MTM) con P&L no realizado
- Conversión FX a pesos via tipo de cambio CCL
- P&L diario por instrumento con cierre EOD
- Histórico de P&L agregado por fecha

### Catálogo de instrumentos
- Tipos: acciones, renta fija (bonos), futuros ROFEX
- Detalle de renta fija: TIR, duration, precio limpio/sucio, cupón, amortización
- Detalle de futuros: contrato, activo subyacente, fecha de vencimiento, margen inicial, tick size, multiplicador
- Llamados de margen con push WebSocket al crear
- Alerta automática diaria para futuros que vencen en los próximos 5 días

### Mercado y precios
- Watchlist de precios con grupos BYMA Panel Líder y Merval General
- Integración con **Yahoo Finance** (`yfinance`) para cotizaciones
- Feed de precios en background cada 300 segundos con push WebSocket
- Flash visual en celdas de precio al recibir actualizaciones en tiempo real
- Order book sintético con niveles calculados desde precio de mercado + spread porcentual
- Órdenes del sistema propias integradas al book con prioridad

### Tipos de cambio
- Registro de tasas MEP, CCL y tipo de cambio oficial
- Histórico de tipos de cambio
- Utilizado para conversión de posiciones en USD

### Simulador de mercado
- **Market bot** multi-instancia con cuatro perfiles configurables: CONSERVADOR / MODERADO / AGRESIVO / TRADER
- Generación de órdenes con distribuciones gaussiana para precios y cantidades
- Parámetros por perfil: varianza de precio, intervalo entre ticks, offsets compra/venta, fill_rate, burst probability/size, sigma de cantidad, momentum weight
- Comportamiento "humano": cancelación automática de órdenes stale (por drift de precio), ciclos acumulación/distribución, reacción post-fill (contra-orden), órdenes a mercado con probabilidad configurable
- Sizing dinámico por fracción de capital disponible por bot
- Los bots no pasan por validación de saldo (operan en cuentas internas)

### Clientes y contrapartes
- CRUD de clientes con código y razón social
- Actualización en cascada sobre órdenes al modificar cliente
- Gestión de contrapartes con límites de crédito y exposición actual
- Cliente especial "cartera propia" (STD) para posición propia

### Reportes regulatorios
- Reporte CNV/BYMA de fills diarios
- Posición en moneda extranjera para BCRA
- Detección de operaciones inusuales para UIF
- Exportación en Excel y PDF (async streaming)

### Auditoría y seguridad
- Log de auditoría append-only para todas las operaciones CREATE / UPDATE / CANCEL
- Autenticación JWT con **httpOnly cookies** (access + refresh token rotation)
- Rate limiting: 300 req/min por usuario autenticado (fallback a IP)
- CORS restringido a orígenes configurados
- Security headers: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy

### Tiempo real (WebSocket)
- Conexión Socket.IO autenticada via cookie httpOnly
- Eventos emitidos:

| Evento | Descripción |
|---|---|
| `orden_nueva` | Nueva orden creada (manual o por bot) |
| `orden_actualizada` | Cambio de estado, fill parcial/total, cancelación |
| `precio_actualizado` | Actualización de precio de un instrumento individual |
| `precios_actualizados` | Batch de precios tras feed de Yahoo Finance |
| `posicion_actualizada` | Cambio en posición de un cliente (tras fill) |
| `nueva_notificacion` | Notificación push al usuario |
| `alerta_riesgo` | Límite de riesgo violado al crear una orden |
| `alerta_usuario_disparada` | Alerta de precio/condición configurada por el usuario |
| `margin_call` | Llamado de margen por creación de instrumento derivado |
| `vencimiento_proximo` | Futuro que vence en los próximos 5 días |
| `status` | Confirmación de conexión WebSocket exitosa |

### Operadores y desks
- Registro de operadores con asignación a desk
- Órdenes asociadas al desk del operador logueado
- Control de estado activo/inactivo

---

## Atajos de teclado

Disponibles en cualquier vista mientras el foco no esté en un campo de texto.

| Tecla | Acción |
|---|---|
| `N` | Abrir modal Nueva Orden |
| `Esc` | Cerrar el modal activo |
| `1` | Ir a Órdenes |
| `2` | Ir a Blotter |
| `3` | Ir a Posiciones |
| `4` | Ir a Transacciones |
| `5` | Ir a Informes |
| `6` | Ir a Utilitarios |
| `7` | Ir a Mercado |
| `R` | Refrescar la vista actual |
| `↑` / `↓` | Navegar filas de la tabla activa |
| `Enter` | Abrir detalle de la fila seleccionada |
| `Ctrl+K` | Enfocar barra de búsqueda global |
| `H` | Toggle `respetar_horario` en el bot enfocado/hovereado |
| `E` | Editar el bot enfocado/hovereado |
| `Ctrl+Enter` | Confirmar el modal activo (nueva orden, bots, tickers) |

---

## Stack técnico

| Componente | Tecnología |
|---|---|
| Backend | FastAPI |
| Tiempo real | python-socketio (ASGI) |
| Base de datos | SQLite + SQLAlchemy ORM |
| Servidor | uvicorn |
| Frontend | HTML + CSS + JS vanilla |
| Autenticación | JWT (python-jose) + httpOnly cookies |
| Precios | yfinance |
| Rate limiting | slowapi |
| Templates | Jinja2 |

## Estructura del proyecto

```
nuevofpa/
├── app/
│   ├── main.py                  ← ASGI app (FastAPI + Socket.IO)
│   ├── core/                    ← config, seguridad, deps, socketio, pagination, get_or_404
│   ├── db/                      ← base, session, migrations, seed
│   ├── models/                  ← ORM models (25 entidades)
│   ├── routers/                 ← endpoints REST (26 módulos)
│   ├── schemas/                 ← Pydantic schemas
│   ├── services/                ← lógica de negocio
│   └── simulador/               ← bots y background tasks
├── logs/                        ← logs rotativos (generados en runtime)
│   └── .gitkeep
├── static/                      ← CSS, JS
├── templates/                   ← index.html, login.html
├── clean_logs.sh                ← script para vaciar logs sin detener el servidor
├── log_config.json              ← configuración de logging para uvicorn
└── requirements.txt
```

## Logs

Los logs se escriben en `logs/app.log` con rotación automática (10 MB, 5 archivos de backup).

**Limpiar logs sin detener el servidor:**
```bash
bash clean_logs.sh
```

El script vacía `logs/app.log` sin eliminar el archivo (el proceso uvicorn mantiene el file handle abierto) y borra los backups rotados (`app.log.1` … `app.log.5`).

---

## Notas de despliegue

- El objeto ASGI exportado es `app.main:app` (el `ASGIApp` de socketio que envuelve FastAPI).
- La base de datos SQLite se crea y migra automáticamente al iniciar.
- Los datos demo (clientes, instrumentos, bots, reglas de liquidación) se seedean en el primer arranque.
- **SQLite no soporta múltiples workers concurrentes con escritura simultánea.** Para producción con carga alta, migrar a PostgreSQL antes de escalar con `--workers`.
- En producción detrás de HTTPS, cambiar `secure=False` a `secure=True` en `app/routers/auth.py` (o setear la variable de entorno `HTTPS_ONLY=true` si la config lo soporta).
