// CONSTANTS → moved to constants.js
// TOAST SYSTEM → moved to dom-helpers.js

// AUTH / SESSION → moved to api.js

// XSS, DEBOUNCE, ERROR LOGGING, API ERROR MESSAGES → moved to utils.js

// DOM HELPERS (toast, modals, validation, tables, pagination, tabs, etc.) → moved to dom-helpers.js

// ── STATE ──────────────────────────────────────────────────────────────────
const state = {
  // Órdenes
  currentPage: 1,
  totalPages: 1,
  perPage: 20,
  ordenes: [],
  // Transacciones
  txPage: 1,
  txTotalPages: 1,
  txPerPage: 50,
  // App
  currentView: 'ordenes',
  filtrosLoaded: false,
  socket: null,
  connected: false,
  // Navigation — AbortController para cancelar fetches en vuelo al cambiar de vista
  navController: null,
  // Modal
  modalOrdenId: null,
  // Precios
  preciosCache: {},
  // Posiciones — used to colour P&L cells on single-row WS updates
  posMaxAbsPnl: 1,
  // Operador-linked client (populated from /api/auth/me)
  clienteCodigo: null,
  // Full client list (populated from /api/clientes, used in selects)
  clientes: [],
};

// ── NOTIFICATION BADGE ─────────────────────────────────────────────────────
let _notifUnread = 0;

function _updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  if (_notifUnread > 0) {
    badge.textContent = _notifUnread > 99 ? '99+' : String(_notifUnread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

let _notifCloseHandler = null;

function abrirNotifPanel() {
  _notifUnread = 0;
  _updateNotifBadge();
  const dropdown = document.getElementById('notifDropdown');
  if (!dropdown) return;

  // Always remove any previous handler first — prevents accumulation
  if (_notifCloseHandler) {
    document.removeEventListener('click', _notifCloseHandler, true);
    _notifCloseHandler = null;
  }

  const isOpen = dropdown.classList.toggle('open');
  if (isOpen) {
    _notifCloseHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target.id !== 'btnNotifBell') {
        dropdown.classList.remove('open');
        document.removeEventListener('click', _notifCloseHandler, true);
        _notifCloseHandler = null;
      }
    };
    setTimeout(() => document.addEventListener('click', _notifCloseHandler, true), 0);
  }
}

// ── SOCKET.IO ──────────────────────────────────────────────────────────────
function initSocket() {
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.disconnect();
  }
  state.socket = io({ transports: ['websocket', 'polling'] });

  state.socket.on('connect', () => {
    state.connected = true;
    updateStatus(true, 'Conectado — Rueda HUB activo');
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.style.display = 'none';
  });

  state.socket.on('disconnect', () => {
    state.connected = false;
    updateStatus(false, 'Desconectado del servidor');
  });

  let _reconnectFailTimer = null;

  state.socket.on('reconnect_attempt', () => {
    _updateSidebarDots('orange');
    const txt = document.getElementById('status-text');
    if (txt) txt.textContent = 'Reconectando...';
    const banner = document.getElementById('reconnect-banner');
    if (banner) { banner.style.display = 'flex'; banner.querySelector?.('[data-reconnect-msg]')?.removeAttribute('data-reconnect-failed'); }
    const tbDot   = document.getElementById('topbar-ws-dot');
    const tbLabel = document.getElementById('topbar-ws-label');
    if (tbDot)   { tbDot.className = 'topbar-ws-dot dot-orange'; tbDot.title = 'WebSocket: reconectando...'; }
    if (tbLabel) { tbLabel.hidden = false; tbLabel.textContent = 'Reconectando...'; }
    // If still disconnected after 30 s, update banner to show definitive failure
    clearTimeout(_reconnectFailTimer);
    _reconnectFailTimer = setTimeout(() => {
      const b = document.getElementById('reconnect-banner');
      const msg = b?.querySelector('[data-reconnect-msg]') || b;
      if (msg && b?.style.display !== 'none') {
        const span = b.querySelector('span') || b;
        if (span) span.textContent = 'Sin conexión con el servidor. Recargá la página para reconectar.';
      }
    }, RECONNECT_FAIL_MS);
  });

  state.socket.on('reconnect', () => {
    clearTimeout(_reconnectFailTimer);
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.style.display = 'none';
  });

  state.socket.on('orden_actualizada', (orden) => {
    updateOrdenEnTabla(orden);
    actualizarEstadisticas();
    setStatusEvent(`Orden ${orden.nro_orden} actualizada — ${orden.instancia}`);
    if (orden.estado_color === 'green') {
      showToast(`${orden.especie} — ${orden.ejecutado_total}`, 'ok', `Orden ${orden.nro_orden} ejecutada`);
    } else if (orden.estado_color === 'red') {
      showToast(`Orden ${orden.nro_orden}: ${orden.instancia}`, 'error', 'Error en orden');
    }
    if (state.currentView === 'transacciones') cargarTransacciones(false);
    if (state.currentView === 'blotter') cargarBlotter(false);
    if (state.currentView === 'posiciones') cargarProyeccion();
    _refreshObSiAbierto();
  });

  state.socket.on('orden_nueva', () => {
    state.currentPage = 1;
    if (state.currentView === 'ordenes') cargarOrdenes(false);
    if (state.currentView === 'blotter') cargarBlotter(false);
    if (state.currentView === 'posiciones') cargarProyeccion();
    setStatusEvent('Nueva orden recibida');
    showToast('Nueva orden recibida en el sistema', 'ok', 'Nueva Orden');
  });

  state.socket.on('nueva_notificacion', (notif) => {
    prependNotificacion(notif);
  });

  state.socket.on('posicion_actualizada', (posicion) => {
    updatePosicionEnTabla(posicion);
    setStatusEvent(`Posición actualizada — ${posicion.especie} (${posicion.cliente})`);
  });

  state.socket.on('precios_actualizados', (data) => {
    state.preciosCache = {};
    (data.precios || []).forEach(p => { state.preciosCache[p.especie] = p; });
    if (state.currentView === 'posiciones') cargarPosiciones();
    renderPreciosTable(data.precios || []);
    setStatusEvent('Precios de mercado actualizados');
    _refreshObSiAbierto();
  });

  // User-defined alert fired
  state.socket.on('alerta_usuario_disparada', (data) => {
    showToast(esc(data.mensaje), 'warn', `Alerta — ${esc(data.tipo)}`);
    // Refresh the alerts tab if it's currently open
    if (state.currentView === 'admin') {
      const tab = document.querySelector('.admin-sidebar .admin-nav-item.active');
      if (tab && tab.dataset.tab === 'alertas-usuario') cargarAlertas();
    }
  });

  // Single-price update from matching engine or bot simulator
  state.socket.on('precio_actualizado', (p) => {
    state.preciosCache[p.especie] = p;
    // Patch just the row for this especie in the price table
    const tbody = document.getElementById('preciosBody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr[data-especie]');
    rows.forEach(row => {
      if (row.dataset.especie === p.especie) {
        const volCell  = row.querySelector('.vol-dia-cell');
        const vwapCell = row.querySelector('.vwap-cell');
        if (volCell)  { volCell.textContent  = (p.volumen_dia || 0).toLocaleString('es-AR'); _flashCell(volCell); }
        if (vwapCell) { vwapCell.textContent = p.vwap ? fmt(p.vwap) : '—'; _flashCell(vwapCell); }
      }
    });
  });
}

function updateStatus(connected, text) {
  const dot = document.getElementById('status-conn');
  const txt = document.getElementById('status-text');
  if (dot) {
    dot.className = 'status-dot ' + (connected ? 'dot-green' : 'dot-red');
    dot.setAttribute('aria-label', `Estado de conexión: ${text}`);
    dot.title = text;
  }
  if (txt) txt.textContent = text;
  _updateSidebarDots(connected ? 'green' : 'red');

  // Topbar WS dot — visible from all views
  const tbDot   = document.getElementById('topbar-ws-dot');
  const tbLabel = document.getElementById('topbar-ws-label');
  if (tbDot) {
    tbDot.className = `topbar-ws-dot dot-${connected ? 'green' : 'red'}`;
    tbDot.title     = `WebSocket: ${text}`;
  }
  // Show label only when disconnected so it doesn't clutter the topbar normally
  if (tbLabel) {
    if (connected) {
      tbLabel.hidden = true;
      tbLabel.textContent = '';
    } else {
      tbLabel.hidden = false;
      tbLabel.textContent = 'Sin conexión';
    }
  }
}

function _updateSidebarDots(color) {
  const labels = { 'dot-ruedahub': 'Rueda HUB', 'dot-rofex': 'ROFEX', 'dot-maeonl': 'MAEONL' };
  const statusText = color === 'green' ? 'Conectado' : color === 'orange' ? 'Reconectando' : 'Desconectado';
  ['dot-ruedahub', 'dot-rofex', 'dot-maeonl'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.className = `dot dot-${color}`;
      const label = `${labels[id]}: ${statusText}`;
      el.title = label;
      el.setAttribute('aria-label', label);
    }
  });
}

function setStatusEvent(msg) {
  const el = document.getElementById('status-event');
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, STATUS_EVENT_DURATION_MS);
}

// ── NAVEGACIÓN ─────────────────────────────────────────────────────────────
const VIEW_LABELS = {
  home:         'Dashboard',
  ordenes:      'Órdenes',
  blotter:      'Blotter',
  posiciones:   'Posiciones',
  transacciones:'Transacciones',
  informes:     'Informes',
  utilitarios:  'Utilitarios',
  mercado:      'Mercado',
  seguidos:     'Seguidos',
  admin:        'Admin',
};

function setView(viewName, { pushHistory = true } = {}) {
  // Cancel any in-flight API requests from the previous view
  state.navController?.abort();
  state.navController = new AbortController();

  document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-view]').forEach(n => n.classList.remove('active'));

  document.getElementById(`view-${viewName}`).classList.add('active');
  document.querySelector(`[data-view="${viewName}"]`).classList.add('active');

  state.currentView = viewName;
  localStorage.setItem('rueda-view', viewName);

  // Keep URL hash in sync — pushState so back/forward works
  if (pushHistory && location.hash.slice(1) !== viewName) {
    history.pushState({ view: viewName }, '', `#${viewName}`);
  }

  // Update search placeholder dynamically
  const searchEl = document.getElementById('globalSearch');
  if (searchEl) {
    const label = VIEW_LABELS[viewName] || viewName;
    searchEl.placeholder = `Buscar en ${label}... (Ctrl+K)`;
  }

  if (viewName === 'home')          cargarDashboard();
  if (viewName === 'blotter')       cargarBlotter();
  if (viewName === 'posiciones')    { cargarPosiciones(); cargarProyeccion(); cargarMetricasRiesgo(); }
  if (viewName === 'transacciones') cargarTransacciones();
  if (viewName === 'informes')      cargarInformes();
  if (viewName === 'utilitarios')   cargarUtilitarios();
  if (viewName === 'mercado')       cargarMercado();
  if (viewName === 'seguidos')      cargarSeguidos();
}

// Restore view on browser back/forward
window.addEventListener('popstate', () => {
  const v = location.hash.slice(1);
  if (v && VIEW_LABELS[v]) setView(v, { pushHistory: false });
});

// ── FILTER PERSISTENCE (localStorage) ──────────────────────────────────────
/**
 * IDs of all filter inputs/selects that should be saved across page loads.
 * For <select> elements whose options are loaded asynchronously (e.g. especies,
 * clientes), the restore is deferred until cargarFiltros() populates them.
 */
const _FILTER_IDS = [
  // Órdenes
  'filtroEspecie', 'filtroCliente', 'filtroEstado',
  // Blotter
  'blotterFecha', 'blotterEspecieFiltro', 'blotterDesk', 'blotterEstado',
  // Posiciones
  'posFiltroMercado',
  // Transacciones
  'txFiltroMercado',
];

/** Attach change listeners so filter values are saved as they change. */
function initFilterPersistence() {
  _FILTER_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => _saveFilter(id, el.value));
    el.addEventListener('input',  () => _saveFilter(id, el.value));
  });
}

function _saveFilter(id, value) {
  localStorage.setItem(`rueda-filter-${id}`, value);
}

/** Restore filter values whose options are already populated (inputs + static selects). */
function _restoreStaticFilters() {
  ['filtroEstado', 'filtroFechaDesde', 'filtroFechaHasta',
   'blotterFecha', 'blotterEspecieFiltro', 'blotterDesk', 'blotterEstado',
   'posFiltroMercado', 'txFiltroMercado'].forEach(id => {
    const el = document.getElementById(id);
    const v  = localStorage.getItem(`rueda-filter-${id}`);
    if (el && v !== null) el.value = v;
  });
}

/** Restore filter values for dynamic selects (called after cargarFiltros populates options). */
function _restoreDynamicFilters() {
  ['filtroEspecie', 'filtroCliente', 'posFiltroEspecie', 'posFiltroCliente',
   'txFiltroEspecie', 'txFiltroCliente'].forEach(id => {
    const el = document.getElementById(id);
    const v  = localStorage.getItem(`rueda-filter-${id}`);
    if (el && v !== null && el.querySelector(`option[value="${CSS.escape(v)}"]`)) {
      el.value = v;
    }
  });
  // Persist dynamic-select changes too
  ['filtroEspecie', 'filtroCliente', 'posFiltroEspecie', 'posFiltroCliente',
   'txFiltroEspecie', 'txFiltroCliente'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!el._filterPersistBound) {
      el.addEventListener('change', () => _saveFilter(id, el.value));
      el._filterPersistBound = true;
    }
  });
}

function initNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => setView(item.dataset.view));
  });
}

/**
 * Initialize event listeners for the Seguidos (watchlist) section.
 */
function initSeguidos() {
  const inputModal = document.getElementById('seguirInputModal');
  if (inputModal) {
    let _segTimer = null;
    inputModal.addEventListener('input', () => {
      clearTimeout(_segTimer);
      const esp = inputModal.value.trim().toUpperCase();
      if (esp.length >= 2) {
        _segTimer = setTimeout(() => _cargarPreviewSeguido(esp), 400);
      } else {
        _resetPreviewSeguido();
      }
    });
    inputModal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmarAgregarSeguido(); }
      if (e.key === 'Escape') { e.preventDefault(); cerrarModalSeguido(); }
    });
  }
}

/**
 * Wires filter elements to their reload functions via JS event listeners.
 * This replaces onchange=/oninput= inline handlers for all filter controls.
 */
function initFilterReloads() {
  const bind = (id, eventType, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(eventType, fn);
  };
  // Órdenes
  bind('filtroCliente',    'change', () => cargarOrdenes());
  bind('filtroEspecie',    'change', () => cargarOrdenes());
  bind('filtroEstado',     'change', () => cargarOrdenes());
  bind('filtroFechaDesde', 'change', () => cargarOrdenes());
  bind('filtroFechaHasta', 'change', () => cargarOrdenes());
  // Blotter
  bind('blotterFecha',        'change', () => cargarBlotter());
  bind('blotterOperador',     'change', () => filtrarBlotter());
  bind('blotterEspecieFiltro','input',  () => _filtrarBlotterDebounced?.());
  bind('blotterDesk',         'change', () => filtrarBlotter());
  bind('blotterEstado',       'change', () => filtrarBlotter());
  // Posiciones
  bind('posFiltroCliente', 'change', () => cargarPosiciones());
  bind('posFiltroEspecie', 'change', () => cargarPosiciones());
  bind('posFiltroMercado', 'change', () => cargarPosiciones());
  // Proyección
  bind('cajaProjCliente', 'change', () => cargarProyeccion());
  bind('cajaProjMoneda',  'change', () => cargarProyeccion());
  // Riesgo cartera
  bind('riesgoCartCliente', 'change', () => cargarMetricasRiesgo?.());
  // Transacciones
  bind('txFiltroCliente', 'change', () => cargarTransacciones());
  bind('txFiltroEspecie', 'change', () => cargarTransacciones());
  bind('txFiltroMercado', 'change', () => cargarTransacciones());
  // Admin — tickers
  bind('tickerPanelFiltro', 'change', () => cargarTickersAdmin?.());
  // Admin — instrumentos
  bind('instTipoFiltro',  'change', () => cargarInstrumentos?.());
  bind('instSoloActivos', 'change', () => cargarInstrumentos?.());
  // Admin — firma
  bind('firmaMoneda', 'change', () => cargarFirma?.());
  // Admin — cfg sesgo (inline display update handled by JS too)
  const sesgoRange = document.getElementById('cfg-sesgo-macro');
  if (sesgoRange) {
    sesgoRange.addEventListener('input', () => {
      const val = document.getElementById('cfg-sesgo-valor');
      if (val) val.textContent = sesgoRange.value > 0 ? `+${sesgoRange.value}%` : `${sesgoRange.value}%`;
    });
    sesgoRange.addEventListener('change', () => guardarSesgoMacro?.(sesgoRange.value / 100));
  }
  // Admin — bot fill-rate display
  const fillRate = document.getElementById('b-fill-rate');
  if (fillRate) {
    fillRate.addEventListener('input', () => {
      const v = document.getElementById('b-fill-rate-val');
      if (v) v.textContent = `${(+fillRate.value * 100).toFixed(0)}%`;
    });
  }
  const probMercado = document.getElementById('b-prob-mercado');
  if (probMercado) {
    probMercado.addEventListener('input', () => {
      const v = document.getElementById('b-prob-mercado-val');
      if (v) v.textContent = probMercado.value === '' ? 'perfil' : `${(+probMercado.value * 100).toFixed(0)}%`;
    });
  }
  // Admin — sistema
  bind('cfg-auto-matching', 'change', (e) => toggleAutoMatching?.(e.target.checked));
  bind('switch-horario-global', 'change', (e) => setBulkHorario?.(e.target.checked));
  // Admin — inst tipo (subtabs)
  bind('inst-tipo', 'change', () => instActualizarSubtabs?.());
  // Admin — bot perfil
  bind('b-perfil', 'change', () => aplicarPerfilDefaults?.());
  // Gráfico — intervalo
  bind('chartIntervalo', 'change', (e) => cambiarIntervalo?.(e.target.value));
  // Nueva orden — precio / TIF / activación toggles
  bind('f-tipo-precio',    'change', () => togglePrecioLimite?.());
  bind('f-tif',            'change', () => toggleFechaExp?.());
  bind('f-tipo-activacion','change', () => togglePrecioActivacion?.());
  // Reset confirm input (id: resetConfirmInput)
  const resetInput = document.getElementById('resetConfirmInput');
  if (resetInput) {
    resetInput.addEventListener('input', () => {
      const btn = document.getElementById('btnEjecutarReset');
      if (btn) btn.disabled = resetInput.value.trim().toUpperCase() !== 'RESET';
    });
  }
}

// ── EMPTY STATE HELPER ────────────────────────────────────────────────────
/**
 * Generates a <tr> for an empty table with info about active filters.
 * @param {Array<[string,string]>} filterDefs - pairs of [label, elementId]
 * @param {string} clearFn - name of global function to call to clear filters
 * @param {number} colspan
 */
function _emptyStateHtml(filterDefs, clearFn, colspan = 12) {
  const active = filterDefs
    .map(([label, id]) => {
      const el = document.getElementById(id);
      return el && el.value ? `${label}: <strong>${esc(el.value)}</strong>` : null;
    })
    .filter(Boolean);

  const msg = active.length
    ? `No hay resultados para ${active.join(', ')}.`
    : 'Sin resultados.';

  const btn = active.length
    ? `<button class="btn-secondary" style="margin-left:10px;font-size:11px;padding:2px 8px"
         data-action="clear-filters" data-fn="${esc(clearFn)}">Limpiar filtros</button>`
    : '';

  return `<tr class="loading-row"><td colspan="${colspan}" style="text-align:center;color:var(--text3)">
    <div style="padding:6px 0">${msg}${btn}</div>
  </td></tr>`;
}

/** Clear helpers — reset filter elements then reload */
function _limpiarFiltrosOrdenes() {
  ['filtroEspecie','filtroCliente','filtroEstado','filtroFechaDesde','filtroFechaHasta'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; _saveFilter(id, ''); }
  });
  showToast('Filtros de órdenes limpiados.', 'ok', 'Filtros');
  cargarOrdenes();
}
function _limpiarFiltrosBlotter() {
  ['blotterFecha','blotterEspecieFiltro','blotterDesk','blotterEstado'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; _saveFilter(id, ''); }
  });
  showToast('Filtros de blotter limpiados.', 'ok', 'Filtros');
  cargarBlotter();
}
function _limpiarFiltrosPosiciones() {
  ['posFiltroCliente','posFiltroEspecie','posFiltroMercado'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; _saveFilter(id, ''); }
  });
  showToast('Filtros de posiciones limpiados.', 'ok', 'Filtros');
  cargarPosiciones();
}
function _limpiarFiltrosTx() {
  ['txFiltroCliente','txFiltroEspecie','txFiltroMercado'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; _saveFilter(id, ''); }
  });
  showToast('Filtros de transacciones limpiados.', 'ok', 'Filtros');
  cargarTransacciones();
}

// FORMATO, BADGE, SKELETON → moved to utils.js / dom-helpers.js

// ISO DATE HELPERS → moved to utils.js
// ── SPARKLINE SVG ───────────────────────────────────────────────────────────

function _drawSparkline(containerId, values) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!values || values.length < 2) {
    container.innerHTML = '<div style="height:34px;display:flex;align-items:center;color:var(--text3);font-size:9px">sin hist.</div>';
    return;
  }
  const W = container.offsetWidth || 130;
  const H = 34;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const last = values[values.length - 1];
  const color = last >= 0 ? 'var(--green)' : 'var(--red)';

  const pts = values.map((v, i) => {
    const x = ((i / (values.length - 1)) * (W - 4) + 2).toFixed(1);
    const y = (H - 4 - ((v - min) / range) * (H - 10)).toFixed(1);
    return `${x},${y}`;
  }).join(' ');

  const lx = ((W - 4) + 2).toFixed(1);
  const ly = (H - 4 - ((last - min) / range) * (H - 10)).toFixed(1);
  const zy = (H - 4 - ((0 - min) / range) * (H - 10)).toFixed(1);
  const zeroLine = (min < 0 && max > 0)
    ? `<line x1="2" y1="${zy}" x2="${W - 2}" y2="${zy}" stroke="var(--text3)" stroke-width="0.5" stroke-dasharray="2,2"/>`
    : '';

  container.innerHTML =
    `<svg width="${W}" height="${H}" style="display:block;overflow:visible">
      ${zeroLine}
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${lx}" cy="${ly}" r="2.5" fill="${color}"/>
    </svg>`;
}

// ── FILTROS COMPARTIDOS ────────────────────────────────────────────────────
async function cargarFiltros() {
  try {
    const res = await apiFetch('/api/filtros');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Poblar selectores de Órdenes
    const selEspecie = document.getElementById('filtroEspecie');
    const selCliente = document.getElementById('filtroCliente');
    data.especies.forEach(e => selEspecie.appendChild(new Option(e, e)));
    data.clientes.forEach(c => selCliente.appendChild(new Option(c, c)));

    // Poblar selectores de Posiciones
    const posCliSelect = document.getElementById('posFiltroCliente');
    const posEspSelect = document.getElementById('posFiltroEspecie');
    data.clientes.forEach(c => posCliSelect.appendChild(new Option(c, c)));
    data.especies.forEach(e => posEspSelect.appendChild(new Option(e, e)));

    // Poblar selectores de Transacciones
    const txCliSelect = document.getElementById('txFiltroCliente');
    const txEspSelect = document.getElementById('txFiltroEspecie');
    data.clientes.forEach(c => txCliSelect.appendChild(new Option(c, c)));
    data.especies.forEach(e => txEspSelect.appendChild(new Option(e, e)));

    // Poblar selectores de Blotter
    const blotterOpEl = document.getElementById('blotterOperador');
    if (blotterOpEl) {
      // Operators are populated from blotter data (dynamic), nothing to preload here
    }

    // Poblar selectores de Caja Proyección y Riesgo Cartera
    const cajaCliEl = document.getElementById('cajaProjCliente');
    const riesgoCliEl = document.getElementById('riesgoCartCliente');
    if (cajaCliEl) {
      cajaCliEl.innerHTML = '';
      data.clientes.forEach(c => cajaCliEl.appendChild(new Option(c, c)));
    }
    if (riesgoCliEl) {
      riesgoCliEl.innerHTML = '';
      data.clientes.forEach(c => riesgoCliEl.appendChild(new Option(c, c)));
    }

    state.filtrosLoaded = true;
  } catch (e) {
    showToast('Error cargando filtros de órdenes.', 'error');
  }
}

// VISTA: ESTADO DE ÓRDENES → moved to views/ordenes.js

// NOTIFICACIONES -> moved to views/notificaciones.js

// DETALLE ORDEN, NUEVA ORDEN, ORDER BOOK → moved to views/ordenes.js

// ── TABLE SORT ─────────────────────────────────────────────────────────────
/**
 * Client-side column sort for any .orders-table.
 * Click a <th> to sort ASC; click again to sort DESC.
 * Sort state survives re-renders: call _reapplySort(table) after innerHTML
 * rewrites so the active column order is restored automatically.
 *
 * Supports: Argentine-locale numbers (1.234,56), DD/MM/YYYY dates, plain text.
 */
const _sortState = {};   // { autoId → { col, dir } }
let   _sortIdSeq = 0;

function _tableAutoId(table) {
  if (!table._sortId) table._sortId = 'st' + (++_sortIdSeq);
  return table._sortId;
}

function tableSort(th) {
  const table   = th.closest('table');
  const headers = Array.from(th.closest('tr').cells);
  const col     = headers.indexOf(th);
  const id      = _tableAutoId(table);
  const prev    = _sortState[id] || { col: -1, dir: 1 };
  const dir     = prev.col === col ? -prev.dir : 1;
  _sortState[id] = { col, dir };

  headers.forEach(h => {
    const ind = h.querySelector('.sort-ind');
    if (ind) { ind.textContent = ''; h.removeAttribute('data-sort-active'); }
    h.setAttribute('aria-sort', 'none');
  });
  const ind = th.querySelector('.sort-ind');
  if (ind) ind.textContent = dir > 0 ? ' ▲' : ' ▼';
  th.setAttribute('data-sort-active', dir > 0 ? 'asc' : 'desc');
  th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending');

  _applySortDOM(table, col, dir);
}

function _parseSortVal(text) {
  // Argentine number: strip thousand-sep dots, replace decimal comma
  const n = parseFloat(text.replace(/\./g, '').replace(',', '.'));
  if (!isNaN(n)) return { type: 'num', val: n };
  // Date DD/MM/YYYY
  const dm = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dm) return { type: 'num', val: new Date(+dm[3], +dm[2] - 1, +dm[1]).getTime() };
  return { type: 'str', val: text };
}

function _applySortDOM(table, col, dir) {
  const tbody = table.querySelector('tbody');
  const rows  = Array.from(tbody.rows).filter(
    r => !r.classList.contains('loading-row') && r.cells.length > 1
  );
  rows.sort((a, b) => {
    const at = (a.cells[col]?.textContent || '').trim();
    const bt = (b.cells[col]?.textContent || '').trim();
    const av = _parseSortVal(at);
    const bv = _parseSortVal(bt);
    if (av.type === 'num' && bv.type === 'num') return (av.val - bv.val) * dir;
    return av.val.localeCompare(bv.val, 'es', { sensitivity: 'base' }) * dir;
  });
  rows.forEach(r => tbody.appendChild(r));
}

/** Re-apply active sort after a tbody re-render — restores header indicator too. */
function _reapplySort(table) {
  if (!table || !table._sortId) return;
  const s = _sortState[table._sortId];
  if (!s) return;
  // Restore visual indicator on the active header
  const headerRow = table.querySelector('thead tr');
  if (headerRow) {
    Array.from(headerRow.cells).forEach((h, i) => {
      const ind = h.querySelector('.sort-ind');
      if (i === s.col) {
        if (ind) ind.textContent = s.dir > 0 ? ' ▲' : ' ▼';
        h.setAttribute('data-sort-active', s.dir > 0 ? 'asc' : 'desc');
        h.setAttribute('aria-sort', s.dir > 0 ? 'ascending' : 'descending');
      } else {
        if (ind) ind.textContent = '';
        h.removeAttribute('data-sort-active');
        h.setAttribute('aria-sort', 'none');
      }
    });
  }
  _applySortDOM(table, s.col, s.dir);
}

/** Instrument all static table headers once on init. */
function initTableSort() {
  document.querySelectorAll('.orders-table thead th').forEach(th => {
    if (th.classList.contains('no-sort')) return;
    th.style.cursor = 'pointer';
    th.title = 'Clic para ordenar';
    th.setAttribute('tabindex', '0');
    th.setAttribute('role', 'columnheader');
    th.setAttribute('aria-sort', 'none');
    if (!th.querySelector('.sort-ind')) {
      const ind = document.createElement('span');
      ind.className = 'sort-ind';
      th.appendChild(ind);
    }
    th.addEventListener('click', () => tableSort(th));
    th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tableSort(th); } });
  });
}

// ── BÚSQUEDA GLOBAL ────────────────────────────────────────────────────────
// Maps each view to the tbody it should search
const _SEARCH_TBODY = {
  ordenes:       'ordersBody',
  blotter:       'blotterBody',
  transacciones: 'txBody',
  posiciones:    'posicionesBody',
  precios:       'preciosBody',
};

let _searchTimer = null;
document.getElementById('globalSearch').addEventListener('input', function() {
  clearTimeout(_searchTimer);
  const q = this.value.toLowerCase();
  _searchTimer = setTimeout(() => {
    const tbodyId = _SEARCH_TBODY[state.currentView];
    if (!tbodyId) return;
    document.querySelectorAll(`#${tbodyId} tr[data-id], #${tbodyId} tr[data-especie]`).forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }, SEARCH_DEBOUNCE_MS);
});

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────────────────────
// Views in order for 1–7 keys
const _VIEW_KEYS = ['ordenes','blotter','posiciones','transacciones','informes','utilitarios','mercado','seguidos'];

// Map each view to the tbody id of its primary navigable table
const _VIEW_TBODY = {
  ordenes:      'ordersBody',
  blotter:      'blotterBody',
  posiciones:   'posicionesBody',
  transacciones:'transaccionesBody',
  seguidos:     'tbl-seguidos-body',
};

// Map admin sub-tab names to their navigable tbody ids
const _ADMIN_TAB_TBODY = {
  bot: 'botsBody',
};

// Map each view to its refresh function
const _VIEW_REFRESH = {
  home:         () => cargarDashboard(),
  ordenes:      () => cargarOrdenes(false),
  blotter:      () => cargarBlotter(),
  posiciones:   () => { cargarPosiciones(); cargarProyeccion(); cargarMetricasRiesgo(); },
  transacciones:() => cargarTransacciones(),
  informes:     () => cargarInformes(),
  utilitarios:  () => cargarUtilitarios(),
  mercado:      () => cargarMercado(),
  seguidos:     () => cargarSeguidos(),
};

let _kbFocusedRow = null;   // currently highlighted row for arrow-key nav

function _kbMoveFocus(dir) {
  let tbodyId = _VIEW_TBODY[state.currentView];
  if (!tbodyId && state.currentView === 'admin') {
    const activeSubTab = document.querySelector('.admin-sidebar .admin-nav-item.active')?.dataset.tab;
    tbodyId = _ADMIN_TAB_TBODY[activeSubTab] || null;
  }
  if (!tbodyId) return;
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr[data-id]'));
  if (!rows.length) return;

  if (_kbFocusedRow && !tbody.contains(_kbFocusedRow)) _kbFocusedRow = null;

  let idx = _kbFocusedRow ? rows.indexOf(_kbFocusedRow) : -1;
  idx = Math.max(0, Math.min(rows.length - 1, idx + dir));

  if (_kbFocusedRow) _kbFocusedRow.classList.remove('kb-row-focus');
  _kbFocusedRow = rows[idx];
  _kbFocusedRow.classList.add('kb-row-focus');
  _kbFocusedRow.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', function(e) {
  // Never intercept when user is typing
  const tag = document.activeElement?.tagName;
  const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || document.activeElement?.isContentEditable;

  // Ctrl+Enter — save active modal (bot / ticker / nueva orden)
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (document.getElementById('modalNuevaOrden')?.classList.contains('active')) {
      e.preventDefault(); enviarNuevaOrden(); return;
    }
    if (document.getElementById('modalBot')?.classList.contains('active')) {
      e.preventDefault(); guardarBot(); return;
    }
    if (document.getElementById('modalTicker')?.classList.contains('active')) {
      e.preventDefault(); guardarTicker(); return;
    }
  }

  // Ctrl+K — focus search (always)
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const el = document.getElementById('globalSearch');
    if (el) { el.focus(); el.select(); }
    return;
  }

  if (isEditing) return;

  // Esc — close topmost active modal
  if (e.key === 'Escape') {
    const modals = document.querySelectorAll(
      '#modalDetalle.active, #modalNuevaOrden.active, #modalUsuario.active, ' +
      '#modalCliente.active, #modalTicker.active, #modalBot.active, ' +
      '#modalCuentaBot.active, #modalPosicionesBot.active, #modalOperador.active, #modalGrafico.active'
    );
    if (modals.length) {
      modals[modals.length - 1].classList.remove('active');
      e.preventDefault();
    }
    return;
  }

  // 1–7 — switch views
  if (e.key >= '1' && e.key <= '7' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const v = _VIEW_KEYS[parseInt(e.key) - 1];
    if (v) { e.preventDefault(); setView(v); }
    return;
  }

  // H — toggle respetar_horario on focused/hovered bot row
  if (e.key === 'h' || e.key === 'H') {
    const botId = _kbFocusedRow?.dataset?.id || _hoveredBotId;
    if (botId && _botDataMap[botId]) {
      e.preventDefault();
      toggleBotHorario(botId);
      return;
    }
  }

  // E — edit focused/hovered bot row
  if (e.key === 'e' || e.key === 'E') {
    const botId = _kbFocusedRow?.dataset?.id || _hoveredBotId;
    if (botId && _botDataMap[botId]) {
      e.preventDefault();
      abrirModalBot(_botDataMap[botId]);
      return;
    }
  }

  // N — nueva orden
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    abrirModalOrden();
    return;
  }

  // R — refresh current view
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    const fn = _VIEW_REFRESH[state.currentView];
    if (fn) fn();
    return;
  }

  // ↑↓ — navigate rows
  if (e.key === 'ArrowUp')   { e.preventDefault(); _kbMoveFocus(-1); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); _kbMoveFocus(1);  return; }

  // Enter — open detail of focused row
  if (e.key === 'Enter' && _kbFocusedRow && document.body.contains(_kbFocusedRow)) {
    e.preventDefault();
    _kbFocusedRow.click();
    return;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: POSICIONES
// ══════════════════════════════════════════════════════════════════════════════

async function cargarPosiciones() {
  document.getElementById('posicionesBody').innerHTML =
    `<tr class="loading-row"><td colspan="10"><div class="spinner"></div> Cargando...</td></tr>`;

  const cliente = document.getElementById('posFiltroCliente').value;
  const especie = document.getElementById('posFiltroEspecie').value;
  const mercado = document.getElementById('posFiltroMercado').value;

  const params = new URLSearchParams({ cliente, especie, mercado });

  try {
    const res = await apiFetch(`/api/positions?${params}`);
    const data = await res.json();
    renderPosiciones(data.posiciones);
    renderHeatmap(data.posiciones);
    document.getElementById('posicionesInfo').textContent =
      `${data.posiciones.length} posición${data.posiciones.length !== 1 ? 'es' : ''}`;
  } catch (e) {
    document.getElementById('posicionesBody').innerHTML =
      `<tr><td colspan="10">Error al cargar posiciones.</td></tr>`;
  }
  // Also refresh prices table
  cargarPrecios();
}

/** Inline SVG sparkline. values = array of prices, oldest first. */
function _sparklineSVG(values, w = 60, h = 20) {
  if (!values || values.length < 2) return '<span style="color:var(--text3);font-size:10px">—</span>';
  const pts = values.slice(-20); // cap at 20 points
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const step  = w / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (h - ((v - min) / range) * h).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
  const trend = pts[pts.length - 1] >= pts[0];
  const color = trend ? 'var(--green)' : 'var(--red)';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible">
    <polyline points="${coords}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

async function cargarPrecios() {
  try {
    const [preciosRes, histRes] = (await Promise.allSettled([
      apiFetch('/api/prices'),
      apiFetch('/api/prices/historico?precio_tipo=CIERRE'),
    ])).map(r => r.status === 'fulfilled' ? r.value : null);

    const hMap = {};
    if (preciosRes?.ok) {
      const data = await preciosRes.json();
      data.precios.forEach(p => { state.preciosCache[p.especie] = p; });

      // Group historico by especie, oldest-first (API returns DESC so reverse)
      if (histRes?.ok) {
        const hData = await histRes.json();
        (hData.precios || []).forEach(h => {
          if (!hMap[h.especie]) hMap[h.especie] = [];
          hMap[h.especie].unshift(h.precio);
        });
      }
      renderPreciosTable(data.precios, hMap);
    }
  } catch (e) {
    showToast('Error al cargar precios de mercado.', 'error');
    const tbody = document.getElementById('preciosBody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-muted" style="color:var(--red)">Error al cargar precios. Revisá la conexión.</td></tr>`;
  }
}

function renderPreciosTable(precios, hMap = {}) {
  const tbody = document.getElementById('preciosBody');
  if (!precios.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted" style="text-align:center;padding:12px">Sin precios cargados. Presioná <strong>Actualizar</strong> para traer datos del mercado, o ingresá un precio manual.</td></tr>`;
    return;
  }
  tbody.innerHTML = precios.map(p => {
    const varClass = p.variacion_pct > 0 ? 'neta-pos' : p.variacion_pct < 0 ? 'neta-neg' : '';
    const varStr   = p.variacion_pct != null
      ? `<span class="${varClass}">${p.variacion_pct > 0 ? '+' : ''}${p.variacion_pct.toFixed(2)}%</span>`
      : '—';
    const fuenteBadge = p.fuente === 'yfinance'
      ? `<span style="color:var(--accent)">yfinance</span>`
      : `<span style="color:var(--text3)">manual</span>`;
    const volStr  = (p.volumen_dia || 0) > 0 ? (p.volumen_dia).toLocaleString('es-AR') : '<span style="color:var(--text3)">—</span>';
    const vwapStr = p.vwap ? fmt(p.vwap) : '<span style="color:var(--text3)">—</span>';
    return `
      <tr data-especie="${esc(p.especie)}">
        <td>${_badgeEspecie(p.especie)}</td>
        <td class="precio-cell">${fmt(p.precio)}</td>
        <td class="precio-cell">${varStr}</td>
        <td class="vol-dia-cell" style="text-align:right;font-size:11px;font-family:'IBM Plex Mono',monospace">${volStr}</td>
        <td class="vwap-cell" style="text-align:right;font-size:11px;font-family:'IBM Plex Mono',monospace">${vwapStr}</td>
        <td>${fuenteBadge}</td>
        <td style="color:var(--text3)">${esc(p.last_updated) || '—'}</td>
        <td style="padding:2px 6px">${_sparklineSVG(hMap[p.especie])}</td>
      </tr>
    `;
  }).join('');
  _reapplySort(tbody.closest('table'));
}

async function refrescarPrecios() {
  const btn = document.querySelector('[data-action="refrescar-precios"]');
  await _withButtonLoading(btn, async () => {
    try {
      const res = await apiFetch('/api/prices/refresh', { method: 'POST' });
      const data = await res.json();
      setStatusEvent(`Precios actualizados: ${data.actualizadas.join(', ') || 'ninguno mapeado aún'}`);
      cargarPosiciones();
    } catch (e) {
      setStatusEvent('Error al actualizar precios');
      showToast('Error al actualizar precios. Revisá la conexión.', 'error');
    }
  }, '<span class="spinner-inline"></span> Actualizando...');
}

async function ingresarPrecioManual() {
  const especie = document.getElementById('pm-especie').value.toUpperCase().trim();
  const precio  = parseFloat(document.getElementById('pm-precio').value);
  const resultEl = document.getElementById('pmResult');
  resultEl.className = 'execute-result';
  resultEl.textContent = '';

  if (!especie || !precio || precio <= 0) {
    resultEl.className = 'execute-result err';
    resultEl.textContent = 'Completá especie y precio válido.';
    return;
  }

  const res = await _apiFetchJson('/api/prices/manual', 'POST', { especie, precio });
  const data = await res.json();
  if (res.ok) {
    resultEl.className = 'execute-result ok';
    resultEl.textContent = `✓ Precio ${especie}: ${fmt(data.precio.precio)} guardado.`;
    showToast(`${especie}: $${fmt(data.precio.precio)} guardado.`, 'ok', 'Precio manual');
    document.getElementById('pm-especie').value = '';
    document.getElementById('pm-precio').value = '';
    cargarPosiciones();
  } else {
    resultEl.className = 'execute-result err';
    resultEl.textContent = `✗ ${data.detail}`;
    showToast(data.detail || 'Error al guardar precio.', 'error');
  }
}

function _posicionRow(p, maxAbsPnl = state.posMaxAbsPnl) {
  const netaClass = p.cantidad_neta > 0 ? 'neta-pos' : p.cantidad_neta < 0 ? 'neta-neg' : 'neta-zero';
  const pnlClass  = p.pnl_no_realizado > 0 ? 'neta-pos' : p.pnl_no_realizado < 0 ? 'neta-neg' : 'neta-zero';
  const varClass  = p.variacion_pct > 0 ? 'neta-pos' : p.variacion_pct < 0 ? 'neta-neg' : '';

  const precioCell = p.precio_mercado != null ? fmt(p.precio_mercado) : `<span style="color:var(--text3)">sin precio</span>`;
  const varCell    = p.variacion_pct  != null ? `<span class="${varClass}">${p.variacion_pct > 0 ? '+' : ''}${p.variacion_pct.toFixed(2)}%</span>` : '—';
  const pnlCell    = p.pnl_no_realizado != null ? `<span class="${pnlClass}">${p.pnl_no_realizado > 0 ? '+' : ''}${fmt(p.pnl_no_realizado)}</span>` : '—';
  const pnlPctCell = p.pnl_pct != null ? `<span class="${pnlClass}">${p.pnl_pct > 0 ? '+' : ''}${p.pnl_pct.toFixed(2)}%</span>` : '—';

  // P&L gradient background: opacity proportional to magnitude vs. max in current batch
  const pnlBg = (() => {
    if (p.pnl_no_realizado == null || p.pnl_no_realizado === 0) return '';
    const intensity = Math.min(Math.abs(p.pnl_no_realizado) / maxAbsPnl, 1) * 0.28;
    return p.pnl_no_realizado > 0
      ? `background:rgba(38,115,38,${intensity.toFixed(3)})`
      : `background:rgba(204,0,0,${intensity.toFixed(3)})`;
  })();

  return `
    <tr data-posicion-id="${esc(p.id)}">
      <td>${esc(p.cliente)}</td>
      <td>${_badgeEspecie(p.especie)}</td>
      <td>${esc(p.moneda)}</td>
      <td>${esc(p.mercado)}</td>
      <td class="ejec-cell ${netaClass}">${fmtInt(p.cantidad_neta)}</td>
      <td class="precio-cell">${p.costo_promedio_compra > 0 ? fmt(p.costo_promedio_compra) : '—'}</td>
      <td class="precio-cell">${precioCell}</td>
      <td class="precio-cell">${varCell}</td>
      <td class="precio-cell" style="${pnlBg}">${pnlCell}</td>
      <td class="precio-cell">${pnlPctCell}</td>
    </tr>
  `;
}

function renderPosiciones(posiciones) {
  const tbody = document.getElementById('posicionesBody');
  if (!posiciones.length) {
    tbody.innerHTML = _emptyStateHtml(
      [['Cliente','posFiltroCliente'],['Especie','posFiltroEspecie'],['Mercado','posFiltroMercado']],
      '_limpiarFiltrosPosiciones', 10);
    return;
  }
  // Compute max |P&L| for relative gradient intensity across this batch
  const pnlVals = posiciones.map(p => p.pnl_no_realizado).filter(v => v != null);
  state.posMaxAbsPnl = pnlVals.length ? Math.max(...pnlVals.map(Math.abs), 1) : 1;
  tbody.innerHTML = posiciones.map(p => _posicionRow(p, state.posMaxAbsPnl)).join('');
  _reapplySort(tbody.closest('table'));
}

function updatePosicionEnTabla(posicion) {
  if (state.currentView !== 'posiciones') return;
  const row = document.querySelector(`tr[data-posicion-id="${posicion.id}"]`);
  if (!row) {
    cargarPosiciones(); // nueva posición, recargar tabla completa
    return;
  }
  row.className = 'updated-flash';
  // Uses state.posMaxAbsPnl from last full render for consistent gradient
  row.innerHTML = _posicionRow(posicion).replace(/^<tr[^>]*>/, '').replace(/<\/tr>$/, '');
}

// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: TRANSACCIONES
// ══════════════════════════════════════════════════════════════════════════════

async function cargarTransacciones(showSpinner = true) {
  if (showSpinner) {
    _showSkeleton('txBody', 11);
  }

  const cliente = document.getElementById('txFiltroCliente').value;
  const especie = document.getElementById('txFiltroEspecie').value;
  const mercado = document.getElementById('txFiltroMercado').value;

  const params = new URLSearchParams({
    cliente, especie, mercado,
    page: state.txPage,
    per_page: state.txPerPage,
  });

  try {
    const res = await apiFetch(`/api/transactions?${params}`);
    const data = await res.json();
    state.txTotalPages = data.pages;
    renderTransacciones(data.transacciones);
    renderTxPaginacion(data.total, data.current_page, data.pages);
  } catch (e) {
    document.getElementById('txBody').innerHTML =
      `<tr><td colspan="11">Error al cargar transacciones.</td></tr>`;
  }
}

function renderTransacciones(txs) {
  const tbody = document.getElementById('txBody');
  if (!txs.length) {
    tbody.innerHTML = _emptyStateHtml(
      [['Cliente','txFiltroCliente'],['Especie','txFiltroEspecie'],['Mercado','txFiltroMercado']],
      '_limpiarFiltrosTx', 11);
    return;
  }
  tbody.innerHTML = txs.map(t => `
    <tr>
      <td>${esc(t.fecha)}</td>
      <td><span class="nro-cell">${esc(t.nro_orden)}</span></td>
      <td><span class="tipo-badge tipo-${esc(t.tipo_orden)}">${esc(t.tipo_orden)}</span></td>
      <td>${_badgeEspecie(t.especie)}</td>
      <td>${esc(t.cliente)}</td>
      <td>${esc(t.mercado)}</td>
      <td class="ejec-cell">${fmtInt(t.cantidad)}</td>
      <td class="precio-cell">${fmt(t.precio)}</td>
      <td class="importe-cell">${fmt(t.importe)}</td>
      <td class="importe-cell" style="color:var(--orange)">${t.comision_total != null ? fmt(t.comision_total) : '—'}</td>
      <td style="color:var(--text3)">${esc(t.nro_secuencia)}</td>
    </tr>
  `).join('');
  _reapplySort(tbody.closest('table'));
}

function renderTxPaginacion(total, page, pages) {
  const info = document.getElementById('txInfo');
  const ctrl = document.getElementById('txPaginacion');

  info.textContent = _calcularPaginacion(page, state.txPerPage, total, 'ejecuciones').text;

  ctrl.innerHTML = _renderPageBtns(page, pages, 'go-tx-page');
  state.txPage = page;
  state.txTotalPages = pages;
}

function goTxPage(p) {
  if (p < 1 || p > state.txTotalPages) return;
  state.txPage = p;
  cargarTransacciones();
}

async function ejecutarOrdenManual() {
  const orden_id = parseInt(document.getElementById('ex-orden-id').value);
  const cantidad = parseInt(document.getElementById('ex-cantidad').value);
  const precio = parseFloat(document.getElementById('ex-precio').value);
  const mercado = document.getElementById('ex-mercado').value;
  const resultEl = document.getElementById('executeResult');
  resultEl.className = 'execute-result';
  resultEl.textContent = '';

  if (!orden_id || !cantidad || !precio) {
    resultEl.className = 'execute-result err';
    resultEl.textContent = 'Completá todos los campos.';
    return;
  }

  _confirmar(
    'Confirmar Ejecución',
    `Orden #${orden_id} — ${cantidad} uds @ $${fmt(precio)} en ${mercado}`,
    () => _doEjecutarOrden(orden_id, cantidad, precio, mercado, resultEl)
  );
}

async function _doEjecutarOrden(orden_id, cantidad, precio, mercado, resultEl) {
  resultEl.className = 'execute-result';
  resultEl.textContent = 'Procesando...';

  try {
    const res = await _apiFetchJson('/api/transactions/execute', 'POST', { orden_id, cantidad, precio, mercado });
    const data = await res.json();

    if (res.ok) {
      resultEl.className = 'execute-result ok';
      resultEl.textContent = `✓ ${data.mensaje}`;
      // Limpiar campos
      ['ex-orden-id', 'ex-cantidad', 'ex-precio'].forEach(id => {
        document.getElementById(id).value = '';
      });
      cargarTransacciones(false);
    } else {
      resultEl.className = 'execute-result err';
      resultEl.textContent = `✗ ${data.detail}`;
    }
  } catch (e) {
    resultEl.className = 'execute-result err';
    resultEl.textContent = '✗ Error de conexión.';
  }
}

// VISTA: HOME DASHBOARD → moved to views/dashboard.js
// VISTA: INFORMES → moved to views/informes.js
// VISTA: UTILITARIOS → moved to views/utilitarios.js

// MERCADO, GRAFICOS, INDICADORES TECNICOS -> moved to views/mercado.js


// ── THEME ──────────────────────────────────────────────────────────────────
const _THEMES = ['xp', 'sap', 'legacy', 'dark', 'aero'];
const _THEME_LABELS = { xp: 'Clásico', sap: 'Moderno', legacy: 'Retro', dark: 'Oscuro', aero: 'Aero' };

function _applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove('theme-sap', 'theme-legacy', 'theme-dark', 'theme-aero');
  if (theme === 'sap')    html.classList.add('theme-sap');
  if (theme === 'legacy') html.classList.add('theme-legacy');
  if (theme === 'dark')   html.classList.add('theme-dark');
  if (theme === 'aero')   html.classList.add('theme-aero');
  const label = _THEME_LABELS[theme] || 'Clásico';
  const nextIdx = (_THEMES.indexOf(theme) + 1) % _THEMES.length;
  const nextLabel = _THEME_LABELS[_THEMES[nextIdx]];
  const btn = document.getElementById('btnThemeToggle');
  if (btn) {
    btn.textContent = label;
    btn.title = `Tema actual: ${label} — clic para cambiar a ${nextLabel}`;
    btn.setAttribute('aria-label', `Tema actual: ${label}. Clic para cambiar a ${nextLabel}`);
  }
  localStorage.setItem('rueda-theme', theme);
}

function toggleTheme() {
  const current = localStorage.getItem('rueda-theme') || 'xp';
  const next = _THEMES[(_THEMES.indexOf(current) + 1) % _THEMES.length];
  _applyTheme(next);
}

// ── SIDEBAR DRAWER TOGGLE ───────────────────────────────────────────────────
function _updateHamburgerAria() {
  const btn = document.getElementById('btnHamburger');
  if (btn) btn.setAttribute('aria-expanded', document.body.classList.contains('sidebar-open') ? 'true' : 'false');
}

function toggleSidebar() {
  document.body.classList.toggle('sidebar-open');
  _updateHamburgerAria();
}

function _closeSidebarIfMobile() {
  if (window.innerWidth <= 1024) {
    document.body.classList.remove('sidebar-open');
    _updateHamburgerAria();
  }
}

// ── INIT ───────────────────────────────────────────────────────────────────
/**
 * Fullscreen overlay shown when init() can't bring the app up.
 * Replaces the silent blank-page failure mode.
 */
function _showInitError(msg) {
  if (document.getElementById('init-error-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'init-error-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,0.85);color:#fff;' +
    'display:flex;align-items:center;justify-content:center;z-index:99999;' +
    'font-family:system-ui,-apple-system,sans-serif';
  overlay.innerHTML = `
    <div style="background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:32px;max-width:480px;text-align:center">
      <div style="font-size:32px;margin-bottom:16px">⚠</div>
      <div style="font-size:18px;font-weight:600;margin-bottom:12px">No se pudo iniciar la aplicación</div>
      <div style="font-size:13px;color:#bbb;margin-bottom:24px">${esc(msg)}</div>
      <button id="init-error-retry" style="padding:8px 24px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px">Reintentar</button>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('init-error-retry')?.addEventListener('click', () => location.reload());
}

async function init() {
  try {
    // Verify session — apiFetch redirects to /login on 401 (and now retries via refresh first)
    const meRes = await apiFetch('/api/auth/me');
    if (!meRes.ok) {
      // apiFetch already handled 401. Anything else is a real backend failure.
      throw new Error(`No se pudo verificar la sesión (HTTP ${meRes.status}).`);
    }
    const me = await meRes.json();

    state.userRole     = me.role;
    state.clienteCodigo = me.cliente_codigo || null;

    // Show logged-in user in topbar
    const userEl = document.getElementById('topbar-user');
    if (userEl) {
      userEl.textContent = `${me.username} (${me.role})`;
    }

    // Show Admin nav item only for ADMIN role
    if (me.role === 'ADMIN') {
      document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = '';
      });
    }

    // Sync toggle button label with restored theme
    const savedTheme = localStorage.getItem('rueda-theme') || 'xp';
    _applyTheme(savedTheme);
    initNav();
    initTableSort();          // instrument all static table headers for sort
    initFilterPersistence();  // attach change listeners for filter persistence
    initFilterReloads();      // attach change/input listeners for filter reload triggers
    initSeguidos();           // attach event listeners for watchlist section
    _restoreStaticFilters();  // restore inputs + static selects immediately
    initSocket();
    await cargarFiltros();
    _restoreDynamicFilters(); // restore selects whose options were just populated
    _cargarEspeciesDatalist();
    _cargarClientes();

    // Restore view: URL hash takes priority, then localStorage, then default home
    const hashView   = location.hash.slice(1);
    const savedView  = (hashView && VIEW_LABELS[hashView]) ? hashView : localStorage.getItem('rueda-view');
    if (savedView && document.getElementById(`view-${savedView}`)) {
      setView(savedView, { pushHistory: !hashView }); // don't double-push if hash already set
    } else {
      history.replaceState({ view: 'home' }, '', '#home');
      setView('home');
    }
    await cargarNotificaciones();

    // Status bar clock — update every second
    _updateClock();
    setInterval(_updateClock, 1000);

    // Sidebar: close on nav-item click (mobile) and on resize back to desktop
    document.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', _closeSidebarIfMobile);
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 1024) document.body.classList.remove('sidebar-open');
    });

    // Load first admin tab when admin nav item is clicked
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.dataset.view === 'admin') switchAdminTab('usuarios');
      });
    });

    initCollapsiblePanels();
  } catch (e) {
    // 401s already redirected to /login via apiFetch — swallow that error here.
    if (e?.message?.startsWith('401 No autenticado')) return;
    _logError('init', e);
    _showInitError(e?.message || 'Error inesperado al iniciar la aplicación.');
  }
}

document.addEventListener('DOMContentLoaded', init);

// ── EVENT DELEGATION SYSTEM ────────────────────────────────────────────────
/**
 * Central registry of data-action handlers.
 * Replaces 192 inline onclick= attributes with a single delegated listener.
 * Usage in HTML: <button data-action="action-name" data-foo="val">
 */
const ACTIONS = {
  // ── Navigation ───────────────────────────────────────────────────────────
  'toggle-sidebar':     () => toggleSidebar(),
  'toggle-theme':       () => toggleTheme(),
  'logout':             () => logout(),
  'nueva-orden':        () => abrirModalOrden(),
  'abrir-notif':        () => abrirNotifPanel(),
  'cerrar-notif':       () => { document.getElementById('notifDropdown')?.classList.remove('open'); },
  'limpiar-notif':      () => limpiarNotificaciones(),

  // ── Orders view ──────────────────────────────────────────────────────────
  'ver-detalle':        (el) => verDetalle(Number(el.closest('[data-id]').dataset.id)),
  'go-page':            (el) => goPage(Number(el.dataset.page)),
  'go-tx-page':         (el) => goTxPage(Number(el.dataset.page)),
  'go-audit-page':      (el) => goAuditPage(Number(el.dataset.page)),
  'clear-filters':      (el) => { const fn = el.dataset.fn; if (fn && window[fn]) window[fn](); },
  'qf-ordenes':         (el) => filtroRapidoOrdenes(el.dataset.qf, el),
  'limpiar-ordenes':    () => _limpiarFiltrosOrdenes(),
  'limpiar-blotter':    () => _limpiarFiltrosBlotter(),
  'limpiar-posiciones': () => _limpiarFiltrosPosiciones(),
  'limpiar-tx':         () => _limpiarFiltrosTx(),
  'cargar-ordenes':     () => cargarOrdenes(),
  'cargar-blotter':     () => cargarBlotter(),
  'blotter-view':       (el) => setBlotterView?.(el.dataset.viewMode),
  'cargar-posiciones':  () => cargarPosiciones(),
  'cargar-proyeccion':  () => cargarProyeccion(),
  'cargar-riesgo':      () => cargarMetricasRiesgo?.(),
  'cargar-tx':          () => cargarTransacciones(),
  'filtrar-estado-red': () => filtrarPorEstado('red'),

  // ── Order form ───────────────────────────────────────────────────────────
  'submit-orden':       () => submitOrden(),
  'cancelar-orden':     (el) => cancelarOrden(Number(el.dataset.id)),
  'ejecutar-orden-manual': () => ejecutarOrdenManual?.(),
  'confirmar-cancelar': (el) => confirmarCancelarOrden(Number(el.dataset.id)),

  // ── Modal open/close ─────────────────────────────────────────────────────
  'abrir-modal-orden':  () => abrirModalOrden(),
  'cerrar-modal':       (el) => { el.closest('.modal-overlay')?.classList.remove('active'); },
  'cerrar-modal-detalle':       () => cerrarModalDetalle?.(),
  'cerrar-modal-ob':            () => cerrarModalOB?.(),
  'cerrar-modal-cuenta':        () => cerrarModalCuenta?.(),
  'cerrar-modal-usuario':       () => cerrarModalUsuario?.(),
  'cerrar-modal-cliente':       () => cerrarModalCliente?.(),
  'cerrar-modal-ticker':        () => cerrarModalTicker?.(),

  // ── Blotter ───────────────────────────────────────────────────────────────
  'exportar-ordenes-csv':   () => exportarTablaCSV?.('ordersTable', 'ordenes.csv'),
  'exportar-blotter-excel': () => exportarBlotterExcel?.(),
  'exportar-blotter-pdf':   () => exportarBlotterPDF?.(),
  'exportar-blotter-csv':   () => exportarBlotterCSV?.(),

  // ── Posiciones ────────────────────────────────────────────────────────────
  'toggle-heatmap':     () => toggleHeatmap?.(),
  'exportar-pos-csv':   () => exportarTablaCSV?.('posicionesTable', 'posiciones.csv'),
  'exportar-pos-excel': () => exportarPosExcel?.(),
  'exportar-pos-pdf':   () => exportarPosPDF?.(),

  // ── Transacciones ─────────────────────────────────────────────────────────
  'exportar-tx-excel':  () => exportarTxExcel?.(),
  'exportar-tx-pdf':    () => exportarTxPDF?.(),
  'exportar-tx-csv':    () => exportarTxCSV?.(),

  // ── Mercado / Precios ─────────────────────────────────────────────────────
  'refrescar-precios':  () => refrescarPrecios?.(),
  'set-precio-ob':      (el) => setPrecioDesdeOB(Number(el.dataset.precio)),
  'ingresar-precio-manual': () => ingresarPrecioManual?.(),
  'snapshot-precios':   () => snapshotPrecios?.(),
  'guardar-precio-manual': () => guardarPrecioManual?.(),
  'cargar-precios-historico': () => cargarPreciosHistorico?.(),
  'registrar-cierre-ajuste':  () => registrarCierreAjuste?.(),

  // ── Informes ──────────────────────────────────────────────────────────────
  'cargar-informes':        () => cargarInformes?.(),
  'cargar-informe-resumen': () => cargarInformeResumen?.(),
  'exportar-informe':       (el) => exportar?.(el.dataset.tipo),
  'exportar-informe-pdf':   () => exportarInformePDF?.(),

  // ── Utilitarios ───────────────────────────────────────────────────────────
  'cargar-benchmark':   () => cargarBenchmark?.(),
  'cargar-utilitarios': () => cargarUtilitarios?.(),
  'confirmar-reset':    () => confirmarReset?.(),
  'cargar-alertas':     () => cargarAlertas?.(),
  'guardar-alerta':     () => guardarAlerta?.(),
  'guardar-alerta-nueva': () => guardarAlerta?.(),
  'eliminar-alerta':    (el) => eliminarAlerta(Number(el.dataset.id)),
  'refrescar-mercado':  () => refrescarMercado?.(),
  'mercado-tab':        (el) => switchMercadoTab?.(el.dataset.mercadoTab),
  'snapshot-cierre':    () => snapshotCierre?.(),

  // ── Seguidos (Watchlist) ──────────────────────────────────────────────────
  'refrescar-seguidos':         () => refrescarSeguidos?.(),
  'abrir-modal-seguido':        () => abrirModalSeguido(),
  'cerrar-modal-seguido':       () => cerrarModalSeguido(),
  'confirmar-seguido':          () => confirmarAgregarSeguido(),
  'eliminar-seguido':           (el) => eliminarSeguido(el),
  'refrescar-preview-seguido':  () => _refrescarPreviewSeguidoManual(),
  // context menu
  'abrir-ctx-seguido':          (el, e) => abrirCtxSeguido(e, el.dataset.especie, el.dataset.id),
  'ctx-seg-puntas':             () => ctxSegVerPuntas(),
  'ctx-seg-orden':              () => ctxSegNuevaOrden(),
  'ctx-seg-remover':            () => ctxSegRemover(),

  // ── Admin — Operadores ────────────────────────────────────────────────────
  'abrir-modal-cuenta-dep': (el) => abrirModalCuenta('operador', 'CREDIT', Number(el.dataset.id), el.dataset.nombre),
  'abrir-modal-cuenta-ret': (el) => abrirModalCuenta('operador', 'DEBIT',  Number(el.dataset.id), el.dataset.nombre),
  'ver-movimientos-op': (el) => verMovimientosOp(Number(el.dataset.id), el.dataset.nombre, el.dataset.page ? Number(el.dataset.page) : 1),
  'confirmar-modal-cuenta': () => confirmarModalCuenta?.(),
  'guardar-usuario':    (el) => guardarUsuario?.(el),
  'guardar-cliente':    (el) => guardarCliente?.(el),
  'submit-cuenta':      () => submitCuenta?.(),
  'cargar-firma':       (el) => cargarFirma(Number(el.dataset.page)),

  // ── Admin — Usuarios ─────────────────────────────────────────────────────
  'toggle-horario-global': () => { const cb = document.getElementById('switch-horario-global'); if (cb) cb.click(); },
  'cargar-usuarios':       () => cargarUsuarios?.(),
  'cargar-clientes-admin': () => cargarClientesAdmin?.(),
  'cargar-tickers-admin':  () => cargarTickersAdmin?.(),
  'abrir-modal-bot':       () => abrirModalBot?.(),
  'cargar-bots':           () => cargarBots?.(),
  'abrir-modal-usuario': (el) => abrirModalUsuario(el.dataset.id ? Number(el.dataset.id) : undefined),
  'submit-usuario':      () => submitUsuario?.(),

  // ── Admin — Clientes ──────────────────────────────────────────────────────
  'abrir-modal-cliente': (el) => abrirModalCliente(el.dataset.codigo || el.dataset.id),
  'submit-cliente':      () => submitCliente?.(),

  // ── Admin — Tickers ───────────────────────────────────────────────────────
  'abrir-modal-ticker':  (el) => abrirModalTicker(el.dataset.especie),
  'submit-ticker':       () => submitTicker?.(),

  // ── Admin — Audit ─────────────────────────────────────────────────────────
  'recargar-mov-op':    () => recargarMovOp?.(),
  'reset-audit-page':   () => resetAuditPage?.(),
  'cargar-auditoria':   () => cargarAuditoria?.(),
  'abrir-modal-instrumento':  () => abrirModalInstrumento?.(),
  'abrir-modal-contraparte':  () => abrirModalContraparte?.(),
  'cargar-contrapartes':      () => cargarContrapartes?.(),
  'abrir-modal-limite-riesgo':() => abrirModalLimiteRiesgo?.(),
  'cargar-limites':           () => cargarLimites?.(),
  'procesar-liquidaciones':   () => procesarLiquidaciones?.(),
  'cargar-liquidaciones':     () => cargarLiquidaciones?.(),
  'liq-prev': () => { if (typeof _liqPage !== 'undefined') cargarLiquidaciones?.(_liqPage - 1); },
  'liq-next': () => { if (typeof _liqPage !== 'undefined') cargarLiquidaciones?.(_liqPage + 1); },
  'abrir-modal-operador':     () => abrirModalOperador?.(),
  'cargar-operadores':        () => cargarOperadores?.(),
  'firma-depositar':          () => abrirModalCuenta?.('firma', 'CREDIT'),
  'firma-retirar':            () => abrirModalCuenta?.('firma', 'DEBIT'),
  'cargar-firma':             () => cargarFirma?.(),
  'cargar-posiciones-firma':  () => cargarPosicionesFirma?.(),
  'cargar-cuentas-op':        () => cargarCuentasOperadores?.(),
  'cargar-instrumentos':      () => cargarInstrumentos?.(),
  'cargar-pnl':               () => cargarPnl?.(),
  'cargar-pnl-desk':          () => cargarPnlPorDesk?.(),
  'abrir-cierre-dia':         () => abrirCierreDia?.(),
  'cargar-tc-actual':         () => cargarTcActual?.(),
  'guardar-tc-hoy':           () => guardarTcHoy?.(),
  'cargar-tc-historico':      () => cargarTcHistorico?.(),
  'cargar-reporte-cnv':       () => cargarReporteCnv?.(),
  'cargar-reporte-bcra':      () => cargarReporteBcra?.(),
  'cargar-reporte-uif':       () => cargarReporteUif?.(),
  'descargar-reporte':        (el) => {
    const fecha = el.dataset.fechaId ? document.getElementById(el.dataset.fechaId)?.value : undefined;
    const umbral = el.dataset.umbralId ? document.getElementById(el.dataset.umbralId)?.value : undefined;
    descargarReporte?.(el.dataset.tipo, fecha, umbral);
  },
  'cargar-config-sistema':    () => cargarConfigSistema?.(),
  'guardar-mercado-matching': () => guardarMercadoMatching?.(),
  'reset-demo-data':          () => resetDemoData?.(),

  // ── Admin tabs ────────────────────────────────────────────────────────────
  'admin-tab': (el) => switchAdminTab(el.dataset.tab),

  // ── Ticker modal ─────────────────────────────────────────────────────────
  'guardar-ticker':           (el) => guardarTicker?.(el),

  // ── Bot modal ─────────────────────────────────────────────────────────────
  'guardar-bot':              (el) => guardarBot?.(el),
  'switch-cuentabot-tab':     (el) => switchCuentaBotTab?.(el.dataset.tab),
  'pag-bot':                  (el) => cambiarPaginaBot?.(Number(el.dataset.dir)),
  'inicializar-cuenta-bot':   () => inicializarCuentaBot?.(),
  'ejecutar-ajuste-bot':      () => ejecutarAjusteBot?.(),
  'ejecutar-reconciliar-bot': () => ejecutarReconciliarBot?.(),

  // ── Instrumento modal ─────────────────────────────────────────────────────
  'switch-inst-tab':          (el) => switchInstTab?.(el.dataset.tab),
  'guardar-detalle-rf':       (el) => guardarDetalleRentaFija?.(el),
  'guardar-detalle-futuro':   (el) => guardarDetalleFuturo?.(el),
  'abrir-modal-llamado':      () => abrirModalLlamado?.(),
  'guardar-instrumento':      () => guardarInstrumento?.(),

  // ── Llamado / Contraparte / Límite de riesgo modals ──────────────────────
  'guardar-llamado':          (el) => guardarLlamado?.(el),
  'guardar-contraparte':      (el) => guardarContraparte?.(el),
  'guardar-limite-riesgo':    (el) => guardarLimiteRiesgo?.(el),

  // ── Detalle orden modal ───────────────────────────────────────────────────
  'cerrar-modal-directo':     () => cerrarModalDirecto?.(),
  'confirmar-modificacion':   () => confirmarModificacion?.(),
  'duplicar-orden':           () => duplicarOrden?.(),
  'toggle-modify-form':       () => toggleModifyForm?.(),
  'cancelar-orden-modal':     () => cancelarOrdenDesdeModal?.(),

  // ── Nueva orden modal ─────────────────────────────────────────────────────
  'toggle-op-avanz':          () => toggleOpcionesAvanzadas?.(),
  'enviar-nueva-orden':       () => enviarNuevaOrden?.(),

  // ── Operador modal ────────────────────────────────────────────────────────
  'guardar-operador':         (el) => guardarOperador?.(el),

  // ── Reset modal ───────────────────────────────────────────────────────────
  'ejecutar-reset':           (el) => ejecutarReset?.(el),

  // ── Gráfico modal ─────────────────────────────────────────────────────────
  'cerrar-grafico':           () => { document.getElementById('modalGrafico')?.classList.remove('active'); _destruirGraficos?.(); },
  'cambiar-modo-grafico':     (el) => cambiarModoGrafico?.(el.dataset.mode),
  'toggle-indicador':         (el) => toggleIndicador?.(el.dataset.ind),

  // ── Toasts ───────────────────────────────────────────────────────────────
  'close-toast': (el) => el.closest('.toast')?.remove(),
};

/** Central click dispatcher — handles data-action on any element */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  // Modal overlay backdrop click — only close if the click landed on the
  // overlay itself (backdrop), NOT on a child element inside the modal box.
  if (el.classList.contains('modal-overlay')) {
    if (e.target === el) {
      el.classList.remove('active');
      _popModalFocus();
    }
    return;
  }
  const action = el.dataset.action;
  const handler = ACTIONS[action];
  if (handler) {
    e.stopPropagation();
    handler(el, e);
  }
}, true);  // capture phase so modal overlays catch backdrop clicks before children

/** Focus trap for open modals — Tab / Shift+Tab stays inside */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const overlay = document.querySelector('.modal-overlay.active');
  if (!overlay) return;
  const focusable = Array.from(overlay.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ));
  if (!focusable.length) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
  }
});

/** Close active modal on Escape key and restore focus to trigger element */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const overlay = document.querySelector('.modal-overlay.active');
  if (overlay) { overlay.classList.remove('active'); _popModalFocus(); }
});

const _especiesValidas = new Set();

async function _cargarEspeciesDatalist() {
  const dl = document.getElementById('especies-list');
  if (!dl) return;
  const res = await apiFetch('/api/mercado/especies');
  if (!res.ok) return;
  const especies = await res.json();
  _especiesValidas.clear();
  especies.forEach(e => _especiesValidas.add(e));
  dl.innerHTML = especies.map(e => `<option value="${esc(e)}">`).join('');
}

async function _cargarClientes() {
  const res = await apiFetch('/api/clientes');
  if (!res.ok) return;
  const clientes = await res.json();
  state.clientes = clientes;

  // Populate the order form client select
  const fCliente = document.getElementById('f-cliente');
  if (fCliente) {
    fCliente.innerHTML = clientes.map(c =>
      `<option value="${esc(c.codigo)}">${esc(c.codigo)} — ${esc(c.razon_social)}</option>`
    ).join('');
    // For OPERADOR with a linked client: lock to their client
    if (state.userRole === 'OPERADOR' && state.clienteCodigo) {
      fCliente.value = state.clienteCodigo;
      fCliente.disabled = true;
    } else if (state.clienteCodigo) {
      fCliente.value = state.clienteCodigo;
    }
  }

  // Sync the hidden razon_social input
  _syncRazonSocial();

  // Populate the operator modal client select
  _poblarSelectClientes(document.getElementById('opClienteCodigo'), null);
}

function _syncRazonSocial() {
  const fCliente = document.getElementById('f-cliente');
  const fRazon   = document.getElementById('f-razon');
  if (!fCliente || !fRazon) return;
  const cli = state.clientes.find(c => c.codigo === fCliente.value);
  fRazon.value = cli ? cli.razon_social : fCliente.value;
}

function _poblarSelectClientes(selectEl, selectedCodigo) {
  if (!selectEl) return;
  selectEl.innerHTML = '<option value="">— Sin vincular —</option>' +
    state.clientes.map(c =>
      `<option value="${esc(c.codigo)}">${esc(c.codigo)} — ${esc(c.razon_social)}</option>`
    ).join('');
  if (selectedCodigo) selectEl.value = selectedCodigo;
}

// ── CLOCK ───────────────────────────────────────────────────────────────────
function _updateClock() {
  const el = document.getElementById('status-clock');
  if (el) el.textContent = new Date().toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ── QUICK FILTERS ───────────────────────────────────────────────────────────
function filtroRapidoOrdenes(tipo, btn) {
  document.querySelectorAll('#ordenes-qf-bar .qf-btn').forEach(b => b.classList.remove('qf-active'));
  if (btn) btn.classList.add('qf-active');
  const estadoSel = document.getElementById('filtroEstado');
  if (tipo === 'pendientes')  estadoSel.value = 'orange';
  else if (tipo === 'ejecutadas') estadoSel.value = 'green';
  else estadoSel.value = '';
  state.currentPage = 1;
  cargarOrdenes();
}

// ── CSV EXPORT ──────────────────────────────────────────────────────────────
/**
 * Exports a visible HTML table to a UTF-8 CSV download.
 * tableId: ID of the <table> element.
 * filename: suggested download filename.
 */
function exportarTablaCSV(tableId, filename) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const rows = [];
  const headers = Array.from(table.querySelectorAll('thead th'))
    .map(th => `"${th.textContent.trim().replace(/"/g, '""')}"`);
  rows.push(headers.join(','));
  table.querySelectorAll('tbody tr:not(.loading-row)').forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('td')).map(td => {
      const text = td.textContent.trim().replace(/\s+/g, ' ');
      return `"${text.replace(/"/g, '""')}"`;
    });
    if (cells.length) rows.push(cells.join(','));
  });
  const csv = rows.join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`${filename} descargado.`, 'ok', 'CSV');
}

// ── CONFIRM DIALOG ──────────────────────────────────────────────────────────
/**
 * Custom confirm dialog — replaces native browser confirm().
 * titulo: dialog title, msg: body text, onConfirm: callback on OK.
 */
function _confirmar(titulo, msg, onConfirm) {
  const existing = document.getElementById('confirm-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="confirm-titulo">
      <div class="confirm-title" id="confirm-titulo">${esc(titulo)}</div>
      <div class="confirm-msg">${esc(msg)}</div>
      <div class="confirm-actions">
        <button class="btn-cerrar" id="btn-confirm-cancel">Cancelar</button>
        <button class="btn-nueva-orden" id="btn-confirm-ok">Confirmar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let _confirmTimer = null;
  const cleanup = () => {
    if (_confirmTimer) { clearTimeout(_confirmTimer); _confirmTimer = null; }
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const cancel = () => cleanup();
  overlay.querySelector('#btn-confirm-cancel').onclick = cancel;
  overlay.querySelector('#btn-confirm-ok').onclick = () => { cleanup(); onConfirm(); };
  overlay.onclick = (e) => { if (e.target === overlay) cancel(); };

  // ESC key closes the dialog
  const onKey = (e) => { if (e.key === 'Escape') cancel(); };
  document.addEventListener('keydown', onKey);

  // Auto-dismiss after 10 minutes to prevent stale confirm dialogs
  _confirmTimer = setTimeout(() => cancel(), CONFIRM_AUTODISMISS_MS);

  // Focus confirm button for keyboard accessibility
  overlay.querySelector('#btn-confirm-ok').focus();
}

// HEATMAP DE POSICIONES -> moved to views/posiciones.js


// ADMIN PANEL (sub-tabs, firma, ctas operadores, auditoria, alertas,
// modal depositar/retirar, collapsible panels, usuarios, clientes,
// tickers, bots, config sistema, modal cuenta bot, bot positions)
// -> moved to views/admin.js


// INSTRUMENTOS + LLAMADOS A MARGEN -> moved to views/instrumentos.js


// P&L DIARIO, TIPO DE CAMBIO, REPORTES REGULATORIOS -> moved to views/reportes.js

// CONTRAPARTES -> moved to views/contrapartes.js

// LIMITES DE RIESGO -> moved to views/riesgo.js

// LIQUIDACIONES -> moved to views/liquidaciones.js

// BLOTTER DEL DIA -> moved to views/blotter.js

// CAJA PROYECCION -> moved to views/caja.js



// METRICAS DE RIESGO -> moved to views/riesgo.js

// OPERADORES / DESKS -> moved to views/operadores.js

// P&L POR DESK, VALUACION DE PRECIOS -> moved to views/reportes.js

// ════════════════════════════════════════════════════════════════════════════════
// SEGUIDOS (Watchlist) -> moved to views/seguidos.js
