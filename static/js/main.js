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


// ══════════════════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════════════════════════════════════

// ── Admin sub-tab switching ──────────────────────────────────────────────────
function switchAdminTab(tab) {
  // Cancel any in-flight API requests from the previous tab
  state.navController?.abort();
  state.navController = new AbortController();

  document.querySelectorAll('.admin-sidebar .admin-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.admin-tab-content').forEach(d => {
    d.classList.toggle('active', d.id === `admin-tab-${tab}`);
  });
  // Lazy load on first switch
  if (tab === 'usuarios')      cargarUsuarios();
  if (tab === 'clientes')      cargarClientesAdmin();
  if (tab === 'tickers')       cargarTickersAdmin();
  if (tab === 'bot')           cargarBots();
  if (tab === 'sistema')       cargarConfigSistema();
  if (tab === 'instrumentos')  cargarInstrumentos();
  if (tab === 'tc')            cargarTcActual();
  if (tab === 'reportes')      inicializarFechasReportes();
  if (tab === 'contrapartes')  cargarContrapartes();
  if (tab === 'riesgo')        cargarLimites();
  if (tab === 'liquidaciones') cargarLiquidaciones();
  if (tab === 'operadores')    cargarOperadores();
  if (tab === 'val-precios')  { const hoy = new Date().toISOString().slice(0,10); const el = document.getElementById('vpFecha'); if (el && !el.value) el.value = hoy; }
  if (tab === 'pnl') {
    const hoy = new Date().toISOString().slice(0,10);
    const d = document.getElementById('pnlFechaDesde'); if (d && !d.value) d.value = hoy;
    const h = document.getElementById('pnlFechaHasta'); if (h && !h.value) h.value = hoy;
    const desk = document.getElementById('pnlDeskFecha'); if (desk && !desk.value) desk.value = hoy;
  }
  if (tab === 'firma')         cargarFirma();
  if (tab === 'cuentas-op')    cargarCuentasOperadores();
  if (tab === 'auditoria')       cargarAuditoria();
  if (tab === 'alertas-usuario') cargarAlertas();
}

// ── Firma ─────────────────────────────────────────────────────────────────────

let _firmaMovPag = 1;

async function cargarFirma(page = 1) {
  _firmaMovPag = page;
  const moneda = document.getElementById('firmaMoneda')?.value || 'ARP';

  // KPIs
  try {
    const res  = await apiFetch('/api/firma/saldo');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saldo = await res.json();
    const kpiEl = document.getElementById('firma-kpis');
    if (kpiEl) {
      const bloque = (saldo.saldo || []).find(b => b.moneda === moneda);
      const total     = bloque?.balance_total     ?? 0;
      const disp      = bloque?.balance_disponible ?? 0;
      const cap       = bloque?.cuentas?.[0]?.capital_inicial ?? 0;
      const pnl       = total - cap;
      const fmt = v => v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const colorPnl  = pnl >= 0 ? 'var(--buy,#4caf50)' : 'var(--sell,#e05c5c)';
      kpiEl.innerHTML = `
        <div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:12px">
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px">SALDO TOTAL ${moneda}</div>
          <div style="font-size:18px;font-weight:700">${fmt(total)}</div>
        </div>
        <div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:12px">
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px">DISPONIBLE</div>
          <div style="font-size:18px;font-weight:700">${fmt(disp)}</div>
        </div>
        <div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:12px">
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px">CAPITAL INICIAL</div>
          <div style="font-size:18px;font-weight:700">${fmt(cap)}</div>
        </div>
        <div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:12px">
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px">P&L IMPL.</div>
          <div style="font-size:18px;font-weight:700;color:${colorPnl}">${pnl >= 0 ? '+' : ''}${fmt(pnl)}</div>
        </div>`;
    }
  } catch(e) { /* KPI rendering failed — firma still shows */ }

  // Movimientos
  const tbody = document.getElementById('firmaMovBody');
  if (tbody) _setTbodyLoading(tbody, 7);
  try {
    const res = await apiFetch(`/api/firma/movimientos?page=${page}&per_page=${MOV_PER_PAGE}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!tbody) return;
    if (!data.entries?.length) {
      tbody.innerHTML = _emptyTableRow(7, 'Sin movimientos.');
    } else {
      tbody.innerHTML = data.entries.map(e => {
        const color = e.sentido === 'CREDIT' ? 'var(--buy,#4caf50)' : 'var(--sell,#e05c5c)';
        const sign  = e.sentido === 'CREDIT' ? '+' : '−';
        const monto = parseFloat(e.monto || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
        const bal   = parseFloat(e.balance_post || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
        const fecha = _fmtDatetime(e.created_at);
        return `<tr>
          <td style="font-size:10px">${fecha}</td>
          <td><span class="badge">${e.tipo}</span></td>
          <td style="color:${color};font-weight:700">${e.sentido}</td>
          <td style="text-align:right;color:${color}">${sign}${monto}</td>
          <td style="text-align:right">${bal}</td>
          <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.descripcion||''}">${e.descripcion || '—'}</td>
          <td style="font-size:10px">${e.usuario || '—'}</td>
        </tr>`;
      }).join('');
    }
    // Pagination
    const pagEl = document.getElementById('firmaPagBar');
    if (pagEl) {
      const pages = data.pages || 1;
      pagEl.innerHTML = pages > 1
        ? Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<button data-action="cargar-firma" data-page="${p}" style="margin:0 2px;padding:2px 7px;${p===page?'font-weight:700;text-decoration:underline':''}">${p}</button>`
          ).join('')
        : '';
    }
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-muted">Error al cargar: ${esc(e.message)}</td></tr>`;
  }

  // Posiciones
  cargarPosicionesFirma();
}

async function cargarPosicionesFirma() {
  await _cargarTabla('firmaPosBody', 7, async (tbody) => {
    const res = await apiFetch('/api/firma/posiciones');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.posiciones?.length) { tbody.innerHTML = _emptyTableRow(7, 'Sin posiciones.'); return; }
    const fmtP4 = v => v == null ? '—' : parseFloat(v).toLocaleString('es-AR', { minimumFractionDigits: 4 });
    tbody.innerHTML = data.posiciones.map(p => `<tr>
      <td><strong>${p.especie}</strong></td>
      <td>${p.mercado || '—'}</td>
      <td style="text-align:right">${(p.cantidad_comprada||0).toLocaleString('es-AR')}</td>
      <td style="text-align:right">${(p.cantidad_vendida||0).toLocaleString('es-AR')}</td>
      <td style="text-align:right;font-weight:700;color:${(p.cantidad_neta||0)>=0?'var(--buy,#4caf50)':'var(--sell,#e05c5c)'}">${(p.cantidad_neta||0).toLocaleString('es-AR')}</td>
      <td style="text-align:right">${fmtP4(p.costo_promedio_compra)}</td>
      <td style="text-align:right">${(p.cantidad_pendiente_liquidacion||0).toLocaleString('es-AR')}</td>
    </tr>`).join('');
  });
}

// ── Cuentas Operadores ────────────────────────────────────────────────────────

let _opMovActual = null;  // operador id cuya detail está visible

async function cargarCuentasOperadores() {
  await _cargarTabla('cuentasOpBody', 6, async (tbody) => {
    const res = await apiFetch('/api/cuentas/operadores');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.operadores?.length) { tbody.innerHTML = _emptyTableRow(6, 'No hay operadores registrados.'); return; }
    tbody.innerHTML = data.operadores.map(row => {
      const op      = row.operador;
      const cuenta  = row.cuenta;
      const saldo   = cuenta ? fmt(cuenta.balance_cache) : '—';
      const disp    = cuenta ? fmt((cuenta.balance_cache||0) - (cuenta.balance_reservado||0)) : '—';
      const saldoColor = cuenta && parseFloat(cuenta.balance_cache) < 0 ? 'color:var(--sell,#e05c5c)' : '';
      return `<tr>
        <td><strong>${op.nombre}</strong></td>
        <td style="font-size:10px">${op.username}</td>
        <td><span class="badge">${op.desk}</span></td>
        <td style="text-align:right;${saldoColor}">${saldo}</td>
        <td style="text-align:right">${disp}</td>
        <td>
          <button class="btn-refresh" style="padding:2px 7px;font-size:10px;margin-right:3px" data-action="abrir-modal-cuenta-dep" data-id="${op.id}" data-nombre="${esc(op.nombre)}" title="Depositar">+ Dep.</button>
          <button class="btn-refresh" style="padding:2px 7px;font-size:10px;margin-right:3px;background:var(--sell,#e05c5c);border-color:var(--sell,#e05c5c)" data-action="abrir-modal-cuenta-ret" data-id="${op.id}" data-nombre="${esc(op.nombre)}" title="Retirar">− Ret.</button>
          <button class="btn-refresh" style="padding:2px 7px;font-size:10px" data-action="ver-movimientos-op" data-id="${op.id}" data-nombre="${esc(op.nombre)}" title="Ver movimientos">Movim.</button>
        </td>
      </tr>`;
    }).join('');
  });
}

async function verMovimientosOp(opId, nombre, page = 1) {
  _opMovActual = opId;
  const panel = document.getElementById('opMovPanel');
  const title = document.getElementById('opMovTitle');
  const tbody = document.getElementById('opMovBody');
  if (!panel || !tbody) return;
  panel.style.display = '';
  if (title) title.textContent = `Movimientos — ${nombre}`;
  _setTbodyLoading(tbody, 7);
  try {
    const data = await apiFetch(`/api/cuentas/operadores/${opId}/movimientos?page=${page}&per_page=${MOV_PER_PAGE}`).then(r => r.json());
    if (!data.entries?.length) {
      tbody.innerHTML = _emptyTableRow(7, 'Sin movimientos.');
    } else {
      tbody.innerHTML = data.entries.map(e => {
        const color = e.sentido === 'CREDIT' ? 'var(--buy,#4caf50)' : 'var(--sell,#e05c5c)';
        const sign  = e.sentido === 'CREDIT' ? '+' : '−';
        const monto = parseFloat(e.monto || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
        const bal   = parseFloat(e.balance_post || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
        const fecha = _fmtDatetime(e.created_at);
        return `<tr>
          <td style="font-size:10px">${fecha}</td>
          <td><span class="badge">${e.tipo}</span></td>
          <td style="color:${color};font-weight:700">${e.sentido}</td>
          <td style="text-align:right;color:${color}">${sign}${monto}</td>
          <td style="text-align:right">${bal}</td>
          <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.descripcion||''}">${e.descripcion || '—'}</td>
          <td style="font-size:10px">${e.usuario || '—'}</td>
        </tr>`;
      }).join('');
    }
    const pagEl = document.getElementById('opMovPagBar');
    if (pagEl) {
      const pages = data.pages || 1;
      pagEl.innerHTML = pages > 1
        ? Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<button data-action="ver-movimientos-op" data-id="${opId}" data-nombre="${esc(nombre)}" data-page="${p}" style="margin:0 2px;padding:2px 7px;${p===page?'font-weight:700;text-decoration:underline':''}">${p}</button>`
          ).join('')
        : '';
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted">Error al cargar movimientos.</td></tr>`;
  }
}

function recargarMovOp() {
  if (_opMovActual) {
    const title = document.getElementById('opMovTitle')?.textContent || '';
    const nombre = title.replace('Movimientos — ', '');
    verMovimientosOp(_opMovActual, nombre);
  }
}

// ── Auditoría ─────────────────────────────────────────────────────────────────

// ── ALERTAS USUARIO ─────────────────────────────────────────────────────────
async function cargarAlertas() {
  const tbody = document.getElementById('alertasBody');
  if (!tbody) return;
  _showSkeleton('alertasBody', 8, 4);
  try {
    const res = await apiFetch('/api/alertas');
    if (!res.ok) { tbody.innerHTML = _emptyTableRow(8, 'Error cargando alertas.'); return; }
    const rows = await res.json();
    if (!rows.length) {
      tbody.innerHTML = _emptyTableRow(8, 'Sin alertas configuradas.');
      return;
    }
    const LABEL = { ORDEN_MONTO: 'Orden Monto', POSICION_CAIDA: 'Pos. Caída P&L', POSICION_SUBE: 'Pos. Suba P&L', VOLUMEN_CLIENTE: 'Vol. Cliente' };
    tbody.innerHTML = rows.map(a => `
      <tr>
        <td style="font-size:11px;font-weight:600">${esc(LABEL[a.tipo] || a.tipo)}</td>
        <td class="precio-cell">${fmt(a.umbral)}</td>
        <td class="precio-cell">${esc(a.moneda)}</td>
        <td>${a.cliente ? esc(a.cliente) : '<span style="color:var(--text3)">Todos</span>'}</td>
        <td>${_badgeEspecie(a.especie)}</td>
        <td>
          <label class="toggle-switch" title="${a.activo ? 'Activa — click para pausar' : 'Pausada — click para activar'}">
            <input type="checkbox" ${a.activo ? 'checked' : ''} onchange="toggleAlerta(${a.id}, this)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td style="font-size:10px;color:var(--text3)">${_fmtDatetime(a.ultima_vez)}</td>
        <td>
          <button class="btn-danger" style="font-size:10px;padding:2px 8px" data-action="eliminar-alerta" data-id="${a.id}" aria-label="Eliminar alerta">✕</button>
        </td>
      </tr>`).join('');
  } catch { tbody.innerHTML = _emptyTableRow(8, 'Error de red.'); }
}

async function guardarAlerta() {
  const msg = document.getElementById('alertaFormMsg');
  const payload = {
    tipo:    document.getElementById('alerta-tipo').value,
    umbral:  document.getElementById('alerta-umbral').value,
    moneda:  document.getElementById('alerta-moneda').value,
    cliente: document.getElementById('alerta-cliente').value.trim(),
    especie: document.getElementById('alerta-especie').value.trim().toUpperCase(),
  };
  if (!payload.umbral || Number(payload.umbral) <= 0) {
    if (msg) { msg.textContent = 'El umbral debe ser > 0.'; msg.style.color = 'var(--red)'; }
    return;
  }
  try {
    const res = await _apiFetchJson('/api/alertas', 'POST', payload);
    if (!res.ok) {
      const err = await res.json();
      if (msg) { msg.textContent = err.detail || 'Error al crear alerta.'; msg.style.color = 'var(--red)'; }
      return;
    }
    if (msg) { msg.textContent = 'Alerta creada correctamente.'; msg.style.color = 'var(--green)'; setTimeout(() => { msg.textContent = ''; }, 3000); }
    document.getElementById('alerta-umbral').value = '';
    document.getElementById('alerta-cliente').value = '';
    document.getElementById('alerta-especie').value = '';
    cargarAlertas();
  } catch { if (msg) { msg.textContent = 'Error de red.'; msg.style.color = 'var(--red)'; } }
}

async function toggleAlerta(id, checkbox) {
  const estadoPrevio = checkbox ? !checkbox.checked : null;
  try {
    await apiFetch(`/api/alertas/${id}/toggle`, { method: 'PATCH' });
    cargarAlertas();
  } catch(e) {
    if (checkbox && estadoPrevio !== null) checkbox.checked = estadoPrevio;
    showToast('No se pudo cambiar el estado de la alerta.', 'error');
  }
}

async function eliminarAlerta(id) {
  _confirmar(
    'Eliminar Alerta',
    '¿Eliminar esta alerta? Esta acción no se puede deshacer.',
    async () => {
      try {
        await apiFetch(`/api/alertas/${id}`, { method: 'DELETE' });
        showToast('Alerta eliminada.', 'ok');
        cargarAlertas();
      } catch(e) {
        showToast('No se pudo eliminar la alerta.', 'error');
      }
    }
  );
}

let _auditPage = 1;
let _auditTotalPages = 1;

function resetAuditPage() { _auditPage = 1; cargarAuditoria(); }

async function cargarAuditoria() {
  const tbody = document.getElementById('auditBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 5);
  const tabla    = document.getElementById('auditTablaFiltro')?.value.trim() || '';
  const op       = document.getElementById('auditOpFiltro')?.value || '';
  const perPage  = document.getElementById('auditPerPage')?.value || '50';
  const params   = new URLSearchParams();
  if (tabla) params.set('tabla', tabla);
  if (op)    params.set('operacion', op);
  params.set('page', _auditPage);
  params.set('per_page', perPage);
  try {
    const res = await apiFetch(`/api/audit?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _auditTotalPages = data.pages || 1;
    _auditPage       = data.current_page || 1;

    const totalEl = document.getElementById('auditTotal');
    if (totalEl) {
      totalEl.textContent = _calcularPaginacion(_auditPage, parseInt(perPage), data.total, 'registros').text;
    }

    renderAuditPagBar(data.current_page, data.pages);

    if (!data.logs.length) {
      tbody.innerHTML = _emptyTableRow(5, 'Sin registros para los filtros seleccionados.');
      return;
    }
    const opColor = { CREATE: 'var(--buy,#4caf50)', UPDATE: 'var(--text2)', CANCEL: 'var(--sell,#e05c5c)', EXECUTE: 'var(--accent)' };
    tbody.innerHTML = data.logs.map(r => {
      const color = opColor[r.operacion] || 'var(--text2)';
      return `<tr>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${r.timestamp || '—'}</td>
        <td>${esc(r.tabla)}</td>
        <td style="font-weight:600;color:${color}">${esc(r.operacion)}</td>
        <td style="font-family:'IBM Plex Mono',monospace">${r.record_id}</td>
        <td>${esc(r.usuario || '—')}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-muted">Error: ${esc(e.message)}</td></tr>`;
  }
}

function renderAuditPagBar(page, pages) {
  const bar = document.getElementById('auditPagBar');
  if (!bar || pages <= 1) { if (bar) bar.innerHTML = ''; return; }
  let btns = `<button class="page-btn" data-action="go-audit-page" data-page="${page-1}" ${page<=1?'disabled':''}>‹ Ant.</button>`;
  const start = Math.max(1, page - 2);
  const end   = Math.min(pages, page + 2);
  if (start > 1) btns += `<button class="page-btn" data-action="go-audit-page" data-page="1">1</button>${start > 2 ? '<span style="padding:0 4px">…</span>' : ''}`;
  for (let p = start; p <= end; p++) {
    btns += `<button class="page-btn ${p === page ? 'active' : ''}" data-action="go-audit-page" data-page="${p}">${p}</button>`;
  }
  if (end < pages) btns += `${end < pages - 1 ? '<span style="padding:0 4px">…</span>' : ''}<button class="page-btn" data-action="go-audit-page" data-page="${pages}">${pages}</button>`;
  btns += `<button class="page-btn" data-action="go-audit-page" data-page="${page+1}" ${page>=pages?'disabled':''}>Sig. ›</button>`;
  bar.innerHTML = btns;
}

function goAuditPage(p) {
  if (p < 1 || p > _auditTotalPages) return;
  _auditPage = p;
  cargarAuditoria();
}

// ── Modal depositar / retirar (firma y operadores) ────────────────────────────

function abrirModalCuenta(contexto, sentido, opId = null, opNombre = '') {
  document.getElementById('mcContexto').value = contexto;
  document.getElementById('mcSentido').value  = sentido;
  document.getElementById('mcOpId').value     = opId || '';
  document.getElementById('mcMonto').value    = '';
  document.getElementById('mcDescripcion').value = '';
  document.getElementById('mcResult').textContent = '';
  _clearFieldErrors(document.getElementById('modalCuenta'));

  const esDebit = sentido === 'DEBIT';
  const btn = document.getElementById('mcBtnConfirmar');
  if (btn) {
    btn.textContent = esDebit ? 'Confirmar Retiro' : 'Confirmar Depósito';
    btn.style.background = esDebit ? 'var(--sell,#e05c5c)' : '';
    btn.style.borderColor = esDebit ? 'var(--sell,#e05c5c)' : '';
  }

  const titulo = document.getElementById('modalCuentaTitulo');
  const subtit = document.getElementById('modalCuentaSubtitulo');
  if (contexto === 'firma') {
    if (titulo) titulo.textContent = esDebit ? 'Retirar de la Firma' : 'Depositar a la Firma';
    if (subtit) subtit.textContent = 'Cuenta corriente STD — Cartera Propia';
    // sync moneda with the tab selector
    const monFirma = document.getElementById('firmaMoneda')?.value || 'ARP';
    document.getElementById('mcMoneda').value = monFirma;
  } else {
    if (titulo) titulo.textContent = esDebit ? `Retirar de ${opNombre}` : `Depositar a ${opNombre}`;
    if (subtit) subtit.textContent = `Operador ID ${opId}`;
    document.getElementById('mcMoneda').value = 'ARP';
  }

  document.getElementById('modalCuenta').classList.add('active');
  setTimeout(() => document.getElementById('mcMonto')?.focus(), 80);
}

function cerrarModalCuenta(event) {
  if (event && event.target !== document.getElementById('modalCuenta')) return;
  document.getElementById('modalCuenta').classList.remove('active');
}

async function confirmarModalCuenta() {
  const contexto = document.getElementById('mcContexto').value;
  const sentido  = document.getElementById('mcSentido').value;
  const opId     = document.getElementById('mcOpId').value;
  const monto    = parseFloat(document.getElementById('mcMonto').value);
  const moneda   = document.getElementById('mcMoneda').value;
  const desc     = document.getElementById('mcDescripcion').value.trim();
  const resultEl = document.getElementById('mcResult');
  const modal    = document.getElementById('modalCuenta');

  // Limpiar errores previos antes de revalidar
  _clearFieldErrors(modal);
  resultEl.textContent = '';

  let hasError = false;
  if (!monto || monto <= 0) {
    _setFieldError('mcMonto', 'Ingresá un monto válido.');
    hasError = true;
  }
  if (desc.length < 5) {
    _setFieldError('mcDescripcion', 'Debe tener al menos 5 caracteres.');
    hasError = true;
  }
  if (hasError) return;

  const endpoint = contexto === 'firma'
    ? `/api/firma/${sentido === 'CREDIT' ? 'deposito' : 'retiro'}`
    : `/api/cuentas/operadores/${opId}/${sentido === 'CREDIT' ? 'deposito' : 'retiro'}`;

  const btn = document.getElementById('mcBtnConfirmar');
  if (btn) btn.disabled = true;
  resultEl.textContent = 'Procesando...';

  try {
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monto, moneda, descripcion: desc }),
    });
    const data = await res.json();
    if (!res.ok) {
      resultEl.textContent = `✗ ${data.detail || 'Error al procesar.'}`;
    } else {
      resultEl.textContent = '';
      document.getElementById('modalCuenta').classList.remove('active');
      // Refresh the relevant tab
      if (contexto === 'firma') {
        cargarFirma(_firmaMovPag);
      } else {
        cargarCuentasOperadores();
        if (_opMovActual == opId) recargarMovOp();
      }
    }
  } catch(e) {
    resultEl.textContent = '✗ Error de conexión.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function inicializarFechasReportes() {
  const hoy = new Date().toISOString().slice(0, 10);
  ['rptCnvFecha', 'rptBcraFecha', 'rptUifFecha'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = hoy;
  });
}

function filtrarPorEstado(color) {
  const sel = document.getElementById('filtroEstado');
  if (sel) sel.value = color;
  setView('ordenes');
  cargarOrdenes();
}

// ── Collapsible panels ────────────────────────────────────────────────────────
function initCollapsiblePanels() {
  document.querySelectorAll('.panel').forEach((panel, idx) => {
    const header = panel.querySelector(':scope > .panel-header');
    if (!header || header.querySelector('.panel-toggle-btn')) return;

    // Stable storage key: prefer panel's section id, else a positional index
    const storageKey = 'panel_collapsed_' + (panel.id || panel.closest('[id]')?.id || idx);

    // Inject toggle chevron at the right end of the header
    const btn = document.createElement('button');
    btn.className = 'panel-toggle-btn';
    btn.innerHTML = '&#9660;';  // ▼
    btn.title = 'Expandir / Contraer';
    btn.addEventListener('click', e => e.stopPropagation());
    header.appendChild(btn);

    // Restore saved state
    if (localStorage.getItem(storageKey) === 'true') {
      panel.classList.add('collapsed');
    }

    // Toggle on header click
    header.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      localStorage.setItem(storageKey, panel.classList.contains('collapsed'));
    });
  });
}

// ── USUARIOS ─────────────────────────────────────────────────────────────────
async function cargarUsuarios() {
  await _cargarTabla('usuariosBody', 8, async (tbody) => {
    const res  = await apiFetch('/api/users');
    const data = await res.json();
    if (!data.length) { tbody.innerHTML = _emptyTableRow(8, 'Sin usuarios'); return; }
    _usuarioDataMap = _buildDataMap(data);
    tbody.innerHTML = data.map(u => `
      <tr>
        <td>${esc(u.id)}</td>
        <td><strong>${esc(u.username)}</strong></td>
        <td>${esc(u.email || '—')}</td>
        <td><span class="badge-tipo" style="font-size:10px">${esc(u.role)}</span></td>
        <td>
          <label class="toggle-switch" title="${u.is_active ? 'Desactivar' : 'Activar'}">
            <input type="checkbox" ${u.is_active ? 'checked' : ''} onchange="toggleUsuarioActivo(${u.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td style="font-size:11px;color:var(--text3)">${esc(u.created_at || '—')}</td>
        <td style="font-size:11px;color:var(--text3)">${esc(u.last_login || '—')}</td>
        <td>
          <button class="btn-mini" data-action="abrir-modal-usuario" data-id="${u.id}">Editar</button>
        </td>
      </tr>
    `).join('');
  });
}

function abrirModalUsuario(usuario = null) {
  _pushModalFocus();
  if (typeof usuario === 'number' || (typeof usuario === 'string' && usuario !== '')) {
    usuario = _usuarioDataMap[+usuario] || null;
  }
  const modal = document.getElementById('modalUsuario');
  document.getElementById('usuarioResult').textContent = '';
  _clearFieldErrors(modal);
  if (usuario && typeof usuario === 'object') {
    document.getElementById('modalUsuarioTitulo').textContent = 'Editar Usuario';
    document.getElementById('u-id').value       = usuario.id;
    document.getElementById('u-username').value  = usuario.username;
    document.getElementById('u-email').value     = usuario.email || '';
    document.getElementById('u-rol').value       = usuario.role;
    document.getElementById('u-password').value  = '';
    document.getElementById('u-username').disabled = true;
    document.getElementById('u-pass-label').textContent = 'Nueva contraseña (vacío = no cambiar)';
  } else {
    document.getElementById('modalUsuarioTitulo').textContent = 'Nuevo Usuario';
    document.getElementById('u-id').value       = '';
    document.getElementById('u-username').value  = '';
    document.getElementById('u-email').value     = '';
    document.getElementById('u-rol').value       = 'OPERADOR';
    document.getElementById('u-password').value  = '';
    document.getElementById('u-username').disabled = false;
    document.getElementById('u-pass-label').textContent = 'Contraseña';
  }
  modal.classList.add('active');
  _watchModalDirty('modalUsuario');
}

function cerrarModalUsuario(e) {
  if (e.target === document.getElementById('modalUsuario')) {
    _checkModalDirty('modalUsuario', () => {
      document.getElementById('modalUsuario').classList.remove('active');
      _popModalFocus();
    });
  }
}

async function guardarUsuario(btn) {
  const resEl    = document.getElementById('usuarioResult');
  const modal    = document.getElementById('modalUsuario');
  _clearFieldErrors(modal);
  resEl.textContent = '';
  const id       = document.getElementById('u-id').value;
  const username = document.getElementById('u-username').value.trim();
  const email    = document.getElementById('u-email').value.trim();
  const role     = document.getElementById('u-rol').value;
  const password = document.getElementById('u-password').value;

  if (!id) {
    let hasError = false;
    if (!username) { _setFieldError('u-username', 'El username es requerido.'); hasError = true; }
    if (!password) { _setFieldError('u-password', 'La contraseña es requerida.'); hasError = true; }
    if (hasError) return;
  }

  await _withButtonLoading(btn, async () => {
    try {
      let res;
      if (id) {
        const body = { role, email: email || null };
        if (password) body.password = password;
        res = await _apiFetchJson(`/api/users/${id}`, 'PATCH', body);
      } else {
        res = await _apiFetchJson('/api/users', 'POST', { username, email: email || null, role, password });
      }
      if (!res.ok) {
        const err = await res.json();
        const detail = err.detail;
        _showResultErr(resEl, Array.isArray(detail)
          ? detail.map(d => d.msg || JSON.stringify(d)).join(' | ')
          : (detail || 'Error al guardar'));
        return;
      }
      document.getElementById('modalUsuario').classList.remove('active');
      await cargarUsuarios();
    } catch(e) {
      _showResultErr(resEl, e.message);
    }
  });
}

async function toggleUsuarioActivo(userId, activo) {
  return _togglePatch(`/api/users/${userId}`, { is_active: activo }, cargarUsuarios);
}

// ── CLIENTES ──────────────────────────────────────────────────────────────────
async function cargarClientesAdmin() {
  await _cargarTabla('clientesAdminBody', 7, async (tbody) => {
    const res  = await apiFetch('/api/clientes');
    const data = await res.json();
    if (!data.length) { tbody.innerHTML = _emptyTableRow(7, 'Sin clientes'); return; }
    _clienteDataMap = _buildDataMap(data, 'codigo');
    tbody.innerHTML = data.map(c => `
      <tr>
        <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(c.codigo)}</span></td>
        <td>${esc(c.nombre)}</td>
        <td>${esc(c.razon_social)}</td>
        <td style="text-align:center">${c.es_cartera_propia ? '<span style="color:var(--green);font-size:11px">&#10003; Propia</span>' : ''}</td>
        <td style="text-align:center">${c.es_pep ? '<span style="color:#f0a500;font-size:11px">PEP</span>' : ''}</td>
        <td>
          <label class="toggle-switch" title="${c.activo ? 'Desactivar' : 'Activar'}">
            <input type="checkbox" ${c.activo ? 'checked' : ''} onchange="toggleClienteActivo('${esc(c.codigo)}', this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td>
          <button class="btn-mini" data-action="abrir-modal-cliente" data-codigo="${esc(c.codigo)}">Editar</button>
        </td>
      </tr>
    `).join('');
  });
}

function abrirModalCliente(cliente = null) {
  _pushModalFocus();
  if (typeof cliente === 'string' && cliente !== '') {
    cliente = _clienteDataMap[cliente] || null;
  }
  const modal = document.getElementById('modalCliente');
  document.getElementById('clienteResult').textContent = '';
  _clearFieldErrors(modal);
  if (cliente && typeof cliente === 'object') {
    document.getElementById('modalClienteTitulo').textContent = 'Editar Cliente';
    document.getElementById('c-codigo-orig').value = cliente.codigo;
    document.getElementById('c-codigo').value       = cliente.codigo;
    document.getElementById('c-nombre').value       = cliente.nombre;
    document.getElementById('c-razon').value        = cliente.razon_social;
    document.getElementById('c-cartera-propia').checked = !!cliente.es_cartera_propia;
    document.getElementById('c-pep').checked        = !!cliente.es_pep;
    document.getElementById('c-codigo').disabled   = true;
  } else {
    document.getElementById('modalClienteTitulo').textContent = 'Nuevo Cliente';
    document.getElementById('c-codigo-orig').value = '';
    document.getElementById('c-codigo').value       = '';
    document.getElementById('c-nombre').value       = '';
    document.getElementById('c-razon').value        = '';
    document.getElementById('c-cartera-propia').checked = false;
    document.getElementById('c-pep').checked        = false;
    document.getElementById('c-codigo').disabled   = false;
  }
  modal.classList.add('active');
  _watchModalDirty('modalCliente');
}

function cerrarModalCliente(e) {
  if (e.target === document.getElementById('modalCliente')) {
    _checkModalDirty('modalCliente', () => {
      document.getElementById('modalCliente').classList.remove('active');
      _popModalFocus();
    });
  }
}

async function guardarCliente(btn) {
  const resEl      = document.getElementById('clienteResult');
  const modal      = document.getElementById('modalCliente');
  _clearFieldErrors(modal);
  resEl.textContent = '';
  const codigoOrig = document.getElementById('c-codigo-orig').value;
  const codigo     = document.getElementById('c-codigo').value.trim().toUpperCase();
  const nombre     = document.getElementById('c-nombre').value.trim();
  const razon      = document.getElementById('c-razon').value.trim();
  let hasError = false;
  if (!codigo) { _setFieldError('c-codigo', 'El código es requerido.'); hasError = true; }
  if (!nombre) { _setFieldError('c-nombre', 'El nombre es requerido.'); hasError = true; }
  if (!razon)  { _setFieldError('c-razon',  'La razón social es requerida.'); hasError = true; }
  if (hasError) return;

  await _withButtonLoading(btn, async () => {
    try {
      const esCarteraPropia = document.getElementById('c-cartera-propia').checked;
      const esPep           = document.getElementById('c-pep').checked;
      let res;
      if (codigoOrig) {
        res = await _apiFetchJson(`/api/clientes/${codigoOrig}`, 'PATCH',
          { nombre, razon_social: razon, es_cartera_propia: esCarteraPropia, es_pep: esPep });
      } else {
        res = await _apiFetchJson('/api/clientes', 'POST',
          { codigo, nombre, razon_social: razon, es_cartera_propia: esCarteraPropia, es_pep: esPep });
      }
      if (!res.ok) {
        const err = await res.json();
        _showResultErr(resEl, err.detail || 'Error al guardar');
        return;
      }
      document.getElementById('modalCliente').classList.remove('active');
      await cargarClientesAdmin();
    } catch(e) {
      _showResultErr(resEl, e.message);
    }
  });
}

async function toggleClienteActivo(codigo, activo) {
  return _togglePatch(`/api/clientes/${codigo}`, { activo }, cargarClientesAdmin);
}

// ── TICKERS ───────────────────────────────────────────────────────────────────
async function cargarTickersAdmin() {
  await _cargarTabla('tickersAdminBody', 6, async (tbody) => {
    const panel = document.getElementById('tickerPanelFiltro')?.value || '';
    const res  = await apiFetch('/api/admin/tickers');
    let data   = await res.json();
    if (panel) data = data.filter(t => t.panel === panel);
    if (!data.length) { tbody.innerHTML = _emptyTableRow(6, 'Sin tickers'); return; }
    _tickerDataMap = _buildDataMap(data, 'especie');
    const fmtN = v => v != null ? v.toLocaleString('es-AR') : '—';
    tbody.innerHTML = data.map(t => `
      <tr>
        <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(t.especie)}</span></td>
        <td style="font-size:11px">${esc(t.nombre || '—')}</td>
        <td><span class="badge-tipo" style="font-size:10px;opacity:0.8">${esc(t.panel)}</span></td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text3)">${esc(t.yf_symbol || '—')}</td>
        <td style="text-align:right;font-size:11px;color:${t.volumen_max_dia ? 'var(--accent)' : 'var(--text3)'}">${t.volumen_max_dia ? fmtN(t.volumen_max_dia) : '—'}</td>
        <td style="text-align:right;font-size:11px;color:${t.cantidad_max_orden ? 'var(--accent)' : 'var(--text3)'}">${t.cantidad_max_orden ? fmtN(t.cantidad_max_orden) : '—'}</td>
        <td>
          <label class="toggle-switch" title="${t.activo ? 'Deslistar' : 'Listar'}">
            <input type="checkbox" ${t.activo ? 'checked' : ''} onchange="toggleTickerActivo('${esc(t.especie)}', this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td>
          <button class="btn-mini" data-action="abrir-modal-ticker" data-especie="${esc(t.especie)}">Editar</button>
        </td>
      </tr>
    `).join('');
  });
}

function abrirModalTicker(ticker = null) {
  if (typeof ticker === 'string' && ticker !== '') {
    ticker = _tickerDataMap[ticker] || null;
  }
  const modal = document.getElementById('modalTicker');
  document.getElementById('tickerResult').textContent = '';
  if (ticker && typeof ticker === 'object') {
    document.getElementById('modalTickerTitulo').textContent = 'Editar Ticker';
    document.getElementById('t-especie-orig').value  = ticker.especie;
    document.getElementById('t-especie').value        = ticker.especie;
    document.getElementById('t-panel').value          = ticker.panel;
    document.getElementById('t-yf').value             = ticker.yf_symbol || '';
    document.getElementById('t-nombre').value         = ticker.nombre || '';
    document.getElementById('t-volumen-max').value    = ticker.volumen_max_dia || '';
    document.getElementById('t-cantidad-max').value   = ticker.cantidad_max_orden || '';
    document.getElementById('t-especie').disabled    = true;
  } else {
    document.getElementById('modalTickerTitulo').textContent = 'Nuevo Ticker';
    document.getElementById('t-especie-orig').value  = '';
    document.getElementById('t-especie').value        = '';
    document.getElementById('t-panel').value          = 'BYMA';
    document.getElementById('t-yf').value             = '';
    document.getElementById('t-nombre').value         = '';
    document.getElementById('t-volumen-max').value    = '';
    document.getElementById('t-cantidad-max').value   = '';
    document.getElementById('t-especie').disabled    = false;
  }
  modal.classList.add('active');
}

function cerrarModalTicker(e) {
  if (e.target === document.getElementById('modalTicker')) {
    document.getElementById('modalTicker').classList.remove('active');
  }
}

async function guardarTicker(btn) {
  const resEl     = document.getElementById('tickerResult');
  resEl.textContent = '';
  const especieOrig = document.getElementById('t-especie-orig').value;
  const especie     = document.getElementById('t-especie').value.trim().toUpperCase();
  const panel       = document.getElementById('t-panel').value;
  const yfSymbol    = document.getElementById('t-yf').value.trim() || null;
  const nombre      = document.getElementById('t-nombre').value.trim() || null;
  const volumenMax  = parseInt(document.getElementById('t-volumen-max').value) || 0;
  const cantidadMax = parseInt(document.getElementById('t-cantidad-max').value) || 0;
  if (!especie) { resEl.textContent = 'La especie es requerida.'; return; }

  await _withButtonLoading(btn, async () => {
    try {
      let res;
      if (especieOrig) {
        res = await _apiFetchJson(`/api/admin/tickers/${especieOrig}`, 'PATCH',
          { panel, yf_symbol: yfSymbol, nombre, volumen_max_dia: volumenMax, cantidad_max_orden: cantidadMax });
      } else {
        res = await _apiFetchJson('/api/admin/tickers', 'POST',
          { especie, panel, yf_symbol: yfSymbol, nombre });
      }
      if (!res.ok) {
        const err = await res.json();
        _showResultErr(resEl, err.detail || 'Error al guardar');
        return;
      }
      document.getElementById('modalTicker').classList.remove('active');
      await cargarTickersAdmin();
    } catch(e) {
      _showResultErr(resEl, e.message);
    }
  });
}

async function toggleTickerActivo(especie, activo) {
  return _togglePatch(`/api/admin/tickers/${especie}`, { activo }, cargarTickersAdmin);
}

// ── BOTS DE MERCADO (multi-instancia) ─────────────────────────────────────────
const _TIPOS_COMPRA_SET = new Set(['LIMC']);
const _TIPOS_VENTA_SET  = new Set(['LIMV']);

function _tiposBadges(tipos) {
  return tipos.map(t => {
    const cls = _TIPOS_COMPRA_SET.has(t) ? 'ob-var-pos' : 'ob-var-neg';
    return `<span class="${cls}" style="font-size:10px;font-family:'IBM Plex Mono',monospace;padding:1px 5px;border-radius:2px">${esc(t)}</span>`;
  }).join(' ');
}

let _botDataMap          = {};   // id      → bot object
let _usuarioDataMap      = {};   // id      → usuario object
let _clienteDataMap      = {};   // codigo  → cliente object
let _tickerDataMap       = {};   // especie → ticker object
let _instrumentoDataMap  = {};   // id      → instrumento object
let _contraparteDataMap  = {};   // id      → contraparte object
let _limiteDataMap       = {};   // id      → limite object
let _hoveredBotId = null;

async function toggleBotHorario(botId) {
  const bot = _botDataMap[botId];
  if (!bot) return;
  const nuevo = bot.respetar_horario === false ? true : false;
  try {
    await apiFetch(`/api/admin/bots/${botId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ respetar_horario: nuevo }),
    });
    await cargarBots();
  } catch(e) { _logError('toggleHorarioBot', e); showToast('Error al cambiar horario del bot.', 'error'); }
}

async function setBulkHorario(respetar) {
  try {
    await apiFetch('/api/admin/bots/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ respetar_horario: respetar }),
    });
    await cargarBots();
  } catch(e) {
    showToast('Error al cambiar horario de bots.', 'error');
  }
}

async function cargarBots() {
  await _cargarTabla('botsBody', 9, async (tbody) => {
    const res  = await apiFetch('/api/admin/bots');
    const data = await res.json();
    // Sync global toggle: checked when ALL bots respect schedule
    const sw = document.getElementById('switch-horario-global');
    if (sw) sw.checked = data.length > 0 && data.every(b => b.respetar_horario !== false);
    if (!data.length) { tbody.innerHTML = _emptyTableRow(9, 'Sin instancias. Creá una con "+ Nueva instancia".'); return; }
    _botDataMap = _buildDataMap(data);
    const _perfilColor = { CONSERVADOR: '#4a9eff', MODERADO: '#f0a500', AGRESIVO: '#e05252', TRADER: '#00d4aa' };
    tbody.innerHTML = data.map(b => {
      const pColor = _perfilColor[b.perfil] || 'var(--text2)';
      return `
      <tr data-id="${b.id}" onmouseenter="_hoveredBotId=${b.id}" onmouseleave="_hoveredBotId=null" title="E para editar">
        <td><strong>${esc(b.nombre)}</strong></td>
        <td>
          <label class="toggle-switch" title="${b.enabled ? 'Desactivar' : 'Activar'}">
            <input type="checkbox" ${b.enabled ? 'checked' : ''} onchange="toggleBotEnabled(${b.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td><span style="font-size:10px;font-weight:600;color:${pColor};letter-spacing:.5px">${esc(b.perfil||'MODERADO')}</span></td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:12px">${b.interval}s</td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:12px">±${(b.variance*100).toFixed(2)}%</td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:12px">${((b.fill_rate||0.45)*100).toFixed(0)}%</td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:12px">${b.max_ordenes}</td>
        <td>${_tiposBadges(b.tipos_orden)}</td>
        <td title="${b.respetar_horario ? 'Solo opera en horario de mercado (Lun–Vie 10–17 ART)' : 'Opera fuera de horario'}">
          ${b.respetar_horario
            ? '<span style="font-size:10px;color:var(--text3)">Lun–Vie 10–17</span>'
            : '<span style="font-size:10px;font-weight:600;color:var(--accent)">24/7</span>'}
        </td>
        <td style="display:flex;gap:4px">
          <button class="btn-mini" onclick="abrirModalCuentaBot(${b.id}, '${esc(b.nombre)}')">Cuenta</button>
          <button class="btn-mini" onclick="abrirModalPosicionesBot(${b.id}, '${esc(b.nombre)}')">Posiciones</button>
          <button class="btn-mini" onclick="abrirModalBot(${b.id})">Editar</button>
          <button class="btn-mini btn-danger" onclick="eliminarBot(${b.id}, '${esc(b.nombre)}')">Eliminar</button>
        </td>
      </tr>
    `}).join('');
  });
}

const _TODOS_TIPOS = ['LIMC', 'LIMV'];

// Profile defaults for auto-population when perfil selector changes
const _PERFIL_DEFAULTS = {
  CONSERVADOR: { interval: 15, variance: 0.35, fill_rate: 0.25 },
  MODERADO:    { interval: 7,  variance: 0.85, fill_rate: 0.45 },
  AGRESIVO:    { interval: 4,  variance: 1.75, fill_rate: 0.70 },
  TRADER:      { interval: 2,  variance: 0.10, fill_rate: 0.85 },
};

function aplicarPerfilDefaults() {
  const perfil = document.getElementById('b-perfil')?.value;
  // Only apply if fields are at their pristine (not user-edited) state
  // Use data-auto attribute to detect whether user has manually changed values
  const isNew = !document.getElementById('b-id')?.value;
  if (!isNew) return;  // Don't override values when editing
  const d = _PERFIL_DEFAULTS[perfil];
  if (!d) return;
  document.getElementById('b-interval').value  = d.interval;
  document.getElementById('b-variance').value  = d.variance;
  const fr = document.getElementById('b-fill-rate');
  if (fr) {
    fr.value = d.fill_rate;
    document.getElementById('b-fill-rate-val').textContent = (d.fill_rate * 100).toFixed(0) + '%';
  }
}

function abrirModalBot(bot = null) {
  if (typeof bot === 'number' || (typeof bot === 'string' && bot !== '')) {
    bot = _botDataMap[+bot] || null;
  }
  const modal = document.getElementById('modalBot');
  document.getElementById('botResult').textContent = '';
  _clearFieldErrors(modal);

  if (bot && typeof bot === 'object') {
    document.getElementById('modalBotTitulo').textContent = 'Editar instancia de Bot';
    document.getElementById('b-id').value           = bot.id;
    document.getElementById('b-nombre').value       = bot.nombre;
    document.getElementById('b-perfil').value       = bot.perfil || 'MODERADO';
    document.getElementById('b-interval').value     = bot.interval;
    document.getElementById('b-variance').value     = (bot.variance * 100).toFixed(2);
    document.getElementById('b-max-ordenes').value  = bot.max_ordenes;
    const fr = bot.fill_rate != null ? bot.fill_rate : 0.45;
    document.getElementById('b-fill-rate').value    = fr;
    document.getElementById('b-fill-rate-val').textContent = (fr * 100).toFixed(0) + '%';
    const pmEl = document.getElementById('b-prob-mercado');
    const pmValEl = document.getElementById('b-prob-mercado-val');
    if (pmEl) {
      if (bot.prob_orden_mercado != null) {
        pmEl.value = bot.prob_orden_mercado;
        pmValEl.textContent = (bot.prob_orden_mercado * 100).toFixed(0) + '%';
      } else {
        pmEl.value = '';
        pmValEl.textContent = 'perfil';
      }
    }
    const activos = new Set(bot.tipos_orden);
    _TODOS_TIPOS.forEach(t => {
      const cb = document.getElementById(`bt-${t}`);
      if (cb) cb.checked = activos.has(t);
    });
    const rhCb = document.getElementById('b-respetar-horario');
    if (rhCb) rhCb.checked = bot.respetar_horario !== false;
  } else {
    document.getElementById('modalBotTitulo').textContent = 'Nueva instancia de Bot';
    document.getElementById('b-id').value           = '';
    document.getElementById('b-nombre').value       = '';
    document.getElementById('b-perfil').value       = 'MODERADO';
    document.getElementById('b-interval').value     = '7';
    document.getElementById('b-variance').value     = '0.85';
    document.getElementById('b-max-ordenes').value  = '20';
    document.getElementById('b-fill-rate').value    = '0.45';
    document.getElementById('b-fill-rate-val').textContent = '45%';
    const pmEl = document.getElementById('b-prob-mercado');
    if (pmEl) { pmEl.value = ''; document.getElementById('b-prob-mercado-val').textContent = 'perfil'; }
    // Default: LIMC + LIMV checked
    _TODOS_TIPOS.forEach(t => {
      const cb = document.getElementById(`bt-${t}`);
      if (cb) cb.checked = (t === 'LIMC' || t === 'LIMV');
    });
    const rhCb = document.getElementById('b-respetar-horario');
    if (rhCb) rhCb.checked = true;
  }
  modal.classList.add('active');
}

function cerrarModalBot(e) {
  if (e.target === document.getElementById('modalBot')) {
    _checkModalDirty('modalBot', () => {
      document.getElementById('modalBot').classList.remove('active');
      _popModalFocus();
    });
  }
}

async function guardarBot(btn) {
  const resEl      = document.getElementById('botResult');
  const modal      = document.getElementById('modalBot');
  _clearFieldErrors(modal);
  resEl.textContent = '';

  const id         = document.getElementById('b-id').value;
  const nombre     = document.getElementById('b-nombre').value.trim();
  const perfil     = document.getElementById('b-perfil')?.value || 'MODERADO';
  const interval   = parseFloat(document.getElementById('b-interval').value) || 7;
  const variancePct= parseFloat(document.getElementById('b-variance').value) || 0.85;
  const maxOrdenes = parseInt(document.getElementById('b-max-ordenes').value) || 20;
  const fillRate   = parseFloat(document.getElementById('b-fill-rate')?.value ?? 0.45);
  const tipos      = _TODOS_TIPOS.filter(t => document.getElementById(`bt-${t}`)?.checked);
  const respetar   = document.getElementById('b-respetar-horario')?.checked ?? true;
  const pmRaw      = document.getElementById('b-prob-mercado')?.value;
  const probMercado= pmRaw !== '' && pmRaw != null ? parseFloat(pmRaw) : null;

  let hasError = false;
  if (!nombre)       { _setFieldError('b-nombre', 'El nombre es requerido.'); hasError = true; }
  if (!tipos.length) { _showResultErr(resEl, 'Seleccioná al menos un tipo de orden.'); hasError = true; }
  if (hasError) return;

  const body = { nombre, enabled: true, interval, variance: variancePct / 100, max_ordenes: maxOrdenes,
    tipos_orden: tipos, perfil, fill_rate: fillRate, respetar_horario: respetar, prob_orden_mercado: probMercado };

  await _withButtonLoading(btn, async () => {
    try {
      const res = await (id
        ? _apiFetchJson(`/api/admin/bots/${id}`, 'PATCH', body)
        : _apiFetchJson('/api/admin/bots', 'POST', body));
      if (!res.ok) {
        const err = await res.json();
        _showResultErr(resEl, err.detail || 'Error al guardar');
        return;
      }
      document.getElementById('modalBot').classList.remove('active');
      await cargarBots();
    } catch(e) {
      _showResultErr(resEl, e.message);
    }
  });
}

async function toggleBotEnabled(botId, enabled) {
  try {
    await _apiFetchJson(`/api/admin/bots/${botId}`, 'PATCH', { enabled });
    await cargarBots();
  } catch { await cargarBots(); }
}

async function eliminarBot(botId, nombre) {
  _confirmar(
    'Eliminar instancia',
    `¿Eliminar la instancia "${nombre}"? Esta acción no se puede deshacer.`,
    async () => {
      try {
        await apiFetch(`/api/admin/bots/${botId}`, { method: 'DELETE' });
        showToast(`Instancia "${nombre}" eliminada.`, 'ok');
        await cargarBots();
      } catch(e) {
        showToast('Error al eliminar: ' + e.message, 'error');
      }
    }
  );
}


// ── Sistema config ────────────────────────────────────────────────────────────

async function cargarConfigSistema() {
  try {
    const res  = await apiFetch('/api/admin/config');
    const cfg  = await res.json();
    const cb   = document.getElementById('cfg-auto-matching');
    const sel  = document.getElementById('cfg-matching-mercado');
    const stat = document.getElementById('cfg-matching-status');
    if (cb)   cb.checked = cfg.auto_matching;
    if (sel)  sel.value  = cfg.matching_mercado || 'DEFAULT';
    if (stat) stat.textContent = cfg.auto_matching
      ? `Activo — cruces automáticos habilitados (mercado: ${cfg.matching_mercado})`
      : 'Desactivado — las ejecuciones se registran manualmente.';
    // Sesgo macro
    const sesgo = cfg.mercado_sesgo ?? 0;
    const slider = document.getElementById('cfg-mercado-sesgo');
    const label  = document.getElementById('cfg-sesgo-valor');
    if (slider) slider.value = Math.round(sesgo * 100);
    if (label)  label.textContent = sesgo > 0 ? `+${Math.round(sesgo*100)}%` : `${Math.round(sesgo*100)}%`;
  } catch(e) {
    showToast('Error cargando config: ' + e.message, 'error');
  }
}

async function guardarSesgoMacro(valor) {
  try {
    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mercado_sesgo: valor }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Error: ' + (err.detail || res.status), 'error');
      await cargarConfigSistema();
      return;
    }
    const label = Math.round(valor * 100);
    const txt = label > 0 ? `+${label}% BULL` : label < 0 ? `${label}% BEAR` : 'Neutral';
    showToast(`Sesgo macro actualizado: ${txt}`, 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function toggleAutoMatching(enabled) {
  try {
    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_matching: enabled }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Error: ' + (err.detail || res.status), 'error');
      await cargarConfigSistema(); // revert toggle UI
      return;
    }
    await cargarConfigSistema();
    showToast(`Matching automático ${enabled ? 'activado' : 'desactivado'}.`, enabled ? 'success' : 'info');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
    await cargarConfigSistema();
  }
}

async function guardarMercadoMatching() {
  const sel = document.getElementById('cfg-matching-mercado');
  if (!sel) return;
  try {
    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matching_mercado: sel.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Error: ' + (err.detail || res.status), 'error');
      return;
    }
    await cargarConfigSistema();
    showToast('Mercado de matching actualizado.', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}


async function resetDemoData() {
  const resEl = document.getElementById('demo-reset-result');
  _confirmar(
    '⚠ Reiniciar datos operativos',
    'Se borrarán PERMANENTEMENTE todas las órdenes, ejecuciones, posiciones y movimientos de cuenta del entorno demo. Los usuarios y configuración no se tocan. Esta acción NO se puede deshacer.',
    async () => {
      resEl.textContent = 'Eliminando...';
      _resetDemoDataExec(resEl);
    }
  );
}

async function _resetDemoDataExec(resEl) {
  _setLoadingMessage(resEl, 'Eliminando... (puede demorar unos segundos)');
  resEl.style.color = 'var(--text3)';
  try {
    const res = await apiFetch('/api/admin/demo-reset', { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      resEl.innerHTML = 'Error: ' + esc(err.detail || res.status);
      resEl.style.color = 'var(--red)';
      return;
    }
    const data = await res.json();
    resEl.innerHTML = esc(data.mensaje);
    resEl.style.color = 'var(--green)';
    showToast('Datos operativos eliminados correctamente.', 'ok');
  } catch(e) {
    resEl.innerHTML = 'Error: ' + esc(e.message);
    resEl.style.color = 'var(--red)';
  }
}


// ── MODAL CUENTA BOT ────────────────────────────────────────────────────────

let _cbAccountId        = null;  // account_id del bot actualmente abierto
let _cbBotId            = null;  // bot_id del bot actualmente abierto
let _cbPage             = 1;
let _cbTotalPages       = 1;
let _cbMovCargados      = false; // lazy-load flag

const _fmtARSCompact = v => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1_000_000) return fmt(n / 1_000_000) + 'M';
  if (Math.abs(n) >= 1_000)     return fmt(n / 1_000) + 'K';
  return fmt(v);
};

function cerrarModalCuentaBot(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modalCuentaBot').classList.remove('active');
}

// ── Bot positions modal ────────────────────────────────────────────────────────

async function abrirModalPosicionesBot(botId, botNombre) {
  const modal   = document.getElementById('modalPosicionesBot');
  const titulo  = document.getElementById('posicionesBotTitulo');
  const content = document.getElementById('posicionesBotContent');

  titulo.textContent = `Posiciones: ${botNombre}`;
  content.innerHTML  = '<div class="spinner"></div>';
  modal.classList.add('active');

  try {
    const res  = await apiFetch(`/api/admin/bots/${botId}/posiciones`);
    const data = await res.json();

    if (!data.length) {
      content.innerHTML = '<p style="color:var(--text3);font-size:13px;padding:16px 0">Sin ejecuciones registradas para este bot.</p>';
      return;
    }

    const totalValor = data.reduce((s, r) => s + (r.valor_mercado || 0), 0);
    const totalPnl   = data.reduce((s, r) => s + (r.pnl_estimado || 0), 0);
    const pnlColor   = totalPnl >= 0 ? 'var(--green)' : 'var(--red)';
    const fmt        = v => v == null ? '—' : v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const rows = data.map(r => {
      const neta      = r.cantidad_neta;
      const netaColor = neta > 0 ? 'var(--green)' : neta < 0 ? 'var(--red)' : 'var(--text3)';
      const pnl       = r.pnl_estimado;
      const pnlCl     = pnl == null ? 'var(--text3)' : pnl >= 0 ? 'var(--green)' : 'var(--red)';
      return `
        <tr>
          <td><strong>${esc(r.especie)}</strong></td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${r.cantidad_comprada.toLocaleString('es-AR')}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${r.cantidad_vendida.toLocaleString('es-AR')}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:${netaColor}">${neta.toLocaleString('es-AR')}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${fmt(r.costo_promedio)}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${fmt(r.precio_actual)}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${fmt(r.valor_mercado)}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${pnlCl}">${pnl == null ? '—' : (pnl >= 0 ? '+' : '') + fmt(pnl)}</td>
        </tr>`;
    }).join('');

    content.innerHTML = `
      <div style="display:flex;gap:24px;margin-bottom:14px;padding:10px 14px;background:var(--bg2);border-radius:6px;font-size:12px">
        <span style="color:var(--text3)">Especies con posición: <strong style="color:var(--text2)">${data.filter(r=>r.cantidad_neta!==0).length}</strong></span>
        <span style="color:var(--text3)">Valor @ mercado: <strong style="color:var(--text2)">$ ${fmt(totalValor)}</strong></span>
        <span style="color:var(--text3)">P&L estimado: <strong style="color:${pnlColor}">${totalPnl >= 0 ? '+' : ''}$ ${fmt(totalPnl)}</strong></span>
      </div>
      <div class="table-wrap">
        <table class="orders-table mini-table">
          <thead>
            <tr>
              <th>Especie</th>
              <th>Comprada</th>
              <th>Vendida</th>
              <th>Neta</th>
              <th>Costo prom.</th>
              <th>Precio actual</th>
              <th>Valor mercado</th>
              <th>P&L estimado</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch(e) {
    content.innerHTML = `<p style="color:var(--red);font-size:13px">${esc(e.message)}</p>`;
  }
}

function switchCuentaBotTab(tab) {
  _switchTab(tab, ['resumen', 'movimientos', 'operaciones'], 'cbTab-', 'cb-tab-',
    t => { if (t === 'movimientos' && !_cbMovCargados) cargarMovimientosBot(1); });
}

async function abrirModalCuentaBot(botId, botNombre) {
  _cbAccountId   = null;
  _cbBotId       = botId;
  _cbPage        = 1;
  _cbTotalPages  = 1;
  _cbMovCargados = false;

  document.getElementById('cuentaBotTitulo').textContent   = `Cuenta: ${botNombre}`;
  document.getElementById('cuentaBotSubtitulo').textContent = 'Cargando...';
  document.getElementById('cb-sin-cuenta').style.display   = 'none';
  document.getElementById('cb-tab-resumen').style.display  = '';
  document.getElementById('cb-tab-movimientos').style.display  = 'none';
  document.getElementById('cb-tab-operaciones').style.display  = 'none';
  document.getElementById('cb-metricas').innerHTML = '<div style="color:var(--text3);font-size:11px;padding:8px 0">Cargando métricas...</div>';
  document.getElementById('cb-stats').textContent  = '';
  document.getElementById('cb-ajuste-result').textContent  = '';

  // Reset form
  document.getElementById('cb-sentido-credit').checked = true;
  document.getElementById('cb-monto').value        = '';
  document.getElementById('cb-descripcion').value  = '';

  // Active tab reset
  document.getElementById('cbTab-resumen').classList.add('active');
  document.getElementById('cbTab-movimientos').classList.remove('active');
  document.getElementById('cbTab-operaciones').classList.remove('active');

  // Show/hide Operaciones tab based on role
  const isAdmin = state.userRole === 'ADMIN';
  document.getElementById('cbTab-operaciones').style.display = isAdmin ? '' : 'none';

  document.getElementById('modalCuentaBot').classList.add('active');

  await cargarRendimientoBot(botId);
}

async function cargarRendimientoBot(botId) {
  try {
    const res  = await apiFetch(`/api/cuentas/bots/${botId}/rendimiento`);
    const data = await res.json();

    if (data.sin_cuenta) {
      document.getElementById('cb-tab-resumen').style.display  = 'none';
      document.getElementById('cb-sin-cuenta').style.display   = '';
      document.getElementById('cb-sin-cuenta-msg').textContent = data.mensaje || 'Sin cuenta asignada.';
      document.getElementById('cuentaBotSubtitulo').textContent = 'Sin cuenta';
      document.getElementById('cbTab-movimientos').disabled    = true;
      document.getElementById('cbTab-operaciones').style.display = 'none';
      // Show init form only for ADMIN
      document.getElementById('cb-init-form').style.display   = state.userRole === 'ADMIN' ? '' : 'none';
      document.getElementById('cb-init-result').textContent   = '';
      document.getElementById('cb-init-capital').value        = '';
      return;
    }

    _cbAccountId = data.account_id;
    document.getElementById('cbTab-movimientos').disabled = false;
    document.getElementById('cuentaBotSubtitulo').textContent =
      `${data.moneda || 'ARS'} · account #${data.account_id}`;

    _renderResumenBot(data);
  } catch(e) {
    document.getElementById('cb-metricas').innerHTML =
      `<div style="color:var(--red);font-size:11px">Error al cargar: ${esc(e.message)}</div>`;
  }
}

function _renderResumenBot(d) {
  const pnlColor    = d.pnl_realizado  >= 0 ? 'var(--green)' : 'var(--red)';
  const retColor    = d.retorno_pct    >= 0 ? 'var(--green)' : 'var(--red)';
  const pnlSign     = d.pnl_realizado  >= 0 ? '+' : '';
  const retSign     = d.retorno_pct    >= 0 ? '+' : '';

  const metricBox = (label, value, color = 'var(--text1)') => `
    <div style="background:var(--bg4);border:1px solid var(--border);border-radius:2px;padding:10px;text-align:center">
      <div style="font-size:10px;color:var(--text3);margin-bottom:5px;letter-spacing:.5px;text-transform:uppercase">${label}</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;color:${color}">${value}</div>
    </div>`;

  document.getElementById('cb-metricas').innerHTML =
    metricBox('Saldo actual',    '$' + _fmtARSCompact(d.balance_cash)) +
    metricBox('Capital inicial', '$' + _fmtARSCompact(d.capital_inicial)) +
    metricBox('PnL realizado',   pnlSign + '$' + _fmtARSCompact(d.pnl_realizado), pnlColor) +
    metricBox('Retorno',         retSign + (d.retorno_pct || 0).toFixed(2) + '%', retColor);

  document.getElementById('cb-stats').innerHTML =
    `Operaciones: <strong>${(d.n_operaciones || 0).toLocaleString('es-AR')}</strong> &nbsp;·&nbsp; ` +
    `Volumen operado: <strong>$${_fmtARSCompact(d.volumen_operado)}</strong> &nbsp;·&nbsp; ` +
    `Compras: <strong>$${_fmtARSCompact(d.total_compras)}</strong> &nbsp;·&nbsp; ` +
    `Ventas: <strong>$${_fmtARSCompact(d.total_ventas)}</strong> &nbsp;·&nbsp; ` +
    `Comisiones: <strong>$${_fmtARSCompact(d.total_comisiones)}</strong>`;
}

async function cargarMovimientosBot(page) {
  if (!_cbAccountId) return;
  _cbPage = page;
  const tbody = document.getElementById('cb-movimientos-body');
  tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Cargando...</td></tr>`;

  try {
    const res  = await apiFetch(`/api/cuentas/${_cbAccountId}/movimientos?page=${page}&per_page=${MOV_PER_PAGE}`);
    const data = await res.json();

    _cbTotalPages  = data.pages || 1;
    _cbMovCargados = true;

    document.getElementById('cb-pag-info').textContent  = `Página ${data.current_page} de ${data.pages}`;
    document.getElementById('cb-pag-prev').disabled     = data.current_page <= 1;
    document.getElementById('cb-pag-next').disabled     = data.current_page >= data.pages;

    if (!data.entries.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Sin movimientos registrados.</td></tr>`;
      return;
    }

    const _tipoColor = {
      COMPRA: 'var(--red)', VENTA: 'var(--green)', COMISION: 'var(--red)',
      AJUSTE_CREDITO: 'var(--green)', AJUSTE_DEBITO: 'var(--red)',
      DEPOSITO: 'var(--green)', RETIRO: 'var(--red)',
      BOT_ASIGNACION: 'var(--green)', BOT_DEVOLUCION: 'var(--red)',
    };

    tbody.innerHTML = data.entries.map(e => {
      const isCredit  = e.sentido === 'CREDIT';
      const montoSign = isCredit ? '+' : '-';
      const montoClr  = isCredit ? 'var(--green)' : 'var(--red)';
      const tipoClr   = _tipoColor[e.tipo] || 'var(--text2)';
      const fecha = _fmtDatetime(e.created_at);
      return `<tr>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px;white-space:nowrap">${esc(fecha)}</td>
        <td><span style="font-size:10px;font-weight:600;color:${tipoClr}">${esc(e.tipo)}</span></td>
        <td style="font-size:10px;color:${isCredit ? 'var(--green)' : 'var(--red)'}">${esc(e.sentido)}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px;color:${montoClr}">${montoSign}$${fmt(e.monto)}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">$${fmt(e.balance_post)}</td>
        <td style="font-size:10px;color:var(--text3);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.descripcion||'')}">${esc(e.descripcion || '—')}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = _errorTableRow(6, e.message);
  }
}

function cambiarPaginaBot(delta) {
  const nueva = _cbPage + delta;
  if (nueva < 1 || nueva > _cbTotalPages) return;
  cargarMovimientosBot(nueva);
}

async function ejecutarAjusteBot() {
  if (!_cbAccountId) return;
  const resEl = document.getElementById('cb-ajuste-result');
  resEl.style.color   = 'var(--text2)';
  resEl.textContent   = '';

  const sentido    = document.querySelector('input[name="cb-sentido"]:checked')?.value;
  const monto      = parseFloat(document.getElementById('cb-monto').value);
  const descripcion = document.getElementById('cb-descripcion').value.trim();

  if (!sentido)            { resEl.style.color = 'var(--red)'; resEl.textContent = 'Seleccioná una operación.'; return; }
  if (!(monto > 0))        { resEl.style.color = 'var(--red)'; resEl.textContent = 'El monto debe ser mayor a 0.'; return; }
  if (descripcion.length < 5) { resEl.style.color = 'var(--red)'; resEl.textContent = 'La descripción debe tener al menos 5 caracteres.'; return; }

  resEl.textContent = 'Procesando...';
  try {
    const res  = await apiFetch(`/api/cuentas/${_cbAccountId}/ajuste`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ monto, sentido, descripcion }),
    });
    const data = await res.json();
    if (!res.ok) {
      resEl.style.color = 'var(--red)';
      resEl.textContent = data.detail || 'Error al registrar ajuste.';
      return;
    }
    resEl.style.color = 'var(--green)';
    resEl.textContent = `Ajuste registrado. Saldo post: $${fmt(data.balance_post)}`;
    document.getElementById('cb-monto').value       = '';
    document.getElementById('cb-descripcion').value = '';
    // Reload resumen with updated balance
    _cbMovCargados = false;
    await cargarRendimientoBot(_cbBotId);
  } catch(e) {
    resEl.style.color = 'var(--red)';
    resEl.textContent = e.message;
  }
}

async function inicializarCuentaBot() {
  const resEl   = document.getElementById('cb-init-result');
  const capital = parseFloat(document.getElementById('cb-init-capital').value);
  if (!(capital > 0)) {
    resEl.style.color = 'var(--red)';
    resEl.textContent = 'Ingresá un capital mayor a 0.';
    return;
  }
  resEl.style.color = 'var(--text2)';
  resEl.textContent = 'Creando cuenta...';
  try {
    const res  = await apiFetch(`/api/cuentas/bots/${_cbBotId}/inicializar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ capital_inicial: capital }),
    });
    const data = await res.json();
    if (!res.ok) {
      resEl.style.color = 'var(--red)';
      resEl.textContent = data.detail || 'Error al crear cuenta.';
      return;
    }
    // Cuenta creada — recargar el modal desde el inicio
    document.getElementById('cb-sin-cuenta').style.display  = 'none';
    document.getElementById('cb-tab-resumen').style.display = '';
    document.getElementById('cbTab-movimientos').disabled   = false;
    _cbMovCargados = false;
    await cargarRendimientoBot(_cbBotId);
  } catch(e) {
    resEl.style.color = 'var(--red)';
    resEl.textContent = e.message;
  }
}

async function ejecutarReconciliarBot() {
  if (!_cbAccountId) return;
  _confirmar(
    'Reconciliar balance',
    'Se recalculará el balance sumando todos los movimientos del ledger. Operación de solo lectura — actualiza balance_cache.',
    async () => {
      const resEl = document.getElementById('cb-ajuste-result');
      await _reconciliarBotExec(resEl);
    }
  );
}

async function _reconciliarBotExec(resEl) {
  const el = resEl || document.getElementById('cb-ajuste-result');
  el.style.color = 'var(--text2)';
  el.textContent = 'Reconciliando...';
  try {
    const res  = await apiFetch(`/api/cuentas/${_cbAccountId}/reconciliar`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      el.style.color = 'var(--red)';
      el.textContent = data.detail || 'Error al reconciliar.';
      return;
    }
    const drift = data.drift || 0;
    el.style.color = Math.abs(drift) > 0.01 ? 'var(--red)' : 'var(--green)';
    el.textContent =
      `Reconciliado. Balance nuevo: $${fmt(data.balance_nuevo)} ` +
      `(antes: $${fmt(data.balance_antes)}, drift: ${drift >= 0 ? '+' : ''}$${fmt(drift)})`;
    _cbMovCargados = false;
    await cargarRendimientoBot(_cbBotId);
  } catch(e) {
    el.style.color = 'var(--red)';
    el.textContent = e.message;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── INSTRUMENTOS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

let _instCurrentId = null;

function parseFloatOrNull(s) {
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

async function cargarInstrumentos() {
  await _cargarTabla('instrumentosBody', 7, async (tbody) => {
    const tipo        = document.getElementById('instTipoFiltro')?.value || '';
    const soloActivos = document.getElementById('instSoloActivos')?.checked !== false;
    let url = '/api/instrumentos?';
    if (tipo) url += `tipo=${encodeURIComponent(tipo)}&`;
    url += `solo_activos=${soloActivos}`;
    const res   = await apiFetch(url);
    const data  = await res.json();
    const items = data.instrumentos || [];
    if (!items.length) {
      tbody.innerHTML = _emptyTableRow(7, 'Sin instrumentos');
      return;
    }
    _instrumentoDataMap = _buildDataMap(items);
    const tipoColor = { ACCION:'var(--green)', RENTA_FIJA:'#4a9eff', FUTURO:'#f0a500', CAUCION:'var(--text2)', CPD:'var(--text2)', FX:'#00d4aa', OTRO:'var(--text3)' };
    tbody.innerHTML = items.map(i => `
      <tr>
        <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(i.especie)}</span></td>
        <td><span style="font-size:10px;font-weight:600;color:${tipoColor[i.tipo]||'var(--text2)'}">${esc(i.tipo)}</span></td>
        <td style="font-size:11px">${esc(i.moneda)}</td>
        <td style="font-size:11px;color:var(--text3)">${esc(i.mercado_principal||'—')}</td>
        <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.descripcion||'')}">${esc(i.descripcion||'—')}</td>
        <td>
          <label class="toggle-switch">
            <input type="checkbox" ${i.activo ? 'checked' : ''} onchange="toggleInstrumentoActivo(${i.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td><button class="btn-mini" onclick="abrirModalInstrumento(${i.id})">Editar</button></td>
      </tr>
    `).join('');
  });
}

function instActualizarSubtabs() {
  const tipo    = document.getElementById('inst-tipo')?.value;
  const showRf  = tipo === 'RENTA_FIJA';
  const showFut = tipo === 'FUTURO';
  const rfBtn   = document.getElementById('instSubTab-rf');
  const futBtn  = document.getElementById('instSubTab-futuro');
  const mrgBtn  = document.getElementById('instSubTab-margen');
  if (rfBtn)  rfBtn.style.display  = showRf  ? '' : 'none';
  if (futBtn) futBtn.style.display = showFut ? '' : 'none';
  if (mrgBtn) mrgBtn.style.display = showFut ? '' : 'none';
}

function switchInstTab(tab) {
  _switchTab(tab, ['base','rf','futuro','margen'], 'instSubTab-', 'instTab-',
    t => { if (t === 'margen' && _instCurrentId) cargarLlamados(_instCurrentId); });
}

function abrirModalInstrumento(inst = null) {
  if (typeof inst === 'number' || (typeof inst === 'string' && inst !== '')) {
    inst = _instrumentoDataMap[+inst] || null;
  }
  _instCurrentId = inst ? inst.id : null;
  document.getElementById('instResult').textContent = '';
  document.getElementById('rfResult').textContent   = '';
  document.getElementById('futResult').textContent  = '';

  if (inst && typeof inst === 'object') {
    document.getElementById('modalInstTitulo').textContent = 'Editar Instrumento';
    document.getElementById('inst-id').value          = inst.id;
    document.getElementById('inst-especie').value     = inst.especie;
    document.getElementById('inst-especie').disabled  = true;
    document.getElementById('inst-tipo').value        = inst.tipo;
    document.getElementById('inst-moneda').value      = inst.moneda || 'ARP';
    document.getElementById('inst-mercado').value     = inst.mercado_principal || '';
    document.getElementById('inst-descripcion').value = inst.descripcion || '';
    if (inst.renta_fija) {
      const rf = inst.renta_fija;
      document.getElementById('rf-tir').value            = rf.tir_referencia  ?? '';
      document.getElementById('rf-duration').value       = rf.duration        ?? '';
      document.getElementById('rf-vencimiento').value    = rf.fecha_vencimiento || '';
      document.getElementById('rf-precio-sucio').value   = rf.precio_sucio    ?? '';
      document.getElementById('rf-precio-limpio').value  = rf.precio_limpio   ?? '';
      document.getElementById('rf-cupon').value          = rf.tasa_cupon      ?? '';
      document.getElementById('rf-frecuencia').value     = rf.frecuencia_cupon || '';
      document.getElementById('rf-moneda-emision').value = rf.moneda_emision  || '';
      document.getElementById('rf-emisor').value         = rf.emisor          || '';
      document.getElementById('rf-amortiza').checked     = !!rf.amortiza;
    }
    if (inst.futuro) {
      const f = inst.futuro;
      document.getElementById('fut-contrato').value       = f.contrato          || '';
      document.getElementById('fut-subyacente').value     = f.activo_subyacente || '';
      document.getElementById('fut-vencimiento').value    = f.mes_vencimiento   || '';
      document.getElementById('fut-precio-ajuste').value  = f.precio_ajuste     ?? '';
      document.getElementById('fut-margen-inicial').value = f.margen_inicial    ?? '';
      document.getElementById('fut-margen-var').value     = f.margen_variacion  ?? '';
      document.getElementById('fut-tick').value           = f.tick_size         ?? '';
      document.getElementById('fut-multiplicador').value  = f.multiplicador     ?? 1;
    }
  } else {
    document.getElementById('modalInstTitulo').textContent = 'Nuevo Instrumento';
    document.getElementById('inst-id').value          = '';
    document.getElementById('inst-especie').value     = '';
    document.getElementById('inst-especie').disabled  = false;
    document.getElementById('inst-tipo').value        = 'ACCION';
    document.getElementById('inst-moneda').value      = 'ARP';
    document.getElementById('inst-mercado').value     = '';
    document.getElementById('inst-descripcion').value = '';
  }
  instActualizarSubtabs();
  switchInstTab('base');
  document.getElementById('modalInstrumento').classList.add('active');
}

async function guardarInstrumento() {
  const resEl   = document.getElementById('instResult');
  resEl.textContent = '';
  const id      = document.getElementById('inst-id').value;
  const especie = document.getElementById('inst-especie').value.trim().toUpperCase();
  const tipo    = document.getElementById('inst-tipo').value;
  const moneda  = document.getElementById('inst-moneda').value;
  const mercado = document.getElementById('inst-mercado').value.trim() || null;
  const desc    = document.getElementById('inst-descripcion').value.trim() || null;
  if (!especie) { _showResultErr(resEl, 'La especie es requerida.'); return; }
  const btn = document.getElementById('instGuardarBtn');

  await _withButtonLoading(btn, async () => {
    try {
      let res;
      if (id) {
        res = await _apiFetchJson(`/api/instrumentos/${id}`, 'PATCH',
          { descripcion: desc, mercado_principal: mercado });
      } else {
        res = await _apiFetchJson('/api/instrumentos', 'POST',
          { especie, tipo, moneda, mercado_principal: mercado, descripcion: desc });
      }
      if (!res.ok) {
        const err = await res.json();
        _showResultErr(resEl, err.detail || 'Error al guardar');
        return;
      }
      const saved = await res.json();
      _instCurrentId = saved.id;
      document.getElementById('inst-id').value         = saved.id;
      document.getElementById('inst-especie').disabled = true;
      _showResultOk(resEl, `Guardado. ID: ${saved.id}`);
      await cargarInstrumentos();
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

async function toggleInstrumentoActivo(id, activo) {
  return _togglePatch(`/api/instrumentos/${id}`, { activo }, cargarInstrumentos);
}

async function guardarDetalleRentaFija(btn) {
  const resEl = document.getElementById('rfResult');
  resEl.textContent = '';
  if (!_instCurrentId) { _showResultErr(resEl, 'Guardá primero el instrumento.'); return; }
  const body = {
    tir_referencia:    parseFloatOrNull(document.getElementById('rf-tir').value),
    duration:          parseFloatOrNull(document.getElementById('rf-duration').value),
    fecha_vencimiento: document.getElementById('rf-vencimiento').value || null,
    precio_sucio:      parseFloatOrNull(document.getElementById('rf-precio-sucio').value),
    precio_limpio:     parseFloatOrNull(document.getElementById('rf-precio-limpio').value),
    tasa_cupon:        parseFloatOrNull(document.getElementById('rf-cupon').value),
    frecuencia_cupon:  document.getElementById('rf-frecuencia').value || null,
    moneda_emision:    document.getElementById('rf-moneda-emision').value.trim() || null,
    emisor:            document.getElementById('rf-emisor').value.trim() || null,
    amortiza:          document.getElementById('rf-amortiza').checked,
  };
  await _withButtonLoading(btn, async () => {
    try {
      const res = await _apiFetchJson(`/api/instrumentos/${_instCurrentId}/renta-fija`, 'PUT', body);
      if (!res.ok) { const e = await res.json(); _showResultErr(resEl, e.detail || 'Error'); return; }
      _showResultOk(resEl, 'Detalle RF guardado.');
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

async function guardarDetalleFuturo(btn) {
  const resEl = document.getElementById('futResult');
  resEl.textContent = '';
  if (!_instCurrentId) { _showResultErr(resEl, 'Guardá primero el instrumento.'); return; }
  const body = {
    contrato:          document.getElementById('fut-contrato').value.trim() || null,
    activo_subyacente: document.getElementById('fut-subyacente').value.trim() || null,
    mes_vencimiento:   document.getElementById('fut-vencimiento').value || null,
    precio_ajuste:     parseFloatOrNull(document.getElementById('fut-precio-ajuste').value),
    margen_inicial:    parseFloatOrNull(document.getElementById('fut-margen-inicial').value),
    margen_variacion:  parseFloatOrNull(document.getElementById('fut-margen-var').value),
    tick_size:         parseFloatOrNull(document.getElementById('fut-tick').value),
    multiplicador:     parseFloat(document.getElementById('fut-multiplicador').value) || 1.0,
  };
  await _withButtonLoading(btn, async () => {
    try {
      const res = await _apiFetchJson(`/api/instrumentos/${_instCurrentId}/futuro`, 'PUT', body);
      if (!res.ok) { const e = await res.json(); _showResultErr(resEl, e.detail || 'Error'); return; }
      _showResultOk(resEl, 'Detalle Futuro guardado.');
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

// ── Llamados a Margen ────────────────────────────────────────────────────────

async function cargarLlamados(instId) {
  await _cargarTabla('llamadosBody', 5, async (tbody) => {
    const res   = await apiFetch(`/api/instrumentos/${instId}/llamados-margen`);
    const data  = await res.json();
    const items = data.llamados_margen || [];
    if (!items.length) { tbody.innerHTML = _emptyTableRow(5, 'Sin llamados.'); return; }
    const estadoColor = { PENDIENTE:'#f0a500', INTEGRADO:'var(--green)', VENCIDO:'var(--red)' };
    tbody.innerHTML = items.map(ll => `
      <tr>
        <td style="font-size:11px">${esc(ll.fecha)}</td>
        <td style="font-size:11px">${esc(ll.cuenta_id)}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">$${fmt(ll.monto)}</td>
        <td><span style="font-size:10px;font-weight:600;color:${estadoColor[ll.estado]||'var(--text2)'}">${esc(ll.estado)}</span></td>
        <td>${ll.estado==='PENDIENTE'?`<button class="btn-mini" onclick="integrarLlamado(${ll.id})">Integrar</button>`:''}</td>
      </tr>
    `).join('');
  });
}

function abrirModalLlamado() {
  if (!_instCurrentId) { showToast('Guardá primero el instrumento.', 'warn'); return; }
  document.getElementById('llamadoInstEspecie').textContent = document.getElementById('inst-especie').value || '—';
  document.getElementById('lm-fecha').value       = new Date().toISOString().slice(0,10);
  document.getElementById('lm-cuenta').value      = '';
  document.getElementById('lm-monto').value       = '';
  document.getElementById('lm-descripcion').value = '';
  document.getElementById('llamadoResult').textContent = '';
  _clearFieldErrors(document.getElementById('modalLlamado'));
  document.getElementById('modalLlamado').classList.add('active');
}

async function guardarLlamado(btn) {
  const resEl    = document.getElementById('llamadoResult');
  const modal    = document.getElementById('modalLlamado');
  _clearFieldErrors(modal);
  resEl.textContent = '';
  const cuentaId = parseInt(document.getElementById('lm-cuenta').value);
  const monto    = parseFloat(document.getElementById('lm-monto').value);
  const fecha    = document.getElementById('lm-fecha').value;
  const desc     = document.getElementById('lm-descripcion').value.trim() || null;
  let hasError = false;
  if (!fecha)         { _setFieldError('lm-fecha',  'La fecha es requerida.'); hasError = true; }
  if (!(cuentaId > 0)){ _setFieldError('lm-cuenta', 'Seleccioná una cuenta.'); hasError = true; }
  if (!(monto > 0))   { _setFieldError('lm-monto',  'Ingresá un monto válido.'); hasError = true; }
  if (hasError) return;
  await _withButtonLoading(btn, async () => {
    try {
      const res = await _apiFetchJson(`/api/instrumentos/${_instCurrentId}/llamados-margen`, 'POST',
        { cuenta_id: cuentaId, fecha, monto, descripcion: desc });
      if (!res.ok) { const e = await res.json(); _showResultErr(resEl, e.detail || 'Error'); return; }
      document.getElementById('modalLlamado').classList.remove('active');
      await cargarLlamados(_instCurrentId);
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

async function integrarLlamado(llamadoId) {
  try {
    const res = await apiFetch(`/api/instrumentos/llamados-margen/${llamadoId}/integrar`, { method: 'POST' });
    if (!res.ok) { const e=await res.json(); showToast(e.detail||'Error al integrar','error'); return; }
    showToast('Llamado integrado.','ok');
    if (_instCurrentId) await cargarLlamados(_instCurrentId);
  } catch(e) { showToast(e.message,'error'); }
}

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
