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


// ═══════════════════════════════════════════════════════════════════════════
// ── P&L DIARIO ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

const _fmtPnl = v => {
  if (v == null) return '—';
  const n = Number(v);
  const c = n >= 0 ? 'var(--green)' : 'var(--red)';
  const s = n >= 0 ? '+' : '';
  return `<span style="color:${c};font-family:'IBM Plex Mono',monospace;font-size:11px">${s}$${fmt(v)}</span>`;
};

async function cargarPnl() {
  await _cargarTabla('pnlBody', 9, async (tbody) => {
    const desde   = document.getElementById('pnlFechaDesde')?.value || '';
    const hasta   = document.getElementById('pnlFechaHasta')?.value || '';
    const cliente = document.getElementById('pnlCliente')?.value.trim() || '';
    const especie = document.getElementById('pnlEspecie')?.value.trim() || '';
    let url = '/api/pnl?';
    if (desde)   url += `fecha_desde=${desde}&`;
    if (hasta)   url += `fecha_hasta=${hasta}&`;
    if (cliente) url += `cliente=${encodeURIComponent(cliente)}&`;
    if (especie) url += `especie=${encodeURIComponent(especie)}&`;
    const res  = await apiFetch(url);
    const data = await res.json();
    const rows = data.pnl || [];
    if (!rows.length) { tbody.innerHTML = _emptyTableRow(9, 'Sin datos para los filtros seleccionados.'); return; }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(r.fecha)}</td>
        <td><span class="badge-tipo" style="font-size:10px">${esc(r.cliente)}</span></td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(r.especie)}</td>
        <td style="font-size:11px">${esc(r.moneda)}</td>
        <td style="text-align:right">${_fmtPnl(r.pnl_realizado)}</td>
        <td style="text-align:right">${_fmtPnl(r.pnl_no_realizado)}</td>
        <td style="text-align:right">${_fmtPnl(r.pnl_total)}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.volumen_comprado!=null?fmt(r.volumen_comprado):'—'}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.volumen_vendido !=null?fmt(r.volumen_vendido) :'—'}</td>
      </tr>
    `).join('');
    if (hasta) cargarResumenPnl(hasta);
  });
}

async function cargarResumenPnl(fecha) {
  const el = document.getElementById('pnl-resumen');
  if (!el) return;
  try {
    const res  = await apiFetch(`/api/pnl/resumen?fecha=${fecha}`);
    const data = await res.json();
    const box  = (lbl, val, c='var(--text1)') => `
      <div style="background:var(--bg4);border:1px solid var(--border);border-radius:2px;padding:10px;text-align:center">
        <div style="font-size:10px;color:var(--text3);margin-bottom:5px;letter-spacing:.5px;text-transform:uppercase">${lbl}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;color:${c}">${val}</div>
      </div>`;
    const pR = data.total_realizado    || 0;
    const pN = data.total_no_realizado || 0;
    const pT = data.total             || 0;
    el.innerHTML =
      box('P&L Realizado',    (pR>=0?'+':'')+`$${_fmtARSCompact(pR)}`, pR>=0?'var(--green)':'var(--red)') +
      box('P&L No Realizado', (pN>=0?'+':'')+`$${_fmtARSCompact(pN)}`, pN>=0?'var(--green)':'var(--red)') +
      box('P&L Total',        (pT>=0?'+':'')+`$${_fmtARSCompact(pT)}`, pT>=0?'var(--green)':'var(--red)') +
      box('Posiciones',       data.total_posiciones||0);
  } catch { /* ignore */ }
}

async function abrirCierreDia() {
  const fecha = document.getElementById('pnlFechaHasta')?.value || new Date().toISOString().slice(0,10);
  const resEl = document.getElementById('pnlCierreDiaResult');
  _confirmar(
    'Cierre de día',
    `¿Ejecutar cierre de día para ${fecha}? Se calcularán P&L realizados y no realizados para todas las posiciones abiertas. La operación es idempotente (se puede repetir sin efecto doble).`,
    async () => {
      resEl.style.color='var(--text2)';
      _setLoadingMessage(resEl, 'Procesando cierre de día...');
      await _cierreDiaExec(fecha, resEl);
    }
  );
}

async function _cierreDiaExec(fecha, resEl) {
  try {
    const res  = await apiFetch(`/api/pnl/cerrar-dia?fecha=${fecha}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { resEl.style.color='var(--red)'; resEl.innerHTML=esc(data.detail||'Error'); return; }
    resEl.style.color='var(--green)'; resEl.innerHTML=esc(data.mensaje||'Cierre procesado.');
    await cargarPnl();
  } catch(e) { resEl.style.color='var(--red)'; resEl.innerHTML=esc(e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── TIPO DE CAMBIO ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarTcActual() {
  const el = document.getElementById('tc-cards');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text3);font-size:11px">Cargando...</div>';
  try {
    const res  = await apiFetch('/api/tipo-cambio/actual');
    const data = await res.json();
    const labels = { mep:'MEP', ccl:'CCL', cable:'CABLE', oficial:'OFICIAL', bna:'BNA' };
    el.innerHTML = Object.entries(labels).map(([k, label]) => {
      const v = data[k];
      if (!v) return '';
      const venta  = v.venta  != null ? v.venta  : (typeof v === 'number' ? v : null);
      const compra = v.compra != null ? v.compra : null;
      return `
        <div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:12px;text-align:center">
          <div style="font-size:10px;color:var(--text3);margin-bottom:6px;letter-spacing:.5px">${label}</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:var(--text1)">$${venta!=null?fmt(venta):'—'}</div>
          ${compra ? `<div style="font-size:10px;color:var(--text3);margin-top:2px">Compra: $${fmt(compra)}</div>` : ''}
        </div>`;
    }).filter(Boolean).join('');
    if (!el.innerHTML) el.innerHTML = '<div style="color:var(--text3);font-size:11px">Sin datos de tipo de cambio disponibles.</div>';
  } catch(e) {
    el.innerHTML = `<div style="color:var(--red);font-size:11px">Error: ${esc(e.message)}</div>`;
  }
}

async function cargarTcHistorico() {
  await _cargarTabla('tcHistoricoBody', 5, async (tbody) => {
    const tipo  = document.getElementById('tcTipoFiltro')?.value  || '';
    const desde = document.getElementById('tcFechaDesde')?.value  || '';
    const hasta = document.getElementById('tcFechaHasta')?.value  || '';
    let url = '/api/tipo-cambio/historico?';
    if (tipo)  url += `tipo=${tipo}&`;
    if (desde) url += `fecha_desde=${desde}&`;
    if (hasta) url += `fecha_hasta=${hasta}&`;
    const res  = await apiFetch(url);
    const data = await res.json();
    const rows = data.tipo_cambio_historico || [];
    if (!rows.length) { tbody.innerHTML = _emptyTableRow(5, 'Sin registros para el filtro.'); return; }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(r.fecha)}</td>
        <td><span class="badge-tipo" style="font-size:10px">${esc(r.tipo)}</span></td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.valor_compra!=null?'$'+fmt(r.valor_compra):'—'}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.valor_venta !=null?'$'+fmt(r.valor_venta) :'—'}</td>
        <td style="font-size:11px;color:var(--text3)">${esc(r.fuente||'—')}</td>
      </tr>
    `).join('');
  });
}

async function guardarTcHoy() {
  const resEl = document.getElementById('tcResult');
  resEl.style.color='var(--text2)'; resEl.textContent='Guardando...';
  try {
    const res  = await apiFetch('/api/tipo-cambio/guardar', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { resEl.style.color='var(--red)'; resEl.textContent=data.detail||'Error'; return; }
    resEl.style.color='var(--green)';
    resEl.textContent=`${data.registros_guardados} registro(s) guardados para ${data.fecha}.`;
    await cargarTcActual();
  } catch(e) { resEl.style.color='var(--red)'; resEl.textContent=e.message; }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── REPORTES REGULATORIOS ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function _rptSetFechaHoy(inputId) {
  const el = document.getElementById(inputId);
  if (el && !el.value) el.value = new Date().toISOString().slice(0,10);
}

async function cargarReporteCnv() {
  _rptSetFechaHoy('rptCnvFecha');
  const fecha = document.getElementById('rptCnvFecha').value;
  if (!fecha) { showToast('Seleccioná una fecha.','warn'); return; }
  try {
    const res  = await apiFetch(`/api/reportes/cnv-byma?fecha=${fecha}&formato=json`);
    const data = await res.json();
    const rows = data.operaciones || [];
    document.getElementById('rptResultadoTitulo').textContent = `CNV/BYMA — ${rows.length} operaciones (${fecha})`;
    const cols = ['nro_orden','especie','tipo_orden','cliente','contraparte','cantidad','precio','importe','moneda','mercado','fecha_hora'];
    _rptMostrarTabla(cols, rows);
  } catch(e) { showToast(e.message,'error'); }
}

async function cargarReporteBcra() {
  _rptSetFechaHoy('rptBcraFecha');
  const fecha = document.getElementById('rptBcraFecha').value;
  if (!fecha) { showToast('Seleccioná una fecha.','warn'); return; }
  try {
    const res  = await apiFetch(`/api/reportes/bcra-cambios?fecha=${fecha}&formato=json`);
    const data = await res.json();
    const rows = data.posiciones || [];
    document.getElementById('rptResultadoTitulo').textContent = `BCRA Cambios — ${rows.length} posiciones (${fecha}), TC CCL: ${data.tc_ccl_referencia||'—'}`;
    const cols = ['especie','moneda','cantidad_neta','precio_mercado','valor_usd','valor_ars','tc_ccl'];
    _rptMostrarTabla(cols, rows);
  } catch(e) { showToast(e.message,'error'); }
}

async function cargarReporteUif() {
  _rptSetFechaHoy('rptUifFecha');
  const fecha  = document.getElementById('rptUifFecha').value;
  const umbral = document.getElementById('rptUifUmbral').value || 1000000;
  if (!fecha) { showToast('Seleccioná una fecha.','warn'); return; }
  try {
    const res  = await apiFetch(`/api/reportes/uif-inusuales?fecha=${fecha}&umbral_monto=${umbral}&formato=json`);
    const data = await res.json();
    const rows = data.operaciones_inusuales || [];
    document.getElementById('rptResultadoTitulo').textContent = `UIF Inusuales — ${rows.length} alertas (${fecha})`;
    const cols = ['nro_orden','especie','cliente','es_pep','tipo_orden','cantidad','precio','importe','motivo','fecha_hora'];
    _rptMostrarTabla(cols, rows);
  } catch(e) { showToast(e.message,'error'); }
}

function _rptMostrarTabla(cols, rows) {
  const head = document.getElementById('rptTablaHead');
  const body = document.getElementById('rptTablaBody');
  document.getElementById('rptResultado').style.display = '';
  if (!rows.length) {
    head.innerHTML = '';
    body.innerHTML = '<tr><td class="text-muted">Sin datos para la fecha seleccionada.</td></tr>';
    return;
  }
  head.innerHTML = `<tr>${cols.map(c=>`<th>${esc(c)}</th>`).join('')}</tr>`;
  body.innerHTML = rows.map(r =>
    `<tr>${cols.map(c=>`<td style="font-size:11px;white-space:nowrap">${esc(r[c]!=null?String(r[c]):'—')}</td>`).join('')}</tr>`
  ).join('');
}

async function descargarReporte(tipo, fecha, umbral = null) {
  if (!fecha) { showToast('Seleccioná una fecha.','warn'); return; }
  let url = `/api/reportes/${tipo}?fecha=${fecha}&formato=csv`;
  if (umbral) url += `&umbral_monto=${umbral}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${tipo}_${fecha.replace(/-/g,'')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ═══════════════════════════════════════════════════════════════════════════
// ── CONTRAPARTES ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarContrapartes() {
  await _cargarTabla('contrapartesBody', 5, async (tbody) => {
    const res   = await apiFetch('/api/contrapartes');
    const data  = await res.json();
    const items = data.contrapartes || [];
    if (!items.length) { tbody.innerHTML = _emptyTableRow(5, 'Sin contrapartes.'); return; }
    _contraparteDataMap = _buildDataMap(items);
    tbody.innerHTML = items.map(c => `
      <tr>
        <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(c.codigo)}</span></td>
        <td>${esc(c.nombre)}</td>
        <td><span class="badge-tipo" style="font-size:10px;opacity:.8">${esc(c.tipo||'—')}</span></td>
        <td>
          <label class="toggle-switch">
            <input type="checkbox" ${c.activo?'checked':''} onchange="toggleContraparteActivo(${c.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td><button class="btn-mini" onclick="abrirModalContraparte(${c.id})">Editar</button></td>
      </tr>
    `).join('');
  });
}

function abrirModalContraparte(cp = null) {
  if (typeof cp === 'number' || (typeof cp === 'string' && cp !== '')) {
    cp = _contraparteDataMap[+cp] || null;
  }
  document.getElementById('cpResult').textContent = '';
  if (cp && typeof cp === 'object') {
    document.getElementById('modalCpTitulo').textContent = 'Editar Contraparte';
    document.getElementById('cp-id').value     = cp.id;
    document.getElementById('cp-codigo').value = cp.codigo;
    document.getElementById('cp-nombre').value = cp.nombre;
    document.getElementById('cp-tipo').value   = cp.tipo || 'MERCADO';
    document.getElementById('cp-codigo').disabled = true;
  } else {
    document.getElementById('modalCpTitulo').textContent = 'Nueva Contraparte';
    document.getElementById('cp-id').value     = '';
    document.getElementById('cp-codigo').value = '';
    document.getElementById('cp-nombre').value = '';
    document.getElementById('cp-tipo').value   = 'MERCADO';
    document.getElementById('cp-codigo').disabled = false;
  }
  document.getElementById('cp-lim-valor').value  = '';
  document.getElementById('cp-lim-alerta').value = '80';
  document.getElementById('modalContraparte').classList.add('active');
}

async function guardarContraparte(btn) {
  const resEl  = document.getElementById('cpResult');
  resEl.textContent = '';
  const id     = document.getElementById('cp-id').value;
  const codigo = document.getElementById('cp-codigo').value.trim().toUpperCase();
  const nombre = document.getElementById('cp-nombre').value.trim();
  const tipo   = document.getElementById('cp-tipo').value;
  if (!codigo || !nombre) { _showResultErr(resEl, 'Código y nombre son requeridos.'); return; }

  await _withButtonLoading(btn, async () => {
    try {
      let res, cpId;
      if (id) {
        res  = await _apiFetchJson(`/api/contrapartes/${id}`, 'PATCH', { nombre });
        cpId = id;
      } else {
        res  = await _apiFetchJson('/api/contrapartes', 'POST', { codigo, nombre, tipo });
        if (res.ok) { const d = await res.json(); cpId = d.id; }
      }
      if (!res.ok) { const e = await res.json(); _showResultErr(resEl, e.detail || 'Error'); return; }
      const limValor = parseFloatOrNull(document.getElementById('cp-lim-valor').value);
      if (cpId && limValor > 0) {
        const moneda = document.getElementById('cp-lim-moneda').value;
        const alerta = parseFloat(document.getElementById('cp-lim-alerta').value) || 80;
        await _apiFetchJson(`/api/contrapartes/${cpId}/limites`, 'PUT',
          { moneda, limite: limValor, alerta_pct: alerta });
      }
      document.getElementById('modalContraparte').classList.remove('active');
      await cargarContrapartes();
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

async function toggleContraparteActivo(id, activo) {
  return _togglePatch(`/api/contrapartes/${id}`, { activo }, cargarContrapartes);
}

// ═══════════════════════════════════════════════════════════════════════════
// ── LÍMITES DE RIESGO ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarLimites() {
  await _cargarTabla('limitesBody', 8, async (tbody) => {
    const res   = await apiFetch('/api/riesgo/limites');
    const data  = await res.json();
    const items = data.limites || [];
    _limiteDataMap = _buildDataMap(items);
    if (!items.length) { tbody.innerHTML = _emptyTableRow(8, 'Sin límites configurados.'); return; }
    tbody.innerHTML = items.map(l => `
      <tr>
        <td style="font-size:11px">${esc(l.owner_type)}${l.owner_id?` #${l.owner_id}`:''}</td>
        <td style="font-size:11px;font-weight:600">${esc(l.tipo_limite)}</td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(l.especie||'—')}</td>
        <td style="font-size:11px">${esc(l.moneda||'—')}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">$${fmt(l.valor_limite)}</td>
        <td style="text-align:right;font-size:11px">${l.alerta_pct!=null?l.alerta_pct+'%':'—'}</td>
        <td>
          <label class="toggle-switch">
            <input type="checkbox" ${l.activo?'checked':''} onchange="toggleLimiteActivo(${l.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td><button class="btn-mini" onclick="abrirModalLimiteRiesgo(${l.id})">Editar</button></td>
      </tr>
    `).join('');
  });
}

function abrirModalLimiteRiesgo(lim = null) {
  if (typeof lim === 'number' || (typeof lim === 'string' && lim !== '')) {
    lim = _limiteDataMap[+lim] || null;
  }
  document.getElementById('lrResult').textContent = '';
  if (lim && typeof lim === 'object') {
    document.getElementById('modalLimRiesgoTitulo').textContent = 'Editar Límite';
    document.getElementById('lr-id').value         = lim.id;
    document.getElementById('lr-owner-type').value = lim.owner_type || 'GLOBAL';
    document.getElementById('lr-owner-id').value   = lim.owner_id || '';
    document.getElementById('lr-tipo').value       = lim.tipo_limite;
    document.getElementById('lr-especie').value    = lim.especie || '';
    document.getElementById('lr-moneda').value     = lim.moneda || 'ARP';
    document.getElementById('lr-valor').value      = lim.valor_limite;
    document.getElementById('lr-alerta').value     = lim.alerta_pct || 80;
  } else {
    document.getElementById('modalLimRiesgoTitulo').textContent = 'Nuevo Límite de Riesgo';
    document.getElementById('lr-id').value         = '';
    document.getElementById('lr-owner-type').value = 'GLOBAL';
    document.getElementById('lr-owner-id').value   = '';
    document.getElementById('lr-tipo').value       = 'CONCENTRACION_MAX';
    document.getElementById('lr-especie').value    = '';
    document.getElementById('lr-moneda').value     = 'ARP';
    document.getElementById('lr-valor').value      = '';
    document.getElementById('lr-alerta').value     = '80';
  }
  document.getElementById('modalLimiteRiesgo').classList.add('active');
}

async function guardarLimiteRiesgo(btn) {
  const resEl  = document.getElementById('lrResult');
  resEl.textContent = '';
  const id     = document.getElementById('lr-id').value;
  const valor  = parseFloatOrNull(document.getElementById('lr-valor').value);
  const alerta = parseFloatOrNull(document.getElementById('lr-alerta').value);
  if (!(valor > 0)) { resEl.style.color='var(--red)'; resEl.textContent='El valor límite es requerido.'; return; }
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    let res;
    if (id) {
      res = await apiFetch(`/api/riesgo/limites/${id}`, {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ valor_limite: valor, alerta_pct: alerta }),
      });
    } else {
      const ownerId = document.getElementById('lr-owner-id').value;
      res = await apiFetch('/api/riesgo/limites', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          owner_type:   document.getElementById('lr-owner-type').value,
          owner_id:     ownerId ? parseInt(ownerId) : null,
          tipo_limite:  document.getElementById('lr-tipo').value,
          especie:      document.getElementById('lr-especie').value.trim() || null,
          moneda:       document.getElementById('lr-moneda').value,
          valor_limite: valor,
          alerta_pct:   alerta,
        }),
      });
    }
    if (!res.ok) { const e=await res.json(); resEl.style.color='var(--red)'; resEl.textContent=e.detail||'Error'; return; }
    document.getElementById('modalLimiteRiesgo').classList.remove('active');
    await cargarLimites();
  } catch(e) { resEl.style.color='var(--red)'; resEl.textContent=e.message; }
  finally { if (btn) { btn.disabled = false; if (origText) btn.textContent = origText; } }
}

async function toggleLimiteActivo(id, activo) {
  return _togglePatch(`/api/riesgo/limites/${id}`, { activo }, cargarLimites);
}

// ═══════════════════════════════════════════════════════════════════════════
// ── LIQUIDACIONES ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

let _liqPage = 1;

async function cargarLiquidaciones(page = 1) {
  _liqPage = page < 1 ? 1 : page;
  const tbody = document.getElementById('liquidBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 8);
  try {
    const res  = await apiFetch(`/api/liquidaciones/pendientes?page=${_liqPage}&per_page=${LIQ_PER_PAGE}`);
    const data = await res.json();
    const rows = data.items || data.fills || data.ejecuciones || [];
    const totalPages = data.pages || 1;
    document.getElementById('liq-pag-info').textContent = `Página ${_liqPage} de ${totalPages}`;
    document.getElementById('liq-prev').disabled = _liqPage <= 1;
    document.getElementById('liq-next').disabled = _liqPage >= totalPages;
    if (!rows.length) { tbody.innerHTML = _emptyStateHtml([], '', 8); return; }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(r.id||r.fill_id||'—')}</td>
        <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(r.especie||'—')}</span></td>
        <td style="font-size:11px">${esc(r.cliente||r.razon_social||'—')}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.cantidad!=null?r.cantidad:'—'}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.precio!=null?'$'+fmt(r.precio):'—'}</td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(r.fecha_liquidacion||'—')}</td>
        <td style="font-size:11px;color:var(--text3)">${esc(r.mercado||'—')}</td>
        <td><span style="font-size:10px;font-weight:600;color:#f0a500">${esc(r.estado||'PENDIENTE')}</span></td>
      </tr>
    `).join('');
  } catch(e) {
    tbody.innerHTML = _errorTableRow(8, e.message);
  }
}

async function procesarLiquidaciones() {
  const resEl = document.getElementById('liquidResult');
  _confirmar(
    'Procesar liquidaciones EOD',
    'Se marcarán como liquidadas todas las ejecuciones con fecha de liquidación vencida a la fecha de hoy. Esta operación afecta el balance disponible de los clientes involucrados.',
    async () => {
      resEl.style.color='var(--text2)';
      _setLoadingMessage(resEl, 'Procesando liquidaciones...');
      await _procesarLiquidacionesExec(resEl);
    }
  );
}

async function _procesarLiquidacionesExec(resEl) {
  try {
    const res  = await apiFetch('/api/liquidaciones/procesar', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { resEl.style.color='var(--red)'; resEl.innerHTML=esc(data.detail||'Error'); return; }
    resEl.style.color='var(--green)'; resEl.innerHTML=esc(data.mensaje||`${data.liquidadas} liquidadas.`);
    await cargarLiquidaciones();
  } catch(e) { resEl.style.color='var(--red)'; resEl.innerHTML=esc(e.message); }
}


// ═══════════════════════════════════════════════════════════════════════════
// ── BLOTTER DEL DÍA (Feature 10) ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

let _blotterData = [];

async function cargarBlotter(showSpinner = true) {
  const tbody   = document.getElementById('blotterBody');
  const fechaEl = document.getElementById('blotterFecha');

  if (fechaEl && !fechaEl.value) {
    fechaEl.value = new Date().toISOString().slice(0, 10);
  }

  if (showSpinner && tbody) {
    _showSkeleton('blotterBody', 13);
  }

  const params = new URLSearchParams();
  if (fechaEl && fechaEl.value) params.set('fecha', fechaEl.value);

  try {
    const res  = await apiFetch(`/api/ordenes/blotter?${params}`);
    const data = await res.json();
    _blotterData = data.ordenes || [];

    // Populate operator dropdown
    const opEl = document.getElementById('blotterOperador');
    if (opEl) {
      const ops = [...new Set(_blotterData.map(o => o.usuario || 'sistema').filter(Boolean))].sort();
      const prev = opEl.value;
      opEl.innerHTML = '<option value="">Todos</option>' + ops.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
      if (prev && ops.includes(prev)) opEl.value = prev;
    }

    filtrarBlotter();
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr class="loading-row"><td colspan="13">Error al cargar blotter.</td></tr>';
  }
}

function filtrarBlotter() {
  const operador      = document.getElementById('blotterOperador')?.value || '';
  const especieFiltro = (document.getElementById('blotterEspecieFiltro')?.value || '').toUpperCase().trim();
  const deskFiltro    = document.getElementById('blotterDesk')?.value || '';
  const estado        = document.getElementById('blotterEstado')?.value || '';

  let data = _blotterData;
  if (operador)      data = data.filter(o => (o.usuario || 'sistema') === operador);
  if (especieFiltro) data = data.filter(o => o.especie.includes(especieFiltro));
  if (deskFiltro)    data = data.filter(o => o.desk === deskFiltro);
  if (estado)        data = data.filter(o => o.estado_color === estado);

  renderBlotter(data);
}

const _filtrarBlotterDebounced = debounce(filtrarBlotter, 200);

// ── Blotter view toggle ─────────────────────────────────────────────────────
let _blotterView = 'tabla';   // 'tabla' | 'timeline'
// _blotterData declared above (line 5277) — last fetched dataset, used to re-render on toggle

function setBlotterView(mode) {
  _blotterView = mode;
  document.getElementById('btnBlotterTabla').classList.toggle('active', mode === 'tabla');
  document.getElementById('btnBlotterTimeline').classList.toggle('active', mode === 'timeline');
  document.getElementById('blotterViewTabla').style.display    = mode === 'tabla'    ? '' : 'none';
  document.getElementById('blotterViewTimeline').style.display = mode === 'timeline' ? '' : 'none';
  if (mode === 'timeline') _renderBlotterTimeline(_blotterData);
}

function _renderBlotterTimeline(ordenes) {
  const container = document.getElementById('blotterTimelineBody');
  if (!container) return;

  if (!ordenes.length) {
    container.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:20px 0">Sin operaciones para mostrar.</div>';
    return;
  }

  // Group by HH:MM hour (first 5 chars of o.hora "HH:MM:SS")
  const byHour = {};
  ordenes.forEach(o => {
    const h = (o.hora || '??:??').slice(0, 5);
    if (!byHour[h]) byHour[h] = [];
    byHour[h].push(o);
  });

  const hours = Object.keys(byHour).sort();
  container.innerHTML = hours.map(h => {
    const ops = byHour[h];
    const pills = ops.map(o => {
      const pct = o.progreso;
      const monto = o.precio_limite && o.cantidad_total
        ? fmt(o.precio_limite * (o.cantidad_neta || o.cantidad_total))
        : '—';
      return `<div class="btl-op op-${o.estado_color}" onclick="verDetalle(${o.id})" title="${esc(o.nro_orden)} — ${esc(o.cliente)}">
        <span class="btl-op-tipo">${esc(o.tipo_orden)}</span>
        <span class="btl-op-especie">${esc(o.especie)}</span>
        <span class="btl-op-monto">${monto}</span>
        <div class="progress-bar" style="width:36px;display:inline-block;vertical-align:middle">
          <div class="progress-fill ${pct>=100?'full':''}" style="width:${pct}%"></div>
        </div>
      </div>`;
    }).join('');
    return `<div class="btl-hour-block">
      <div class="btl-hour-label">${esc(h)}</div>
      <div class="btl-hour-ops">${pills}</div>
    </div>`;
  }).join('');
}

function renderBlotter(ordenes) {
  _blotterData = ordenes;  // cache for timeline re-render
  const tbody = document.getElementById('blotterBody');
  const info  = document.getElementById('blotterInfo');
  if (!tbody) return;

  if (_blotterView === 'timeline') {
    _renderBlotterTimeline(ordenes);
  }

  if (!ordenes.length) {
    tbody.innerHTML = _emptyStateHtml(
      [['Fecha','blotterFecha'],['Especie','blotterEspecieFiltro'],['Desk','blotterDesk'],['Estado','blotterEstado']],
      '_limpiarFiltrosBlotter', 13);
    if (info) info.textContent = '0 operaciones';
    return;
  }

  const colorDot = c => {
    if (c === 'green')  return '<span style="color:var(--green)">&#9679;</span>';
    if (c === 'orange') return '<span style="color:#f0a500">&#9679;</span>';
    return '<span style="color:var(--red)">&#9679;</span>';
  };

  tbody.innerHTML = ordenes.map(o => {
    const pct         = o.progreso;
    const tifBadge    = o.time_in_force !== 'DAY' ? `<span style="font-size:9px;background:var(--accent);color:#fff;border-radius:2px;padding:1px 3px;margin-left:3px">${esc(o.time_in_force)}</span>` : '';
    const condBadge   = o.tipo_activacion ? `<span style="font-size:9px;background:var(--border);border-radius:2px;padding:1px 3px;margin-left:2px" title="${esc(o.tipo_activacion)} @ ${o.precio_activacion}">${esc(o.tipo_activacion === 'STOP_LOSS' ? 'SL' : 'TP')}</span>` : '';
    const icebergBadge= o.cantidad_visible ? `<span style="font-size:9px;background:var(--border);border-radius:2px;padding:1px 3px;margin-left:2px" title="Iceberg: visible ${o.cantidad_visible}">ICE</span>` : '';
    const precioStr   = o.tipo_precio === 'MERCADO' ? '<span style="color:var(--accent);font-size:10px">MKT</span>' : fmt(o.precio_limite);
    const inactiveMark= o.activa === false ? ' style="opacity:0.6"' : '';

    const deskLabel = o.desk ? `<span style="font-size:9px;background:var(--bg4);border:1px solid var(--border);border-radius:2px;padding:1px 4px">${esc(o.desk)}</span>` : '<span style="color:var(--text3);font-size:10px">—</span>';
    return `<tr data-id="${o.id}" onclick="verDetalle(${o.id})"${inactiveMark}>
      <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(o.hora || '—')}</td>
      <td><span class="tipo-badge tipo-${o.tipo_orden}">${o.tipo_orden}</span></td>
      <td><span class="nro-cell">${o.nro_orden}</span>${condBadge}${icebergBadge}</td>
      <td style="font-size:11px;color:var(--text2)">${esc(o.usuario || 'sistema')}</td>
      <td>${deskLabel}</td>
      <td style="font-size:11px">${esc(o.cliente)}</td>
      <td>${_badgeEspecie(o.especie)}</td>
      <td class="precio-cell">${esc(o.moneda)}</td>
      <td class="precio-cell">${precioStr}</td>
      <td style="font-size:10px">${esc(o.time_in_force)}${tifBadge}</td>
      <td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill ${pct>=100?'full':''}" style="width:${pct}%"></div></div><div class="progress-pct">${pct}%</div></div></td>
      <td class="ejec-cell">${esc(o.ejecutado_total)}</td>
      <td>${colorDot(o.estado_color)}</td>
    </tr>`;
  }).join('');

  if (info) info.textContent = `${ordenes.length} operaci${ordenes.length !== 1 ? 'ones' : 'on'}`;
  _reapplySort(document.getElementById('blotterTable'));
}


// ═══════════════════════════════════════════════════════════════════════════
// ── CAJA EN TIEMPO REAL — PROYECCIÓN (Feature 12) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarProyeccion() {
  const cliente = document.getElementById('cajaProjCliente')?.value || 'STD';
  const moneda  = document.getElementById('cajaProjMoneda')?.value || 'ARP';
  const fmtARS  = v => Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  try {
    const res = await apiFetch(`/api/cuentas/proyeccion?cliente=${encodeURIComponent(cliente)}&moneda=${moneda}`);
    if (!res.ok) return;
    const d = await res.json();

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('kpi-saldo-actual', fmtARS(d.saldo_actual));
    set('kpi-comprometido', fmtARS(d.comprometido));
    set('kpi-saldo-libre',  fmtARS(d.saldo_proyectado));

    const libreCard = document.getElementById('kpi-libre-card');
    if (libreCard) libreCard.className = 'kpi-card ' + (d.alerta ? 'red' : 'green');

    const alertaEl = document.getElementById('cajaAlerta');
    if (alertaEl) alertaEl.style.display = d.alerta ? '' : 'none';

    const detalleEl = document.getElementById('cajaOrdenesDetalle');
    if (detalleEl) {
      if (!d.ordenes_pendientes.length) {
        detalleEl.innerHTML = '<span class="text-muted" style="font-size:11px">Sin ordenes de compra pendientes.</span>';
      } else {
        detalleEl.innerHTML = `
          <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px">Ordenes que componen el comprometido:</div>
          <table class="orders-table mini-table">
            <thead><tr><th>Nro. Orden</th><th>Especie</th><th>Tipo Precio</th><th>Precio Ref.</th><th>Cant. Pend.</th><th>Importe</th></tr></thead>
            <tbody>${d.ordenes_pendientes.map(o => `<tr>
              <td>${esc(o.nro_orden)}</td>
              <td>${_badgeEspecie(o.especie)}</td>
              <td>${esc(o.tipo_precio)}</td>
              <td class="precio-cell">${fmtARS(o.precio_ref)}</td>
              <td class="ejec-cell">${Number(o.qty_pendiente).toLocaleString('es-AR')}</td>
              <td class="precio-cell"><strong>${fmtARS(o.importe)}</strong></td>
            </tr>`).join('')}</tbody>
          </table>`;
      }
    }
  } catch (e) { showToast('Error al cargar proyección de caja.', 'error'); }
}


// ═══════════════════════════════════════════════════════════════════════════
// ── MÉTRICAS DE RIESGO DE CARTERA (Feature 13) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarMetricasRiesgo() {
  const cliente = document.getElementById('riesgoCartCliente')?.value || 'STD';
  const fmtARS  = v => Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  try {
    const res = await apiFetch(`/api/riesgo/cartera?cliente=${encodeURIComponent(cliente)}`);
    if (!res.ok) return;
    const d = await res.json();

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('kpi-valor-port', fmtARS(d.valor_portfolio_arp));
    set('kpi-duration',   d.duration_ponderada > 0 ? d.duration_ponderada.toFixed(2) : '—');
    set('kpi-dv01',       d.dv01_total > 0 ? fmtARS(d.dv01_total) : '—');
    set('kpi-var95',      fmtARS(d.var_95_1d));
    set('kpi-var-pct',    d.var_95_1d_pct > 0 ? d.var_95_1d_pct.toFixed(4) + '%' : '—');
    set('kpi-fx-delta',   d.sensibilidad_fx_1pct > 0 ? fmtARS(d.sensibilidad_fx_1pct) : '—');

    const detalleEl = document.getElementById('riesgoDetalleTable');
    if (!detalleEl) return;

    if (!d.posiciones.length) {
      detalleEl.innerHTML = '<span style="font-size:11px;color:var(--text3)">Sin posiciones largas activas.</span>';
      return;
    }

    detalleEl.innerHTML = `
      <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px">Detalle por posicion:</div>
      <table class="orders-table mini-table">
        <thead><tr>
          <th>Especie</th><th>Neto</th><th>Precio</th><th>Valor ARP</th>
          <th>Duration</th><th>DV01</th><th>VaR 95% 1D</th><th>sigma d.</th><th>Dias hist.</th>
        </tr></thead>
        <tbody>${d.posiciones.map(p => `<tr>
          <td>${_badgeEspecie(p.especie)}</td>
          <td class="ejec-cell">${Number(p.cantidad_neta).toLocaleString('es-AR')}</td>
          <td class="precio-cell">${fmtARS(p.precio_mercado)}</td>
          <td class="precio-cell">${fmtARS(p.valor_arp)}</td>
          <td class="precio-cell">${p.duration != null ? p.duration.toFixed(2) : '—'}</td>
          <td class="precio-cell">${p.dv01 != null ? fmtARS(p.dv01) : '—'}</td>
          <td class="precio-cell">${fmtARS(p.var_95_1d)}</td>
          <td class="precio-cell">${p.sigma.toFixed(4)}%</td>
          <td style="color:var(--text3);font-size:11px">${p.dias_historicos > 0 ? p.dias_historicos : 'proxy'}</td>
        </tr>`).join('')}</tbody>
      </table>
      <div style="font-size:10px;color:var(--text3);margin-top:6px">
        VaR calculado con correlaciones = 0. TC USD: $${d.tc_usd_usado}. Portfolio VaR = raiz(Sum VaR_i^2).
      </div>`;
  } catch (e) { showToast('Error al cargar métricas de riesgo.', 'error'); }
}


// ═══════════════════════════════════════════════════════════════════════════
// ── OPERADORES / DESKS (Feature 15) ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarOperadores() {
  await _cargarTabla('operadoresBody', 7, async (tbody) => {
    const res = await apiFetch('/api/operadores');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const ops = d.operadores || [];
    if (!ops.length) { tbody.innerHTML = _emptyTableRow(7, 'Sin operadores registrados.'); return; }
    tbody.innerHTML = ops.map(o => `<tr data-op-id="${o.id}" data-op-nombre="${esc(o.nombre)}" data-op-desk="${esc(o.desk)}" data-op-cliente="${esc(o.cliente_codigo || '')}">
      <td style="font-size:11px;color:var(--text3)">${o.id}</td>
      <td>${esc(o.nombre)}</td>
      <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(o.username)}</td>
      <td><span style="font-size:10px;font-weight:700;background:var(--bg4);border:1px solid var(--border);border-radius:2px;padding:2px 6px">${esc(o.desk)}</span></td>
      <td style="font-size:11px;color:var(--text2)">${o.cliente_codigo ? esc(o.cliente_codigo) : '<span style="color:var(--text3)">—</span>'}</td>
      <td><span style="color:${o.activo ? 'var(--green)' : 'var(--red)'};font-size:11px">${o.activo ? 'Activo' : 'Inactivo'}</span></td>
      <td><button class="btn-mini" onclick="abrirModalOperador(${o.id})">Editar</button></td>
    </tr>`).join('');
  });
}

let _editOpData = null;

async function abrirModalOperador(editId = null) {
  _editOpData = editId;
  const title = document.getElementById('modalOperadorTitle');
  const idInp = document.getElementById('opId');
  const resEl = document.getElementById('opResult');
  if (title) title.textContent = editId ? 'Editar Operador' : 'Nuevo Operador';
  if (idInp) idInp.value = editId || '';
  if (resEl) resEl.textContent = '';
  const opModal = document.getElementById('modalOperador');
  if (opModal) _clearFieldErrors(opModal);

  // Populate client select with current list
  _poblarSelectClientes(document.getElementById('opClienteCodigo'), null);

  if (!editId) {
    ['opNombre', 'opUsername'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('opDesk').value = 'ACCIONES';
  } else {
    // Pre-fill from data attributes stored on the row
    const row = document.querySelector(`#operadoresBody tr[data-op-id="${editId}"]`);
    if (row) {
      document.getElementById('opNombre').value = row.dataset.opNombre || '';
      document.getElementById('opDesk').value   = row.dataset.opDesk   || 'ACCIONES';
      const sel = document.getElementById('opClienteCodigo');
      if (sel) sel.value = row.dataset.opCliente || '';
    }
  }
  document.getElementById('modalOperador').classList.add('active');
}

function cerrarModalOperador(event) {
  if (!event || event.target === document.getElementById('modalOperador')) {
    document.getElementById('modalOperador').classList.remove('active');
  }
}

async function guardarOperador(btn) {
  const editId        = document.getElementById('opId').value;
  const nombre        = document.getElementById('opNombre').value.trim();
  const username      = document.getElementById('opUsername').value.trim();
  const desk          = document.getElementById('opDesk').value;
  const clienteCodigo = document.getElementById('opClienteCodigo')?.value || null;
  const resEl         = document.getElementById('opResult');
  const modal         = document.getElementById('modalOperador');
  if (modal) _clearFieldErrors(modal);
  if (resEl) resEl.textContent = '';

  let hasError = false;
  if (!nombre) { _setFieldError('opNombre', 'El nombre es requerido.'); hasError = true; }
  if (!editId && !username) { _setFieldError('opUsername', 'El username es requerido.'); hasError = true; }
  if (hasError) return;

  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    let res;
    if (editId) {
      res = await apiFetch(`/api/operadores/${editId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, desk, cliente_codigo: clienteCodigo || null }),
      });
    } else {
      res = await apiFetch('/api/operadores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, username, desk, cliente_codigo: clienteCodigo || null }),
      });
    }
    if (res.ok) {
      document.getElementById('modalOperador').classList.remove('active');
      cargarOperadores();
      showToast(editId ? 'Operador actualizado.' : 'Operador creado.', 'ok');
    } else {
      const err = await res.json().catch(() => ({}));
      if (resEl) resEl.innerHTML = `<span style="color:var(--red)">${esc(err.detail || 'Error al guardar.')}</span>`;
    }
  } catch(e) {
    if (resEl) resEl.innerHTML = `<span style="color:var(--red)">${esc(e.message || 'Error de conexión.')}</span>`;
  } finally {
    if (btn) { btn.disabled = false; if (origText) btn.textContent = origText; }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// ── P&L POR DESK (Feature 15) ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarPnlPorDesk() {
  await _cargarTabla('pnlDeskBody', 7, async (tbody) => {
    const fecha = document.getElementById('pnlDeskFecha')?.value || new Date().toISOString().slice(0, 10);
    const res = await apiFetch(`/api/pnl/por-desk?fecha=${fecha}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const desks = d.desks || [];
    if (!desks.length) { tbody.innerHTML = _emptyTableRow(7, `Sin datos P&L para ${esc(fecha)}.`); return; }
    tbody.innerHTML = desks.map(dk => {
      const totalColor = dk.pnl_total >= 0 ? 'var(--green)' : 'var(--red)';
      return `<tr>
        <td><span style="font-size:10px;font-weight:700;background:var(--bg4);border:1px solid var(--border);border-radius:2px;padding:2px 6px">${esc(dk.desk)}</span></td>
        <td style="text-align:right;color:${dk.pnl_realizado >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(dk.pnl_realizado)}</td>
        <td style="text-align:right;color:${dk.pnl_no_realizado >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(dk.pnl_no_realizado)}</td>
        <td style="text-align:right;color:${totalColor};font-weight:700">${fmt(dk.pnl_total)}</td>
        <td style="text-align:right">${fmt(dk.volumen_comprado)}</td>
        <td style="text-align:right">${fmt(dk.volumen_vendido)}</td>
        <td style="text-align:right;color:var(--text3)">${dk.n_posiciones}</td>
      </tr>`;
    }).join('');
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// ── VALUACIÓN DE PRECIOS (Feature 16) ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarPreciosHistorico() {
  await _cargarTabla('preciosHistBody', 5, async (tbody) => {
    const especie = (document.getElementById('vpFiltroEspecie')?.value || '').trim().toUpperCase();
    const tipo    = document.getElementById('vpFiltroTipo')?.value || '';
    const desde   = document.getElementById('vpFiltroDesde')?.value || '';
    const hasta   = document.getElementById('vpFiltroHasta')?.value || '';
    const params = new URLSearchParams();
    if (especie) params.set('especie', especie);
    if (tipo)    params.set('precio_tipo', tipo);
    if (desde)   params.set('fecha_desde', desde);
    if (hasta)   params.set('fecha_hasta', hasta);
    const res = await apiFetch(`/api/prices/historico?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const rows = d.precios || [];
    if (!rows.length) { tbody.innerHTML = _emptyTableRow(5, 'Sin resultados.'); return; }
    const fmtP6 = v => Number(v).toLocaleString('es-AR', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
    const tipoBadge = t => {
      const colors = { AJUSTE: '#4a9eff', CORTE_MAE: '#f0a500', CIERRE: 'var(--text3)' };
      return `<span style="font-size:9px;font-weight:700;color:#fff;background:${colors[t]||'var(--border)'};border-radius:2px;padding:1px 4px">${esc(t)}</span>`;
    };
    tbody.innerHTML = rows.map(r => `<tr>
      <td style="font-size:11px">${esc(r.fecha)}</td>
      <td>${_badgeEspecie(r.especie)}</td>
      <td class="precio-cell">${fmtP6(r.precio)}</td>
      <td>${tipoBadge(r.precio_tipo)}</td>
      <td style="font-size:11px;color:var(--text3)">${esc(r.fuente)}</td>
    </tr>`).join('');
  });
}

async function registrarCierreAjuste() {
  const especie = (document.getElementById('vpEspecie')?.value || '').trim().toUpperCase();
  const precio  = parseFloat(document.getElementById('vpPrecio')?.value || '0');
  const fecha   = document.getElementById('vpFecha')?.value || '';
  const tipo    = document.getElementById('vpTipo')?.value || 'AJUSTE';
  const fuente  = document.getElementById('vpFuente')?.value || 'manual';
  const resEl   = document.getElementById('vpResult');

  if (!especie || !precio || !fecha) {
    if (resEl) resEl.innerHTML = '<span style="color:var(--red)">Completá todos los campos (especie, precio, fecha).</span>';
    return;
  }
  if (resEl) resEl.innerHTML = '<span style="color:var(--text3)">Guardando...</span>';
  try {
    const res = await apiFetch('/api/prices/cierre-ajuste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ especie, precio, fecha, precio_tipo: tipo, fuente }),
    });
    const d = await res.json();
    if (res.ok && d.success) {
      if (resEl) resEl.innerHTML = `<span style="color:var(--green)">✓ ${esc(d.especie)} ${esc(d.precio_tipo)} ${esc(d.fecha)}: $${d.precio}</span>`;
      cargarPreciosHistorico();
    } else {
      if (resEl) resEl.innerHTML = `<span style="color:var(--red)">${esc(d.detail || 'Error al guardar.')}</span>`;
    }
  } catch (e) {
    if (resEl) resEl.innerHTML = '<span style="color:var(--red)">Error de red.</span>';
  }
}

async function snapshotPrecios() {
  const resEl = document.getElementById('vpResult');
  if (resEl) resEl.innerHTML = '<span style="color:var(--text3)">Ejecutando snapshot...</span>';
  try {
    const res = await apiFetch('/api/prices/snapshot', { method: 'POST' });
    const d = await res.json();
    if (res.ok && d.success) {
      if (resEl) resEl.innerHTML = `<span style="color:var(--green)">✓ Snapshot completado: ${d.nuevos} precios nuevos guardados para ${esc(d.fecha)}.</span>`;
      cargarPreciosHistorico();
    } else {
      if (resEl) resEl.innerHTML = `<span style="color:var(--red)">${esc(d.detail || 'Error en snapshot.')}</span>`;
    }
  } catch (e) {
    if (resEl) resEl.innerHTML = '<span style="color:var(--red)">Error de red.</span>';
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// SEGUIDOS (Watchlist) -> moved to views/seguidos.js
