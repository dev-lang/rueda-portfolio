// ── CONSTANTS ──────────────────────────────────────────────────────────────
const TOAST_DURATION_OK       = 3500;  // ms — success/info toasts
const TOAST_DURATION_ERROR    = 6000;  // ms — error toasts stay longer
const MOV_PER_PAGE            = 20;    // rows per page for movement tables
const LIQ_PER_PAGE            = 50;    // rows per page for liquidaciones
const OB_DEBOUNCE_MS          = 600;   // ms — orderbook fetch debounce
const SEARCH_DEBOUNCE_MS      = 180;   // ms — global search debounce
const RECONNECT_FAIL_MS       = 30_000; // ms — show "Sin conexión" banner after this
const CONFIRM_AUTODISMISS_MS  = 10 * 60 * 1000; // 10 min — auto-close stale confirm dialogs
const STATUS_EVENT_DURATION_MS = 5000; // ms — how long status event text stays visible

// ── TOAST SYSTEM ───────────────────────────────────────────────────────────
/**
 * showToast(msg, type, title)
 *  type: 'ok' | 'error' | 'warn'  (default 'ok')
 *  Replaces native alert() for non-blocking user feedback.
 */
const TOAST_MAX = 4;  // max simultaneous toasts before evicting the oldest

/**
 * showToast(msg, type, title, opts)
 *  opts.persist  — if true, toast stays until manually closed (M18)
 *  opts.onRetry  — if provided, shows a "Reintentar" button (M23)
 */
function showToast(msg, type = 'ok', title = '', opts = {}) {
  const container = document.getElementById('toast-container');
  if (!container) { alert(msg); return; }

  // Evict oldest toast if at the limit
  const existing = container.querySelectorAll('.toast');
  if (existing.length >= TOAST_MAX) existing[0].remove();

  const icons  = { ok: '✓', error: '✗', warn: '⚠' };
  const titles = { ok: title || 'Listo', error: title || 'Error', warn: title || 'Atención' };
  const retryBtn = opts.onRetry
    ? `<button class="toast-retry" aria-label="Reintentar">Reintentar</button>`
    : '';

  const el = document.createElement('div');
  el.className = `toast toast-${type}${opts.persist ? ' toast-persist' : ''}`;
  el.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <div class="toast-body">
      <div class="toast-title">${titles[type]}</div>
      <div class="toast-msg">${esc(msg)}</div>
      ${retryBtn}
    </div>
    <button class="toast-close" data-action="close-toast" aria-label="Cerrar notificación">×</button>
  `;
  if (opts.onRetry) {
    el.querySelector('.toast-retry').addEventListener('click', () => { el.remove(); opts.onRetry(); });
  }
  container.appendChild(el);

  if (!opts.persist) {
    setTimeout(() => {
      el.classList.add('toast-exit');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, type === 'error' ? TOAST_DURATION_ERROR : TOAST_DURATION_OK);
  }
}

// ── AUTH / SESSION ─────────────────────────────────────────────────────────
/**
 * Drop-in fetch wrapper that:
 *  - Always sends httpOnly cookies (credentials: 'include')
 *  - Redirects to /login on HTTP 401 (expired/missing token)
 */
async function apiFetch(url, opts = {}) {
  const signal = opts.signal ?? state?.navController?.signal;
  let res;
  try {
    res = await fetch(url, { ...opts, credentials: 'include', signal });
  } catch (e) {
    // AbortError fires when the user navigated away mid-request (navController.abort()).
    // The view that issued this fetch is gone, so letting the caller's .catch() run
    // would write "Error: signal is aborted..." into the stale DOM of the hidden view.
    // Instead we return a never-resolving promise: the caller hangs harmlessly and
    // its closures are released when the view is re-rendered on re-entry.
    if (e?.name === 'AbortError') return new Promise(() => {});
    throw e;
  }
  if (res.status === 401) {
    window.location.href = '/login';
    // Throw so catch blocks in callers run and can clean up the UI
    throw new Error('401 No autenticado — redirigiendo al login');
  }
  return res;
}

// Helper: true if an error came from a fetch aborted by navigation (defense in depth).
function _isAbort(e) { return e?.name === 'AbortError'; }

async function logout() {
  // Detach all socket listeners before redirecting to prevent listener duplication
  // if the session is later reused within the same page lifetime
  if (state.socket) {
    state.socket.off();
    state.socket.disconnect();
    state.socket = null;
  }
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  window.location.href = '/login';
}

// ── XSS SANITIZATION ───────────────────────────────────────────────────────
/**
 * Escapes HTML special characters to prevent XSS when inserting
 * server-supplied strings into innerHTML contexts.
 */
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── DEBOUNCE ────────────────────────────────────────────────────────────────
function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── ERROR LOGGING (B38) ────────────────────────────────────────────────────
/**
 * Centralized error logger. Drop-in for console.error that can be wired
 * to a monitoring service (Sentry, LogRocket, etc.) without changing call sites.
 * Add ?debug=1 to the URL to see stack traces in the browser console.
 */
function _logError(context, err) {
  // Aborts from navController.abort() are expected control flow, not errors.
  if (_isAbort(err)) return;
  const isDebug = new URLSearchParams(window.location.search).has('debug');
  if (isDebug) {
    console.error(`[${context}]`, err);
  } else {
    console.warn(`[${context}] ${err?.message || err}`);
  }
  // Replace this comment with: Sentry.captureException(err, { extra: { context } });
}

// ── CENTRALIZED API ERROR MESSAGES (C2) ────────────────────────────────────
/**
 * Extracts a user-friendly message from a failed API response.
 * Differentiates: validation (400/422), forbidden (403), server (500), network.
 */
function _apiErrMsg(res, result, fallback = 'Error inesperado.') {
  if (!res) return fallback;
  const detail = result?.detail;
  if (res.status === 422 || res.status === 400) {
    if (Array.isArray(detail)) return detail.map(d => d.msg || d.message || JSON.stringify(d)).join(' · ');
    return typeof detail === 'string' ? detail : fallback;
  }
  if (res.status === 403) return 'Sin permisos para realizar esta acción.';
  if (res.status === 404) return 'Recurso no encontrado.';
  if (res.status >= 500) return 'Error interno del servidor.';
  if (detail?.mensaje) return detail.mensaje;
  if (typeof detail === 'string') return detail;
  return fallback;
}

// ── UNSAVED CHANGES GUARD (M25) ───────────────────────────────────────────
/**
 * Mark a modal as "dirty" (has unsaved user input).
 * Call _watchModalDirty(modalId) after opening a form modal.
 * The close handler will ask for confirmation if there are unsaved changes.
 */
function _watchModalDirty(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.removeAttribute('data-dirty');
  const inputs = modal.querySelectorAll('input:not([type=hidden]), select, textarea');
  const mark = () => modal.setAttribute('data-dirty', '1');
  inputs.forEach(el => el.addEventListener('input', mark, { once: true }));
}

function _checkModalDirty(modalId, onConfirm) {
  const modal = document.getElementById(modalId);
  if (!modal || !modal.hasAttribute('data-dirty')) { onConfirm(); return; }
  _confirmar(
    'Cambios sin guardar',
    'Tenés cambios que no se guardaron. ¿Cerrar de todas formas?',
    () => { modal.removeAttribute('data-dirty'); onConfirm(); }
  );
}

// ── MODAL FOCUS MANAGER (C3) ───────────────────────────────────────────────
/** Save/restore focus so keyboard users return to the trigger after closing. */
const _modalFocusStack = [];
function _pushModalFocus() { _modalFocusStack.push(document.activeElement); }
function _popModalFocus()  {
  const el = _modalFocusStack.pop();
  if (el?.focus) requestAnimationFrame(() => el.focus());
}

// ── FIELD-LEVEL VALIDATION HELPERS (A1) ───────────────────────────────────
/** Show an inline error message below the given form field wrapper. */
function _setFieldError(fieldId, msg) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  field.classList.add('input-error');
  let span = field.parentElement.querySelector('.field-error');
  if (!span) { span = document.createElement('span'); span.className = 'field-error'; field.parentElement.appendChild(span); }
  span.textContent = msg;
}
/** Clear all inline errors inside a form element. */
function _clearFieldErrors(formEl) {
  formEl.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
  formEl.querySelectorAll('.field-error').forEach(el => el.remove());
}

// ── DATE FORMATTING HELPERS (A7) ───────────────────────────────────────────
/**
 * Format an ISO datetime string to "DD/MM/YYYY HH:MM" using Argentine locale.
 * Accepts both "2025-03-21T10:04:00" and "2025-03-21 10:04:00" forms.
 */
function _fmtDatetime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d)) return String(isoStr).slice(0, 16).replace('T', ' ');
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── CELL FLASH ──────────────────────────────────────────────────────────────
/** Briefly highlight a table cell to signal a live value change. */
function _flashCell(el) {
  el.classList.remove('cell-flash');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.add('cell-flash');
      el.addEventListener('animationend', () => el.classList.remove('cell-flash'), { once: true });
    });
  });
}

// ── BUTTON LOADING HELPER ─────────────────────────────────────────────────
/**
 * Disables btn, sets loading HTML, runs asyncFn, then restores btn state.
 * Works whether the button has icons (innerHTML) or plain text.
 */
async function _withButtonLoading(btn, asyncFn, loadingHTML = 'Guardando...') {
  const origHTML = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = loadingHTML; }
  try {
    return await asyncFn();
  } finally {
    if (btn) { btn.disabled = false; if (origHTML != null) btn.innerHTML = origHTML; }
  }
}

// ── JSON FETCH HELPER ─────────────────────────────────────────────────────
/**
 * Shorthand for apiFetch with Content-Type: application/json.
 * Pass data=null for bodyless requests (DELETE, POST without body).
 */
async function _apiFetchJson(url, method = 'POST', data = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (data != null) opts.body = JSON.stringify(data);
  return apiFetch(url, opts);
}

// ── RESULT ELEMENT HELPERS ────────────────────────────────────────────────
/** Show an error message in a result/status element. */
function _showResultErr(el, msg) {
  if (!el) return;
  el.style.color = 'var(--red)';
  el.textContent = msg;
}
/** Show a success message in a result/status element. */
function _showResultOk(el, msg) {
  if (!el) return;
  el.style.color = 'var(--green)';
  el.textContent = msg;
}

// ── TBODY LOADING HELPER ─────────────────────────────────────────────────
/** Set a tbody to a single "Cargando..." row while data is being fetched. */
function _setTbodyLoading(tbody, colSpan = 6) {
  if (tbody) tbody.innerHTML = `<tr><td colspan="${colSpan}" class="text-muted">Cargando...</td></tr>`;
}

// ── LOADING MESSAGE HELPER ────────────────────────────────────────────────
/** Show a spinner + message inside a result element during an async action. */
function _setLoadingMessage(el, msg = 'Procesando...') {
  if (el) el.innerHTML = `<span class="spinner-inline"></span> ${msg}`;
}

// ── PAGINATION BUTTONS HELPER ─────────────────────────────────────────────
/**
 * Build the prev / page-number / next button HTML for a pagination bar.
 * @param {number} page    Current page (1-based)
 * @param {number} pages   Total pages
 * @param {string} action  data-action value for each button
 * @returns {string} HTML string — assign to element.innerHTML
 */
function _renderPageBtns(page, pages, action) {
  const start = Math.max(1, page - 2);
  const end   = Math.min(pages, page + 2);
  let btns = `<button class="page-btn" data-action="${action}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Ant.</button>`;
  for (let i = start; i <= end; i++) {
    btns += `<button class="page-btn ${i === page ? 'active' : ''}" data-action="${action}" data-page="${i}">${i}</button>`;
  }
  btns += `<button class="page-btn" data-action="${action}" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Sig. ›</button>`;
  return btns;
}

// ── DATA MAP HELPER ───────────────────────────────────────────────────────
/**
 * Convert an array of objects into a keyed map for O(1) lookup.
 * @param {Array}  items    Source array
 * @param {string} keyField Property to use as the map key (default 'id')
 */
function _buildDataMap(items, keyField = 'id') {
  return Object.fromEntries(items.map(item => [item[keyField], item]));
}

// ── EMPTY TABLE ROW HELPER ────────────────────────────────────────────────
/** Returns a single-row colspan cell with a "no data" message. */
function _emptyTableRow(colSpan, msg) {
  return `<tr><td colspan="${colSpan}" class="text-muted">${msg}</td></tr>`;
}

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

// ── FORMATO ────────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  return Number(n).toLocaleString('es-AR');
}

// ── SKELETON LOADING ────────────────────────────────────────────────────────
function _showSkeleton(tbodyId, cols, rows = 8) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const cell = '<td><div style="height:10px;border-radius:2px"></div></td>';
  tbody.innerHTML = Array.from({ length: rows }, () =>
    `<tr class="skeleton-row loading-row">${cell.repeat(cols)}</tr>`
  ).join('');
}

// ── SPARKLINE SVG ───────────────────────────────────────────────────────────
function _isoToday() { return new Date().toISOString().slice(0, 10); }
function _isoMinus(days) {
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

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

// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: ESTADO DE ÓRDENES
// ══════════════════════════════════════════════════════════════════════════════

async function cargarOrdenes(showSpinner = true) {
  if (showSpinner) {
    _showSkeleton('ordersBody', 12);
  }

  const btn = document.querySelector('.btn-refresh');
  if (btn) btn.classList.add('spinning');

  const especie     = document.getElementById('filtroEspecie').value;
  const cliente     = document.getElementById('filtroCliente').value;
  const estadoColor = document.getElementById('filtroEstado').value;
  const fechaDesde  = document.getElementById('filtroFechaDesde').value;
  const fechaHasta  = document.getElementById('filtroFechaHasta').value;

  const params = new URLSearchParams({
    especie, cliente,
    page: state.currentPage,
    per_page: state.perPage,
  });
  if (estadoColor) params.set('estado_color', estadoColor);
  if (fechaDesde)  params.set('fecha_desde', fechaDesde);
  if (fechaHasta)  params.set('fecha_hasta', fechaHasta);

  try {
    const res = await apiFetch(`/api/ordenes?${params}`);
    const data = await res.json();

    state.ordenes = data.ordenes;
    state.totalPages = data.pages;

    renderTabla(data.ordenes);
    renderPaginacion(data.total, data.current_page, data.pages);
    actualizarEstadisticas();
  } catch (e) {
    document.getElementById('ordersBody').innerHTML =
      `<tr class="loading-row"><td colspan="12">Error al cargar datos.</td></tr>`;
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

function renderTabla(ordenes) {
  const tbody = document.getElementById('ordersBody');
  if (!ordenes.length) {
    tbody.innerHTML = _emptyStateHtml(
      [['Especie','filtroEspecie'],['Cliente','filtroCliente'],['Estado','filtroEstado']],
      '_limpiarFiltrosOrdenes', 12);
    return;
  }
  tbody.innerHTML = ordenes.map(o => {
    const isNew = !_knownOrderIds.has(o.id);
    if (isNew) _knownOrderIds.add(o.id);
    return renderRow(o, isNew);
  }).join('');
  _reapplySort(document.getElementById('ordersTable'));
}

const _knownOrderIds = new Set();   // tracks IDs already seen to detect new rows

function renderRow(o, isNew = false) {
  const pct = o.progreso;
  const isFull = pct >= 100;
  return `
    <tr class="${isNew ? 'new-flash' : ''} row-${o.estado_color}" data-id="${o.id}" data-action="ver-detalle">
      <td><span class="tipo-badge tipo-${o.tipo_orden}">${o.tipo_orden}</span></td>
      <td><span class="nro-cell">${o.nro_orden}</span></td>
      <td>${o.fecha_orden}</td>
      <td>${o.cliente}</td>
      <td>${o.razon_social}</td>
      <td><span class="especie-tag">${o.especie}</span></td>
      <td class="precio-cell">${o.moneda}</td>
      <td class="precio-cell">${o.tipo_precio === 'MERCADO' ? '<span style="color:var(--accent);font-size:10px">MKT</span>' : fmt(o.precio_limite)}</td>
      <td>
        <div class="progress-wrap">
          <div class="progress-bar">
            <div class="progress-fill ${isFull ? 'full' : ''}" style="width:${pct}%"></div>
          </div>
          <div class="progress-pct">${pct}%</div>
        </div>
      </td>
      <td><span class="ejec-cell">${o.ejecutado_total}</span></td>
      <td class="precio-cell">${o.precio_promedio > 0 ? fmt(o.precio_promedio) : '—'}</td>
      <td>
        <span class="inst-badge inst-${o.estado_color}">
          [${o.instancia_codigo}] ${o.instancia}
        </span>
      </td>
    </tr>`;
}

function updateOrdenEnTabla(orden) {
  const tbody = document.getElementById('ordersBody');
  const oldRow = tbody.querySelector(`tr[data-id="${orden.id}"]`);
  if (!oldRow) return;

  const pct = orden.progreso;
  const isFull = pct >= 100;
  oldRow.className = `updated-flash row-${orden.estado_color}`;
  oldRow.innerHTML = `
    <td><span class="tipo-badge tipo-${orden.tipo_orden}">${orden.tipo_orden}</span></td>
    <td><span class="nro-cell">${orden.nro_orden}</span></td>
    <td>${orden.fecha_orden}</td>
    <td>${orden.cliente}</td>
    <td>${orden.razon_social}</td>
    <td><span class="especie-tag">${orden.especie}</span></td>
    <td class="precio-cell">${orden.moneda}</td>
    <td class="precio-cell">${orden.tipo_precio === 'MERCADO' ? '<span style="color:var(--accent);font-size:10px">MKT</span>' : fmt(orden.precio_limite)}</td>
    <td>
      <div class="progress-wrap">
        <div class="progress-bar">
          <div class="progress-fill ${isFull ? 'full' : ''}" style="width:${pct}%"></div>
        </div>
        <div class="progress-pct">${pct}%</div>
      </div>
    </td>
    <td><span class="ejec-cell">${orden.ejecutado_total}</span></td>
    <td class="precio-cell">${orden.precio_promedio > 0 ? fmt(orden.precio_promedio) : '—'}</td>
    <td><span class="inst-badge inst-${orden.estado_color}">[${orden.instancia_codigo}] ${orden.instancia}</span></td>
  `;

  const idx = state.ordenes.findIndex(o => o.id === orden.id);
  if (idx !== -1) state.ordenes[idx] = orden;
}

function renderPaginacion(total, page, pages) {
  const info = document.getElementById('paginationInfo');
  const ctrl = document.getElementById('paginationControls');

  const from = total === 0 ? 0 : (page - 1) * state.perPage + 1;
  const to = Math.min(page * state.perPage, total);
  info.textContent = `Mostrando ${from}–${to} de ${total} órdenes`;

  ctrl.innerHTML = _renderPageBtns(page, pages, 'go-page');
  state.currentPage = page;
  state.totalPages = pages;
}

function goPage(p) {
  if (p < 1 || p > state.totalPages) return;
  state.currentPage = p;
  cargarOrdenes();
}

async function actualizarEstadisticas() {
  try {
    const res = await apiFetch('/api/reports/summary');
    const s = await res.json();
    document.getElementById('stat-total').textContent = s.ordenes_total;
    document.getElementById('stat-ejecutadas').textContent = s.ordenes_ejecutadas;
    document.getElementById('stat-pendientes').textContent = s.ordenes_pendientes;
    document.getElementById('stat-errores').textContent = s.ordenes_error;
  } catch(e) {}
}

// ── NOTIFICACIONES ─────────────────────────────────────────────────────────
/** Returns all notification containers (panel + dropdown body). */
function _notifContainers() {
  return [
    document.getElementById('notifLog'),
    document.getElementById('notifDropdownBody'),
  ].filter(Boolean);
}

async function cargarNotificaciones() {
  const res = await apiFetch('/api/notificaciones');
  const data = await res.json();
  _notifContainers().forEach(log => { log.innerHTML = ''; });
  data.forEach(n => prependNotificacion(n, false));
  _notifContainers().forEach(log => { log.scrollTop = log.scrollHeight; });
}

function prependNotificacion(n, animate = true) {
  if (animate) {
    _notifUnread++;
    _updateNotifBadge();
  }

  _notifContainers().forEach(log => {
    const placeholder = log.querySelector('.notif-placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = `notif-item notif-${n.tipo}`;
    if (!animate) div.style.animation = 'none';
    div.innerHTML = `
      <span class="notif-ts">${esc(n.timestamp)}</span>
      <span class="notif-srv">[${esc(n.servicio)}]</span>
      <span class="notif-msg">${esc(n.mensaje)}</span>
    `;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 80) log.removeChild(log.firstChild);
  });
}

function limpiarNotificaciones() {
  _notifContainers().forEach(log => {
    log.innerHTML = '<div class="notif-placeholder">Log limpiado</div>';
  });
}

// ── DETALLE ORDEN (MODAL) ──────────────────────────────────────────────────
let _lastDetalleOrden = null;

async function verDetalle(ordenId) {
  state.modalOrdenId = ordenId;

  const res = await apiFetch(`/api/ordenes/${ordenId}/ejecuciones`);
  const data = await res.json();
  const o = data.orden;
  _lastDetalleOrden = o;

  document.getElementById('modalOrdenNro').textContent = o.nro_orden;
  document.getElementById('modalOrdenInfo').textContent =
    `${o.tipo_orden} · ${o.especie} · ${o.razon_social} · ID: ${o.id}`;

  document.getElementById('modalDetallGrid').innerHTML = `
    <div class="detail-item"><div class="detail-item-label">ID</div><div class="detail-item-value">${esc(o.id)}</div></div>
    <div class="detail-item"><div class="detail-item-label">Tipo</div><div class="detail-item-value">${esc(o.tipo_orden)}</div></div>
    <div class="detail-item"><div class="detail-item-label">Especie</div><div class="detail-item-value">${esc(o.especie)}</div></div>
    <div class="detail-item"><div class="detail-item-label">Moneda</div><div class="detail-item-value">${esc(o.moneda)}</div></div>
    <div class="detail-item"><div class="detail-item-label">Precio Límite</div><div class="detail-item-value">${o.tipo_precio === 'MERCADO' ? 'MERCADO' : fmt(o.precio_limite)}</div></div>
    <div class="detail-item"><div class="detail-item-label">Precio Prom.</div><div class="detail-item-value">${o.precio_promedio > 0 ? fmt(o.precio_promedio) : '—'}</div></div>
    <div class="detail-item"><div class="detail-item-label">Progreso</div><div class="detail-item-value">${esc(o.progreso)}%</div></div>
    <div class="detail-item"><div class="detail-item-label">Ejecutado</div><div class="detail-item-value">${esc(o.ejecutado_total)}</div></div>
    <div class="detail-item"><div class="detail-item-label">Instancia</div><div class="detail-item-value"><span class="inst-badge inst-${esc(o.estado_color)}">[${esc(o.instancia_codigo)}] ${esc(o.instancia)}</span></div></div>
    <div class="detail-item"><div class="detail-item-label">Fecha</div><div class="detail-item-value">${esc(o.fecha_orden)}</div></div>
  `;

  const tbody = document.getElementById('modalEjecuciones');
  if (!data.ejecuciones.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Sin ejecuciones registradas</td></tr>`;
  } else {
    tbody.innerHTML = data.ejecuciones.map(e => `
      <tr>
        <td>${esc(e.fecha)}</td>
        <td class="ejec-cell">${fmtInt(e.cantidad)}</td>
        <td class="precio-cell">${fmt(e.precio)}</td>
        <td class="importe-cell">${e.comision ? fmt(e.comision.monto_total) : '—'}</td>
        <td>${esc(e.mercado)}</td>
        <td class="precio-cell">${esc(e.nro_secuencia)}</td>
      </tr>
    `).join('');
  }

  // Show/hide action buttons based on order state
  const isTerminal = o.instancia === 'Ejecutada' || o.instancia === 'Cancelada';
  document.getElementById('btnCancelarOrden').style.display = isTerminal ? 'none' : '';
  document.getElementById('btnModificar').style.display = isTerminal ? 'none' : '';
  document.getElementById('modalModifyForm').style.display = 'none';
  document.getElementById('modResult').textContent = '';
  document.getElementById('mod-precio').value = '';
  document.getElementById('mod-cantidad').value = '';

  document.getElementById('modalDetalle').classList.add('active');
}

function toggleModifyForm() {
  const form = document.getElementById('modalModifyForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function cancelarOrdenDesdeModal() {
  if (!state.modalOrdenId) return;
  _confirmar(
    'Cancelar Orden',
    '¿Cancelar esta orden? Esta acción quedará registrada en el audit log.',
    async () => {
      const res = await apiFetch(`/api/ordenes/${state.modalOrdenId}/cancelar`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        cerrarModalDirecto();
        cargarOrdenes(false);
        actualizarEstadisticas();
        setStatusEvent('Orden cancelada');
        showToast('Orden cancelada correctamente.', 'ok', 'Cancelación');
      } else {
        showToast(data.detail || 'No se pudo cancelar la orden.', 'error');
      }
    }
  );
}

async function confirmarModificacion() {
  if (!state.modalOrdenId) return;
  const precioStr = document.getElementById('mod-precio').value;
  const cantStr   = document.getElementById('mod-cantidad').value;
  const resultEl  = document.getElementById('modResult');

  if (!precioStr && !cantStr) {
    resultEl.className = 'execute-result err';
    resultEl.textContent = 'Ingresá al menos un campo a modificar.';
    return;
  }

  const payload = {};
  if (precioStr)  payload.precio_limite  = parseFloat(precioStr);
  if (cantStr)    payload.cantidad_total  = parseInt(cantStr);

  const res = await apiFetch(`/api/ordenes/${state.modalOrdenId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  if (res.ok) {
    resultEl.className = 'execute-result ok';
    resultEl.textContent = `✓ Orden modificada correctamente.`;
    cargarOrdenes(false);
    // Refresh modal with updated data
    verDetalle(state.modalOrdenId);
  } else {
    resultEl.className = 'execute-result err';
    resultEl.textContent = `✗ ${data.detail}`;
  }
}

function cerrarModal(event) {
  if (event.target === document.getElementById('modalDetalle')) cerrarModalDirecto();
}
function cerrarModalDirecto() {
  document.getElementById('modalDetalle').classList.remove('active');
  _popModalFocus();
}

function duplicarOrden() {
  const o = _lastDetalleOrden;
  if (!o) return;
  cerrarModalDirecto();
  abrirModalOrden();
  document.getElementById('f-especie').value           = o.especie   || '';
  document.getElementById('f-tipo').value              = o.tipo_orden || 'LIMC';
  document.getElementById('f-moneda').value            = o.moneda    || 'ARP';
  document.getElementById('f-tipo-precio').value       = o.tipo_precio || 'LIMITE';
  document.getElementById('f-precio').value            = o.tipo_precio !== 'MERCADO' ? (o.precio_limite || '') : '';
  document.getElementById('f-cantidad').value          = o.cantidad_total || '';
  const fCliente = document.getElementById('f-cliente');
  if (fCliente && !fCliente.disabled) fCliente.value   = o.cliente || 'STD';
  togglePrecioLimite();
  _syncRazonSocial();
  _actualizarImporte();
  if (o.especie && o.especie.length >= 2) {
    document.getElementById('obPanel').innerHTML = '<div class="ob-loading">Cargando puntas...</div>';
    setTimeout(() => cargarOrderbook(o.especie), 300);
  }
}

// ── NUEVA ORDEN ────────────────────────────────────────────────────────────
/** Resets all fields of the Nueva Orden form to their default state. */
function _resetNuevaOrdenForm() {
  ['f-especie', 'f-precio', 'f-cantidad', 'f-cant-visible', 'f-precio-activacion', 'f-fecha-exp'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('f-tipo').value = 'LIMC';
  document.getElementById('f-moneda').value = 'ARP';
  document.getElementById('f-tipo-precio').value = 'LIMITE';
  document.getElementById('f-tif').value = 'DAY';
  document.getElementById('f-tipo-activacion').value = '';
  const fDesk = document.getElementById('f-desk'); if (fDesk) fDesk.value = '';
  const fCliente = document.getElementById('f-cliente');
  if (fCliente && !fCliente.disabled) fCliente.value = fCliente.options[0]?.value || '';
  togglePrecioLimite();
  toggleFechaExp();
  togglePrecioActivacion();
  _actualizarImporte();
}

function abrirModalOrden() {
  _pushModalFocus();
  document.getElementById('modalNuevaOrden').classList.add('active');
  document.getElementById('obPanel').innerHTML =
    '<div class="ob-placeholder">Ingresá una especie para ver las puntas</div>';
  _actualizarImporte();
}

function _actualizarImporte() {
  const precio = parseFloat(document.getElementById('f-precio')?.value) || 0;
  const cant   = parseInt(document.getElementById('f-cantidad')?.value)  || 0;
  const el     = document.getElementById('f-importe-preview');
  if (!el) return;
  el.textContent = (precio && cant) ? `Importe est.: ${fmt(precio * cant)}` : 'Importe est.: —';
}
function cerrarModalNueva(event) {
  if (event.target === document.getElementById('modalNuevaOrden')) {
    document.getElementById('modalNuevaOrden').classList.remove('active');
    _popModalFocus();
  }
}

// ── ORDER BOOK ──────────────────────────────────────────────────────────────
let _obTimer = null;

function _refreshObSiAbierto() {
  const modal = document.getElementById('modalNuevaOrden');
  if (!modal || !modal.classList.contains('active')) return;
  const esp = document.getElementById('f-especie').value.trim().toUpperCase();
  if (esp.length >= 2 && (_especiesValidas.size === 0 || _especiesValidas.has(esp))) cargarOrderbook(esp);
}

document.getElementById('f-cliente')?.addEventListener('change', _syncRazonSocial);
document.getElementById('f-precio')?.addEventListener('input', _actualizarImporte);
document.getElementById('f-cantidad')?.addEventListener('input', _actualizarImporte);

document.getElementById('f-especie').addEventListener('input', function () {
  clearTimeout(_obTimer);
  const esp = this.value.trim().toUpperCase();
  if (esp.length < 2) {
    document.getElementById('obPanel').innerHTML =
      '<div class="ob-placeholder">Ingresá una especie para ver las puntas</div>';
    return;
  }
  // Only fetch orderbook for registered tickers
  if (_especiesValidas.size > 0 && !_especiesValidas.has(esp)) {
    document.getElementById('obPanel').innerHTML =
      '<div class="ob-placeholder">Especie no registrada</div>';
    return;
  }
  document.getElementById('obPanel').innerHTML = '<div class="ob-loading">Cargando puntas...</div>';
  _obTimer = setTimeout(() => cargarOrderbook(esp), OB_DEBOUNCE_MS);
});

async function cargarOrderbook(especie) {
  const panel = document.getElementById('obPanel');
  panel.innerHTML = '<div class="ob-loading">Cargando puntas...</div>';
  try {
    const res  = await apiFetch(`/api/orderbook/${encodeURIComponent(especie)}`);
    const data = await res.json();
    renderOrderbook(data);
  } catch {
    panel.innerHTML = '<div class="ob-error">Error al cargar puntas</div>';
  }
}

function renderOrderbook(data) {
  const panel = document.getElementById('obPanel');

  if (!data.tiene_datos) {
    panel.innerHTML = `<div class="ob-placeholder">Sin datos para <b>${esc(data.especie)}</b></div>`;
    return;
  }

  const fmt  = v => v == null ? '—' : Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQ = v => v == null ? '—' : Number(v).toLocaleString('es-AR');

  const badge = fuente => {
    if (fuente === 'sistema')  return '<span class="ob-badge ob-badge-yf">SIS</span>';
    return '';
  };

  // Max quantity for proportional depth bars
  const allQty = [...data.bids, ...data.asks].map(r => r.cantidad || 0).filter(Boolean);
  const maxQty = allQty.length ? Math.max(...allQty) : 1;

  // Header
  const varStr = data.variacion_pct != null
    ? `<span class="ob-var ${data.variacion_pct >= 0 ? 'ob-var-pos' : 'ob-var-neg'}">${data.variacion_pct >= 0 ? '+' : ''}${data.variacion_pct}%</span>`
    : '';
  const spreadTxt = data.spread != null
    ? `Spread: ${fmt(data.spread)} (${data.spread_pct}%)`
    : 'Spread: —';

  // 4-column layout: pair best bid[i] with best ask[i] on the same row.
  // Bids: DESC (best first). Asks: ASC (best first).
  const numRows = Math.max(data.bids.length, data.asks.length, 1);
  let rows = '';
  for (let i = 0; i < numRows; i++) {
    const bid = data.bids[i] || null;
    const ask = data.asks[i] || null;
    const bidPct = bid?.cantidad ? Math.round(bid.cantidad / maxQty * 100) : 0;
    const askPct = ask?.cantidad ? Math.round(ask.cantidad / maxQty * 100) : 0;
    rows += `<tr class="ob4-row">
      <td class="ob4-bid-qty" style="--d:${bidPct}%" ${bid ? `data-action="set-precio-ob" data-precio="${bid.precio}"` : ''}>${bid ? fmtQ(bid.cantidad) : ''}</td>
      <td class="ob4-bid-price" ${bid ? `data-action="set-precio-ob" data-precio="${bid.precio}"` : ''}>${bid ? fmt(bid.precio) + badge(bid.fuente) : ''}</td>
      <td class="ob4-ask-price" ${ask ? `data-action="set-precio-ob" data-precio="${ask.precio}"` : ''}>${ask ? fmt(ask.precio) + badge(ask.fuente) : ''}</td>
      <td class="ob4-ask-qty" style="--d:${askPct}%" ${ask ? `data-action="set-precio-ob" data-precio="${ask.precio}"` : ''}>${ask ? fmtQ(ask.cantidad) : ''}</td>
    </tr>`;
  }
  if (!data.bids.length && !data.asks.length) {
    rows = `<tr><td colspan="4" style="padding:8px 4px;color:var(--text3);font-size:11px;text-align:center">Sin puntas disponibles</td></tr>`;
  }

  panel.innerHTML = `
    <div class="ob-header">
      <div class="ob-especie-name">${esc(data.especie)}</div>
      <div class="ob-last-line">${data.ultimo != null ? fmt(data.ultimo) : '—'}${varStr}</div>
      <div class="ob-spread-line">${spreadTxt}</div>
    </div>
    <table class="ob-table ob4-table">
      <thead><tr>
        <th class="ob4-th ob4-th-r">Cant.</th>
        <th class="ob4-th ob4-th-r">Compra</th>
        <th class="ob4-th ob4-th-l">Venta</th>
        <th class="ob4-th ob4-th-l">Cant.</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="ob-mid">
      <span class="ob-mid-label">Último</span>
      <span class="ob-mid-precio">${data.ultimo != null ? fmt(data.ultimo) : '—'}</span>
    </div>
    <div class="ob-hint">↑ click en precio para autocompletar Precio Límite</div>
  `;
}

function setPrecioDesdeOB(precio) {
  // If the order modal is not open, open it first
  const modal = document.getElementById('modalNuevaOrden');
  if (modal && !modal.classList.contains('active')) abrirModalOrden();

  const inp = document.getElementById('f-precio');
  if (!inp) return;
  // Ensure precio límite field is visible
  const tipoPrecio = document.getElementById('f-tipo-precio');
  if (tipoPrecio && tipoPrecio.value === 'MERCADO') { tipoPrecio.value = 'LIMITE'; togglePrecioLimite(); }
  inp.value = precio;
  inp.classList.add('ob-filled');
  setTimeout(() => inp.classList.remove('ob-filled'), 1000);
  inp.focus();
  _actualizarImporte();
}

async function enviarNuevaOrden() {
  const btn = document.querySelector('#modalNuevaOrden .btn-nueva-orden[data-action="enviar-nueva-orden"]')
           || document.querySelector('#modalNuevaOrden button[type="submit"]')
           || document.querySelector('#modalNuevaOrden .modal-footer .btn-nueva-orden');
  if (btn?.disabled) return;

  // ── Read form values ───────────────────────────────────────────────────────
  const tipoPrecio  = document.getElementById('f-tipo-precio').value;
  const precioStr   = document.getElementById('f-precio').value;
  const cantStr     = document.getElementById('f-cantidad').value;
  const tif         = document.getElementById('f-tif').value;
  const fechaExp    = document.getElementById('f-fecha-exp').value;
  const cantVisible = document.getElementById('f-cant-visible').value;
  const tipoAct     = document.getElementById('f-tipo-activacion').value;
  const precioAct   = document.getElementById('f-precio-activacion').value;
  const deskVal     = document.getElementById('f-desk')?.value || '';
  const especie     = document.getElementById('f-especie').value.toUpperCase().trim();
  const cantidad    = parseInt(cantStr);

  // ── Validate BEFORE disabling button (prevents ghost-disabled state) ───────
  const form = document.getElementById('modalNuevaOrden');
  _clearFieldErrors(form);
  let hasError = false;

  if (!especie) {
    _setFieldError('f-especie', 'Ingresá una especie.');
    hasError = true;
  } else if (_especiesValidas.size > 0 && !_especiesValidas.has(especie)) {
    _setFieldError('f-especie', `"${especie}" no está registrada.`);
    hasError = true;
  }
  if (!cantidad || cantidad <= 0) {
    _setFieldError('f-cantidad', 'Ingresá una cantidad válida.');
    hasError = true;
  }
  if (tipoPrecio === 'LIMITE' && (!precioStr || parseFloat(precioStr) <= 0)) {
    _setFieldError('f-precio', 'Ingresá un precio límite válido.');
    hasError = true;
  }
  if (tif === 'GTD' && !fechaExp) {
    _setFieldError('f-fecha-exp', 'Requerido para orden GTD.');
    hasError = true;
  }
  if (tipoAct && (!precioAct || parseFloat(precioAct) <= 0)) {
    _setFieldError('f-precio-activacion', 'Ingresá el precio de activación.');
    hasError = true;
  }
  if (hasError) return;

  // ── All valid: lock button + show spinner ──────────────────────────────────
  const clienteVal = document.getElementById('f-cliente')?.value || 'STD';
  _syncRazonSocial();
  const data = {
    tipo_orden:     document.getElementById('f-tipo').value,
    especie,
    moneda:         document.getElementById('f-moneda').value,
    tipo_precio:    tipoPrecio,
    cantidad_total: cantidad,
    razon_social:   document.getElementById('f-razon').value,
    cliente:        clienteVal,
    time_in_force:  tif,
  };

  if (tipoPrecio === 'LIMITE') data.precio_limite = parseFloat(precioStr);
  if (tif === 'GTD' && fechaExp) data.fecha_exp = fechaExp;
  if (cantVisible && parseInt(cantVisible) > 0) data.cantidad_visible = parseInt(cantVisible);
  if (tipoAct) {
    data.tipo_activacion   = tipoAct;
    data.precio_activacion = parseFloat(precioAct);
  }
  if (deskVal) data.desk = deskVal;

  await _withButtonLoading(btn, async () => {
    try {
      const res    = await _apiFetchJson('/api/ordenes', 'POST', data);
      const result = await res.json();

      if (res.ok && result.success) {
        document.getElementById('modalNuevaOrden').classList.remove('active');
        _popModalFocus();
        _resetNuevaOrdenForm();
        state.currentPage = 1;
        cargarOrdenes(false);

        const alertMsg = result.alertas_riesgo?.length ? ` — ⚠ ${result.alertas_riesgo[0]}` : '';
        showToast('Orden creada correctamente.' + alertMsg, 'ok', 'Nueva Orden');
      } else {
        const detail = result.detail;
        if (detail && typeof detail === 'object' && detail.tipo === 'LIMITE_RIESGO') {
          showToast(detail.mensaje, 'error', 'Límite de Riesgo');
        } else {
          showToast(_apiErrMsg(res, result, 'No se pudo crear la orden.'), 'error');
        }
      }
    } catch(e) {
      if (e.message !== '401 No autenticado — redirigiendo al login') {
        _logError('enviarNuevaOrden', e);
        showToast('Error de red al crear la orden. Verificá tu conexión.', 'error');
      }
    }
  }, '<span class="spinner-inline"></span> Enviando...');
}

function togglePrecioLimite() {
  const tipo = document.getElementById('f-tipo-precio').value;
  const grupo = document.getElementById('f-precio-group');
  if (!grupo) return;
  const hide = tipo === 'MERCADO';
  grupo.style.display = hide ? 'none' : '';
  if (hide) { const f = document.getElementById('f-precio'); if (f) f.value = ''; }
}

function toggleFechaExp() {
  const tif = document.getElementById('f-tif').value;
  const grupo = document.getElementById('f-fecha-exp-group');
  if (!grupo) return;
  const show = tif === 'GTD';
  grupo.style.display = show ? '' : 'none';
  if (!show) { const f = document.getElementById('f-fecha-exp'); if (f) f.value = ''; }
}

function togglePrecioActivacion() {
  const tipo = document.getElementById('f-tipo-activacion').value;
  const grupo = document.getElementById('f-precio-activacion-group');
  if (!grupo) return;
  grupo.style.display = tipo ? '' : 'none';
  if (!tipo) { const f = document.getElementById('f-precio-activacion'); if (f) f.value = ''; }
}

function toggleOpcionesAvanzadas() {
  const el  = document.getElementById('opcionesAvanzadas');
  const btn = document.getElementById('btnOpAvanz');
  const open = el.style.display === 'none';
  el.style.display = open ? '' : 'none';
  btn.textContent = (open ? '▼' : '▶') + ' Opciones avanzadas (Iceberg / Stop-Loss / Take-Profit)';
}

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
        <td><span class="especie-tag">${esc(p.especie)}</span></td>
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
      <td><span class="especie-tag">${esc(p.especie)}</span></td>
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
      <td><span class="especie-tag">${esc(t.especie)}</span></td>
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

  const from = (page - 1) * state.txPerPage + 1;
  const to = Math.min(page * state.txPerPage, total);
  info.textContent = `Mostrando ${from}–${to} de ${total} ejecuciones`;

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

// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: HOME DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

async function cargarDashboard() {
  // Reset all KPI slots to loading state
  ['h-valor-cartera','h-pnl-no-realizado','h-pnl-realizado',
   'h-ordenes-pendientes','h-ordenes-error','h-fills-hoy',
   'h-tc-mep','h-tc-ccl'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '…';
  });
  document.getElementById('homeRiesgoAlerts').innerHTML =
    '<div style="color:var(--text3);font-size:12px">Cargando...</div>';

  try {
    const [summaryRes, benchRes, pnlRes, tcRes, pnlHistRes] = (await Promise.allSettled([
      apiFetch('/api/reports/summary'),
      apiFetch('/api/reports/benchmark'),
      apiFetch('/api/pnl/resumen'),
      apiFetch('/api/tipo-cambio/actual'),
      apiFetch(`/api/pnl?fecha_desde=${_isoMinus(13)}&fecha_hasta=${_isoToday()}`),
    ])).map(r => r.status === 'fulfilled' ? r.value : null);

    // Summary (ordenes counts + fills + volume)
    if (summaryRes?.ok) {
      const s = await summaryRes.json();
      document.getElementById('h-ordenes-pendientes').textContent = fmtInt(s.ordenes_pendientes ?? 0);
      document.getElementById('h-ordenes-error').textContent      = fmtInt(s.ordenes_error ?? 0);
      document.getElementById('h-fills-hoy').textContent          = fmtInt(s.fills_hoy ?? 0);
    }

    // Benchmark (valor cartera, P&L no realizado)
    if (benchRes?.ok) {
      const b = await benchRes.json();
      document.getElementById('h-valor-cartera').textContent = fmt(b.valor_actual ?? 0);
      const pnlNr = b.portfolio_pnl ?? 0;
      const pnlNrEl = document.getElementById('h-pnl-no-realizado');
      pnlNrEl.textContent = (pnlNr >= 0 ? '+' : '') + fmt(pnlNr);
      pnlNrEl.style.color = pnlNr > 0 ? 'var(--green)' : pnlNr < 0 ? 'var(--red)' : '';
      const cardNr = document.getElementById('h-card-pnl-nr');
      if (cardNr) { cardNr.classList.toggle('green', pnlNr > 0); cardNr.classList.toggle('red', pnlNr < 0); }
    }

    // PnL realizado hoy
    if (pnlRes?.ok) {
      const pnl = await pnlRes.json();
      const pr = pnl.pnl_realizado ?? 0;
      const pnlREl = document.getElementById('h-pnl-realizado');
      pnlREl.textContent = (pr >= 0 ? '+' : '') + fmt(pr);
      pnlREl.style.color = pr > 0 ? 'var(--green)' : pr < 0 ? 'var(--red)' : '';
      const cardR = document.getElementById('h-card-pnl-r');
      if (cardR) { cardR.classList.toggle('green', pr > 0); cardR.classList.toggle('red', pr < 0); }
    }

    // Tipo de cambio
    if (tcRes?.ok) {
      const tc = await tcRes.json();
      document.getElementById('h-tc-mep').textContent = tc.mep ? fmt(tc.mep) : '—';
      document.getElementById('h-tc-ccl').textContent = tc.ccl ? fmt(tc.ccl) : '—';
    }

    // Sparklines históricos P&L (últimos 14 días)
    if (pnlHistRes?.ok) {
      const { pnl: rows = [] } = await pnlHistRes.json();
      const byDate = {};
      rows.forEach(r => {
        byDate[r.fecha] = byDate[r.fecha] || { r: 0, nr: 0 };
        byDate[r.fecha].r  += r.pnl_realizado    || 0;
        byDate[r.fecha].nr += r.pnl_no_realizado || 0;
      });
      const dates = Object.keys(byDate).sort();
      if (dates.length >= 2) {
        _drawSparkline('sparkline-pnl-r',  dates.map(d => byDate[d].r));
        _drawSparkline('sparkline-pnl-nr', dates.map(d => byDate[d].nr));
      }
    }

    // Riesgo alerts (use STD portfolio)
    try {
      const riesgoRes = await apiFetch('/api/riesgo/cartera?cliente=STD');
      if (riesgoRes.ok) {
        const r = await riesgoRes.json();
        _renderDashboardAlerts(r);
      }
    } catch { /* skip risk if unavailable */ }

  } catch (e) {
    showToast('Error al cargar el dashboard.', 'error');
  }
}

function _renderDashboardAlerts(r) {
  const alerts = [];
  if (r.var_95_1d_pct > 0) {
    const cls = r.var_95_1d_pct > 3 ? 'red' : r.var_95_1d_pct > 1.5 ? 'orange' : '';
    alerts.push({ cls, text: `VaR 95% 1D: <strong>${r.var_95_1d_pct.toFixed(4)}%</strong>` });
  }
  if (r.sensibilidad_fx_1pct > 0) {
    alerts.push({ cls: '', text: `Sens. FX 1%: <strong>${fmt(r.sensibilidad_fx_1pct)}</strong> ARP` });
  }
  if (r.duration_ponderada > 0) {
    alerts.push({ cls: '', text: `Duration pond.: <strong>${r.duration_ponderada.toFixed(2)}</strong>` });
  }
  // Limit breaches
  (r.limites_activos || []).forEach(l => {
    if (l.disparado) alerts.push({ cls: 'red', text: `Límite: <strong>${esc(l.nombre)}</strong> superado` });
  });

  const el = document.getElementById('homeRiesgoAlerts');
  if (!alerts.length) {
    el.innerHTML = '<div style="color:var(--green);font-size:12px">Sin alertas activas</div>';
    return;
  }
  el.innerHTML = alerts.map(a =>
    `<div class="kpi-card ${a.cls}" style="margin-bottom:4px;padding:4px 10px;font-size:11px">${a.text}</div>`
  ).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: INFORMES
// ══════════════════════════════════════════════════════════════════════════════

async function cargarInformes() {
  try {
    const [summaryRes, snapshotRes, concRes] = (await Promise.allSettled([
      apiFetch('/api/reports/summary'),
      apiFetch('/api/reports/positions-snapshot'),
      apiFetch('/api/reports/concentracion'),
    ])).map(r => r.status === 'fulfilled' ? r.value : null);
    if (summaryRes?.ok) {
      const summary = await summaryRes.json();
      renderKPIs(summary);
      renderTopEspecies(summary.top_especies);
    }
    if (snapshotRes?.ok) {
      const snapshot = await snapshotRes.json();
      renderSnapshot(snapshot.snapshot);
    }
    if (concRes?.ok) {
      const conc = await concRes.json();
      renderConcentracion(conc);
    }
  } catch (e) {
    showToast('Error al cargar informes.', 'error');
  }
  cargarBenchmark();
}

async function cargarBenchmark() {
  const kpis = document.getElementById('benchmarkKpis');
  const meta = document.getElementById('benchmarkMeta');
  kpis.innerHTML = `<div class="kpi-card"><div class="kpi-value" style="font-size:14px">Consultando...</div><div class="kpi-label">cargando benchmark</div></div>`;
  try {
    const res = await apiFetch('/api/reports/benchmark');
    const b = await res.json();
    if (b.error) {
      kpis.innerHTML = `<div style="color:var(--text3);font-size:12px">${b.error}</div>`;
      return;
    }
    const fmtPct = (v, good = true) => {
      if (v == null) return '<span style="color:var(--text3)">—</span>';
      const cls = (v >= 0) === good ? 'neta-pos' : 'neta-neg';
      return `<span class="${cls}">${v >= 0 ? '+' : ''}${v}%</span>`;
    };
    kpis.innerHTML = `
      <div class="kpi-card ${b.portfolio_return == null ? '' : b.portfolio_return >= 0 ? 'green' : 'red'}">
        <div class="kpi-value" style="font-size:22px">${fmtPct(b.portfolio_return)}</div>
        <div class="kpi-label">Retorno Cartera</div>
      </div>
      <div class="kpi-card ${b.merval_return == null ? '' : b.merval_return >= 0 ? 'green' : 'red'}">
        <div class="kpi-value" style="font-size:22px">${fmtPct(b.merval_return)}</div>
        <div class="kpi-label">Retorno Merval (^MERV)</div>
      </div>
      <div class="kpi-card ${b.alpha == null ? '' : b.alpha >= 0 ? 'green' : 'red'}">
        <div class="kpi-value" style="font-size:22px">${fmtPct(b.alpha)}</div>
        <div class="kpi-label">Alpha vs. Merval</div>
      </div>
      <div class="kpi-card accent">
        <div class="kpi-value" style="font-size:18px">${fmt(b.valor_actual)}</div>
        <div class="kpi-label">Valor Cartera (ARP)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value" style="font-size:18px">${fmt(b.costo_base)}</div>
        <div class="kpi-label">Costo Base</div>
      </div>
      <div class="kpi-card ${b.portfolio_pnl >= 0 ? 'green' : 'red'}">
        <div class="kpi-value" style="font-size:18px">${fmt(b.portfolio_pnl)}</div>
        <div class="kpi-label">PnL No Realizado</div>
      </div>
    `;
    meta.textContent = b.inception_date
      ? `Desde ${b.inception_date} · Merval: ${fmt(b.merval_inicio)} → ${fmt(b.merval_actual)}`
      : '';
  } catch (e) {
    kpis.innerHTML = `<div style="color:var(--red);font-size:12px">Error al cargar benchmark.</div>`;
  }
}

function renderConcentracion(data) {
  const el = document.getElementById('concentracionContent');
  if (!data.items || data.items.length === 0) {
    el.innerHTML = `<div style="color:var(--text3);font-size:12px">Sin posiciones con valor de mercado.</div>`;
    return;
  }
  const total = data.total_valor_mercado;
  const bars = data.items.map(r => {
    const pct = r.pct;
    const color = pct > 30 ? 'var(--red)' : pct > 20 ? 'var(--orange)' : 'var(--green)';
    const alerta = pct > 30 ? '⚠ ' : '';
    return `
      <div class="conc-row">
        <div class="conc-label">${alerta}<span class="especie-tag">${esc(r.especie)}</span></div>
        <div class="conc-track">
          <div class="conc-bar" style="width:${Math.min(pct, 100)}%;background:${color}"></div>
        </div>
        <div class="conc-pct" style="color:${color}">${esc(pct)}%</div>
        <div class="conc-valor">${fmt(r.valor_mercado)}</div>
      </div>`;
  }).join('');
  el.innerHTML = `
    <div style="font-size:10px;color:var(--text3);margin-bottom:10px">
      Valor total cartera: <strong style="color:var(--text)">${fmt(total)}</strong> ARP
      &nbsp;·&nbsp; ⚠ = concentración &gt;30%
    </div>
    <div class="conc-grid">${bars}</div>`;
}

function renderKPIs(s) {
  const grid = document.getElementById('kpiGrid');
  const vol = s.volumen_por_moneda || {};
  grid.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-value">${fmtInt(s.fills_hoy)}</div>
      <div class="kpi-label">Fills hoy</div>
    </div>
    <div class="kpi-card green">
      <div class="kpi-value">${fmtInt(s.ordenes_ejecutadas)}</div>
      <div class="kpi-label">Ejecutadas</div>
    </div>
    <div class="kpi-card orange">
      <div class="kpi-value">${fmtInt(s.ordenes_pendientes)}</div>
      <div class="kpi-label">Pendientes</div>
    </div>
    <div class="kpi-card red">
      <div class="kpi-value">${fmtInt(s.ordenes_error)}</div>
      <div class="kpi-label">Con error</div>
    </div>
    <div class="kpi-card accent">
      <div class="kpi-value">${fmt(vol['ARP'] || 0)}</div>
      <div class="kpi-label">Vol. ARP</div>
    </div>
    <div class="kpi-card accent">
      <div class="kpi-value">${fmt(vol['USD'] || 0)}</div>
      <div class="kpi-label">Vol. USD</div>
    </div>
  `;
}

function renderTopEspecies(top) {
  const tbody = document.getElementById('topEspeciesBody');
  if (!top || !top.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-muted">Sin datos de ejecuciones.</td></tr>`;
    return;
  }
  tbody.innerHTML = top.map((t, i) => `
    <tr>
      <td style="color:var(--text3)">${i + 1}</td>
      <td><span class="especie-tag">${esc(t.especie)}</span></td>
      <td class="importe-cell">${fmt(t.volumen)}</td>
      <td style="color:var(--text3)">${esc(t.fills)}</td>
    </tr>
  `).join('');
}

function renderSnapshot(snapshot) {
  const tbody = document.getElementById('snapshotBody');
  if (!snapshot || !snapshot.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-muted">Sin posiciones consolidadas.</td></tr>`;
    return;
  }
  tbody.innerHTML = snapshot.map(s => {
    const netaClass = s.cantidad_neta_total > 0 ? 'neta-pos' : s.cantidad_neta_total < 0 ? 'neta-neg' : 'neta-zero';
    return `
      <tr>
        <td><span class="especie-tag">${esc(s.especie)}</span></td>
        <td>${esc(s.moneda)}</td>
        <td class="ejec-cell ${netaClass}">${fmtInt(s.cantidad_neta_total)}</td>
        <td style="color:var(--text3)">${esc(s.clientes_count)}</td>
        <td class="precio-cell">${s.costo_promedio_ponderado > 0 ? fmt(s.costo_promedio_ponderado) : '—'}</td>
      </tr>
    `;
  }).join('');
}

function exportar(tipo) {
  window.location.href = `/api/reports/export?tipo=${tipo}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: UTILITARIOS
// ══════════════════════════════════════════════════════════════════════════════

async function cargarUtilitarios() {
  try {
    const [statsRes, healthRes] = (await Promise.allSettled([
      apiFetch('/api/utils/stats'),
      apiFetch('/api/utils/health'),
    ])).map(r => r.status === 'fulfilled' ? r.value : null);
    if (statsRes?.ok) {
      renderStats(await statsRes.json());
    } else {
      document.getElementById('statsGrid').innerHTML =
        '<div style="color:var(--text3);font-size:12px;padding:8px 0">Sin datos de estadísticas.</div>';
    }
    if (healthRes?.ok) {
      const health = await healthRes.json();
      renderHealth(health.servicios);
    } else {
      document.getElementById('healthGrid').innerHTML =
        '<div class="health-card desconocido"><div class="health-name">Sin datos de servicios</div></div>';
    }
  } catch (e) {
    document.getElementById('healthGrid').innerHTML =
      '<div class="health-card desconocido"><div class="health-name">Error al cargar servicios</div></div>';
    document.getElementById('statsGrid').innerHTML =
      '<div style="color:var(--text3);font-size:12px;padding:8px 0">Error al cargar estadísticas.</div>';
  }
  cargarAuditLog();
}

async function cargarAuditLog() {
  const operacion = document.getElementById('auditFiltroOp').value;
  const params = new URLSearchParams({ limit: 100 });
  if (operacion) params.set('operacion', operacion);

  try {
    const res = await apiFetch(`/api/audit?${params}`);
    const data = await res.json();
    renderAuditLog(data.logs);
  } catch (e) {
    document.getElementById('auditBody').innerHTML =
      `<tr><td colspan="5">Error al cargar audit log.</td></tr>`;
  }
}

function renderAuditLog(logs) {
  const tbody = document.getElementById('auditBody');
  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-muted">Sin entradas en el audit log.</td></tr>`;
    return;
  }
  const opColors = { CREATE: 'green', EXECUTE: 'accent', UPDATE: 'orange', CANCEL: 'red' };
  tbody.innerHTML = logs.map(l => {
    const col = opColors[l.operacion] || 'text3';
    return `
      <tr>
        <td style="color:var(--text3); white-space:nowrap">${esc(l.timestamp)}</td>
        <td><span class="inst-badge inst-${col === 'accent' ? 'green' : col}" style="color:var(--${col})">${esc(l.operacion)}</span></td>
        <td style="color:var(--text3)">${esc(l.tabla)}</td>
        <td style="color:var(--text3)">${esc(l.record_id)}</td>
        <td style="font-size:11px">${esc(l.descripcion) || '—'}</td>
      </tr>
    `;
  }).join('');
}

function renderStats(stats) {
  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card-big">
      <div class="stat-num">${fmtInt(stats.ordenes_total)}</div>
      <div class="stat-desc">Órdenes</div>
    </div>
    <div class="stat-card-big">
      <div class="stat-num">${fmtInt(stats.ejecuciones_total)}</div>
      <div class="stat-desc">Ejecuciones</div>
    </div>
    <div class="stat-card-big">
      <div class="stat-num">${fmtInt(stats.posiciones_total)}</div>
      <div class="stat-desc">Posiciones</div>
    </div>
    <div class="stat-card-big">
      <div class="stat-num">${fmtInt(stats.notificaciones_total)}</div>
      <div class="stat-desc">Notificaciones</div>
    </div>
  `;
}

function renderHealth(servicios) {
  document.getElementById('healthGrid').innerHTML = servicios.map(s => `
    <div class="health-card ${esc(s.estado)}">
      <div class="health-name">
        <span class="health-dot ${esc(s.estado)}"></span>
        ${esc(s.nombre)}
      </div>
      <div class="health-estado">${esc(s.estado).toUpperCase()} · ${esc(s.timestamp) || 'sin datos'}</div>
      <div class="health-msg">${esc(s.mensaje) || '—'}</div>
    </div>
  `).join('');
}

function confirmarReset() {
  const modal = document.getElementById('modalConfirmReset');
  document.getElementById('resetConfirmInput').value = '';
  document.getElementById('btnEjecutarReset').disabled = true;
  modal.classList.add('active');
}

async function ejecutarReset(btn) {
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Ejecutando...'; }
  document.getElementById('modalConfirmReset').classList.remove('active');
  try {
    const res = await apiFetch('/api/utils/seed-reset', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.mensaje, 'ok', 'Reset completado');
      cargarUtilitarios();
    } else {
      showToast(data.detail || 'Error en el reset.', 'error');
    }
  } catch {
    showToast('Error de conexión.', 'error');
  } finally {
    if (btn) { btn.disabled = false; if (origText) btn.textContent = origText; }
  }
}

// ── MERCADO ──────────────────────────────────────────────────────────────────

let _tcMEP = null;  // tipo de cambio MEP vigente

function switchMercadoTab(tab) {
  document.querySelectorAll('[data-mercado-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mercadoTab === tab);
  });
  document.querySelectorAll('.mercado-moneda-tab').forEach(el => {
    el.style.display = el.id === `mercado-tab-${tab}` ? '' : 'none';
  });
}

async function cargarMercado() {
  try {
    const res  = await apiFetch('/api/mercado/grupos');
    const data = await res.json();
    const tc   = data.tipo_cambio || {};
    _tcMEP = tc.mep || tc.ccl || null;
    renderTipoCambio(tc);
    renderGrupo('tbl-byma-body',   data.byma,           false);
    renderGrupo('tbl-merval-body', data.merval_general,  true);

    // USD tab: show table if there are USD tickers, else show placeholder
    const usdItems = data.usd || [];
    const usdPlaceholder = document.getElementById('mercado-usd-placeholder');
    const usdTable       = document.getElementById('mercado-usd-table');
    if (usdItems.length) {
      usdPlaceholder.style.display = 'none';
      usdTable.style.display       = '';
      renderGrupo('tbl-usd-body', usdItems, false);
    } else {
      usdPlaceholder.style.display = '';
      usdTable.style.display       = 'none';
    }

    // Auto-refresh on first load if DB has no prices yet
    const allItems = [...(data.byma || []), ...(data.merval_general || [])];
    const hasAnyPrice = allItems.some(r => r.precio != null);
    if (!hasAnyPrice) refrescarMercado();
  } catch {
    document.getElementById('tbl-byma-body').innerHTML   = '<tr><td colspan="4" class="text-muted">Error al cargar datos.</td></tr>';
    document.getElementById('tbl-merval-body').innerHTML = _emptyTableRow(5, 'Error al cargar datos.');
  }
}

function renderTipoCambio(tc) {
  const el = document.getElementById('mercadoTc');
  if (!el) return;
  const f = v => v ? Number(v).toLocaleString('es-AR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—';
  el.innerHTML = `MEP <strong>${f(tc.mep)}</strong> &nbsp;·&nbsp; CCL <strong>${f(tc.ccl)}</strong> &nbsp;·&nbsp; Oficial <strong>${f(tc.oficial)}</strong>`;
}

function renderGrupo(tbodyId, items, showUSD) {
  const fmtN = v => v == null ? '—' : Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtV = v => {
    if (v == null) return '<td style="text-align:right;color:var(--text3)">—</td>';
    const cls = v >= 0 ? 'neta-pos' : 'neta-neg';
    return `<td class="${cls}" style="text-align:right">${v >= 0 ? '+' : ''}${v}%</td>`;
  };
  const isD = esp => esp.endsWith('D') || esp.endsWith('.D') || esp.endsWith('.C') || esp.endsWith('C');
  const rows = items.map(r => {
    const usdCell = showUSD
      ? `<td style="text-align:right;font-size:11px;color:var(--text3);font-family:'IBM Plex Mono',monospace">${(r.precio && _tcMEP && isD(r.especie)) ? 'U$S ' + fmtN(r.precio / _tcMEP) : '—'}</td>`
      : '';
    return `
    <tr style="cursor:pointer" data-especie="${esc(r.especie)}" class="mercado-row">
      <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:12px">${esc(r.especie)}</span></td>
      <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:12px">${fmtN(r.precio)}</td>
      ${fmtV(r.variacion_pct)}
      ${usdCell}
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-mini mercado-chart-btn" data-especie="${esc(r.especie)}" style="margin-right:3px">Gráfico</button>
        <button class="btn-mini mercado-orden-btn" data-especie="${esc(r.especie)}">+ Orden</button>
      </td>
    </tr>`;
  }).join('');
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = rows || '<tr><td colspan="5" class="text-muted">Sin datos</td></tr>';
  // Attach click handlers via event delegation (avoids onclick injection)
  tbody.querySelectorAll('tr.mercado-row').forEach(row => {
    row.addEventListener('click', () => abrirModalOrdenEspecie(row.dataset.especie));
  });
  tbody.querySelectorAll('.mercado-chart-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); abrirModalGrafico(btn.dataset.especie); });
  });
  tbody.querySelectorAll('.mercado-orden-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); abrirModalOrdenEspecie(btn.dataset.especie); });
  });
}

async function refrescarMercado() {
  const btn = document.getElementById('btnRefreshMercado');
  const svgHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
  btn.disabled = true;
  btn.classList.add('spinning');
  btn.innerHTML = `${svgHTML} Actualizando...`;
  try {
    const res  = await apiFetch('/api/mercado/refresh', { method: 'POST' });
    const data = await res.json();
    await cargarMercado();
    btn.classList.remove('spinning');
    btn.innerHTML = `${svgHTML} ✓ ${data.total} actualizados`;
    setTimeout(() => { btn.disabled = false; btn.innerHTML = `${svgHTML} Actualizar precios`; }, 3000);
  } catch {
    btn.classList.remove('spinning');
    btn.innerHTML = `${svgHTML} Error`;
    setTimeout(() => { btn.disabled = false; btn.innerHTML = `${svgHTML} Actualizar precios`; }, 2000);
  }
}

function abrirModalOrdenEspecie(especie) {
  document.getElementById('f-especie').value = especie;
  abrirModalOrden();
  // Trigger order book load for this especie
  clearTimeout(_obTimer);
  cargarOrderbook(especie);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRÁFICO DE PRECIOS — TradingView Lightweight Charts
// ══════════════════════════════════════════════════════════════════════════════

let _chartData       = [];
let _chartEspecie    = null;
let _chartIntervalo  = '1d';        // candle resolution
let _chartFuente     = 'mercado';   // 'mercado' | 'sistema'
let _chartIndicators = new Set(['sma20', 'sma50']);
let _lwChart         = null;
let _lwChartRsi      = null;
let _lwChartMacd     = null;
let _lwSeries        = {};

// Implied date range (days back) for each candle interval
const _TF_CONFIG = {
  '15m': { dias: 5   },
  '30m': { dias: 7   },
  '45m': { dias: 7   },
  '1h':  { dias: 30  },
  '2h':  { dias: 60  },
  '3h':  { dias: 90  },
  '4h':  { dias: 90  },
  '1d':  { dias: 90  },
  '1w':  { dias: 730 },
  '1mo': { dias: 1825 },
  '3mo': { dias: null },   // all available
};

function _intervaloFechaDesde(intervalo) {
  const cfg = _TF_CONFIG[intervalo];
  if (!cfg || !cfg.dias) return null;
  const d = new Date();
  d.setDate(d.getDate() - cfg.dias);
  return d.toISOString().slice(0, 10);
}

async function abrirModalGrafico(especie) {
  _chartEspecie   = especie;
  _chartIntervalo = '1d';
  _chartFuente    = 'mercado';
  document.getElementById('graficoEspecie').textContent = especie;
  document.getElementById('graficoPrecio').textContent  = 'Cargando...';
  document.getElementById('modalGrafico').classList.add('active');
  const sel = document.getElementById('chartIntervalo');
  if (sel) sel.value = _chartIntervalo;
  document.querySelectorAll('.chart-tf-btn[data-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === _chartFuente)
  );
  await _cargarYRenderizarGrafico();
}

async function cambiarModoGrafico(modo) {
  _chartFuente = modo;
  document.querySelectorAll('.chart-tf-btn[data-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === modo)
  );
  _destruirGraficos();
  await _cargarYRenderizarGrafico();
}

function cerrarModalGrafico(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modalGrafico').classList.remove('active');
  _destruirGraficos();
}

function _destruirGraficos() {
  if (_lwChart)     { _lwChart.remove();     _lwChart     = null; }
  if (_lwChartRsi)  { _lwChartRsi.remove();  _lwChartRsi  = null; }
  if (_lwChartMacd) { _lwChartMacd.remove(); _lwChartMacd = null; }
  _lwSeries  = {};
  _chartData = [];
}

async function cambiarIntervalo(intervalo) {
  _chartIntervalo = intervalo;
  _destruirGraficos();
  await _cargarYRenderizarGrafico();
}

function toggleIndicador(ind) {
  if (_chartIndicators.has(ind)) _chartIndicators.delete(ind);
  else _chartIndicators.add(ind);
  document.querySelectorAll('.chart-ind-btn').forEach(b => {
    if (b.dataset.ind === ind) b.classList.toggle('active', _chartIndicators.has(ind));
  });
  if (_chartData.length) _renderizarGrafico(_chartData);
}

async function _cargarYRenderizarGrafico() {
  const desde = _intervaloFechaDesde(_chartIntervalo);
  let url = `/api/prices/chart/${encodeURIComponent(_chartEspecie)}?fuente=${_chartFuente}&intervalo=${_chartIntervalo}`;
  if (desde) url += `&fecha_desde=${desde}`;

  document.getElementById('graficoPrecio').textContent = 'Cargando...';
  try {
    const res  = await apiFetch(url);
    const json = await res.json();

    if (json.sin_ticker) {
      document.getElementById('graficoPrecio').textContent =
        'Sin ticker de mercado para esta especie (modo Mercado). Usá modo Sistema.';
      return;
    }

    _chartData = json.data || [];
    if (_chartData.length === 0) {
      const msg = _chartFuente === 'sistema'
        ? 'Sin ejecuciones registradas para este período'
        : 'Sin datos históricos — probá otro intervalo o modo Sistema';
      document.getElementById('graficoPrecio').textContent = msg;
      return;
    }
    const last      = _chartData[_chartData.length - 1];
    const lastPrice = last.close ?? last.value;
    const barLabel  = _chartData.length === 1 ? 'barra' : 'barras';
    const label     = _chartFuente === 'sistema' ? 'Últ. ejec.' : 'Último';
    document.getElementById('graficoPrecio').textContent =
      `${label}: ${Number(lastPrice).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${_chartData.length} ${barLabel}`;
    _renderizarGrafico(_chartData);
  } catch {
    document.getElementById('graficoPrecio').textContent = 'Error al cargar datos';
  }
}

function _chartThemeOptions() {
  const html   = document.documentElement;
  const isDark = html.classList.contains('theme-legacy');
  const isSap  = html.classList.contains('theme-sap');
  if (isDark) return { bg: '#16162A', text: '#C8C5BC', grid: '#252538', border: '#3A3A5E' };
  if (isSap)  return { bg: '#F5F5F5', text: '#003366', grid: '#E0E8F0', border: '#B0C4D8' };
  return       { bg: '#ECE9D8',  text: '#222222', grid: '#D0CCC0', border: '#ACA899' };
}

function _makeChart(containerId, height) {
  const { bg, text, grid, border } = _chartThemeOptions();
  const el = document.getElementById(containerId);
  return LightweightCharts.createChart(el, {
    width:  el.clientWidth,
    height,
    layout:          { background: { color: bg }, textColor: text },
    grid:            { vertLines: { color: grid }, horzLines: { color: grid } },
    rightPriceScale: { borderColor: border },
    timeScale:       { borderColor: border, timeVisible: true, secondsVisible: false },
    crosshair:       { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll:    true,
    handleScale:     true,
  });
}

function _renderizarGrafico(data) {
  _destruirGraficos();

  const hasRsi  = _chartIndicators.has('rsi');
  const hasMacd = _chartIndicators.has('macd');

  // Show/hide lower panes
  const rsiEl    = document.getElementById('chartRsiContainer');
  const rsiLbl   = document.getElementById('chartRsiLabel');
  const macdEl   = document.getElementById('chartMacdContainer');
  const macdLbl  = document.getElementById('chartMacdLabel');
  rsiEl.style.display   = hasRsi  ? '' : 'none';
  rsiLbl.style.display  = hasRsi  ? '' : 'none';
  macdEl.style.display  = hasMacd ? '' : 'none';
  macdLbl.style.display = hasMacd ? '' : 'none';

  // ── Main chart ────────────────────────────────────────────────────────────
  _lwChart = _makeChart('chartMainContainer', 360);

  // Use candlestick whenever data has OHLCV fields (sistema always, mercado intraday/weekly too)
  const isOHLCV = data.length > 0 && data[0].open !== undefined;

  // For sistema OHLCV: remap timestamps to sequential integers so LWC renders
  // bars without empty time gaps between sparse executions.
  // Applies to all intervals: intraday (Unix int) and daily/weekly/monthly (ISO string).
  let renderData = data;
  if (_chartFuente === 'sistema' && isOHLCV) {
    const tsLabels = data.map(d => {
      if (typeof d.time === 'number') {
        // Intraday: Unix timestamp → HH:MM
        return new Date(d.time * 1000).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
      }
      // Daily/weekly: ISO date "YYYY-MM-DD" → DD/MM
      const parts = String(d.time).split('-');
      if (parts.length === 3) {
        if (_chartIntervalo === '1mo' || _chartIntervalo === '3mo') {
          // Monthly: show MM/YY
          return `${parts[1]}/${parts[0].slice(2)}`;
        }
        return `${parts[2]}/${parts[1]}`;
      }
      return String(d.time);
    });
    renderData = data.map((d, i) => ({ ...d, time: i + 1 }));
    _lwChart.timeScale().applyOptions({
      tickMarkFormatter: t => tsLabels[t - 1] ?? '',
    });
  }

  let priceSeries;
  if (isOHLCV) {
    // Candlestick series
    priceSeries = _lwChart.addCandlestickSeries({
      upColor:        '#267326',
      downColor:      '#CC0000',
      borderUpColor:  '#267326',
      borderDownColor:'#CC0000',
      wickUpColor:    '#267326',
      wickDownColor:  '#CC0000',
    });
    priceSeries.setData(renderData.map(d => ({
      time:  d.time,
      open:  d.open,
      high:  d.high,
      low:   d.low,
      close: d.close,
    })));

    // Volume histogram on a separate price scale within the main chart
    const volSeries = _lwChart.addHistogramSeries({
      priceFormat:  { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
    });
    _lwChart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.80, bottom: 0 },
    });
    volSeries.setData(renderData.map(d => ({
      time:  d.time,
      value: d.volume,
      color: d.close >= d.open ? 'rgba(38,115,38,0.50)' : 'rgba(204,0,0,0.50)',
    })));
    _lwSeries.vol = volSeries;
  } else {
    // Area/line series for daily mercado closes
    priceSeries = _lwChart.addAreaSeries({
      lineColor:        '#0054E3',
      topColor:         'rgba(0, 84, 227, 0.28)',
      bottomColor:      'rgba(0, 84, 227, 0.02)',
      lineWidth:        2,
      priceLineVisible: true,
      crosshairMarkerVisible: true,
    });
    priceSeries.setData(renderData);
  }
  _lwSeries.price = priceSeries;

  // ── Bull/Bear market phases ────────────────────────────────────────────────
  const _bbBadge = document.getElementById('chartBullBearPhase');
  if (_bbBadge) _bbBadge.style.display = 'none';
  if (_chartIndicators.has('bullbear') && !_INTRADAY_IVS.has(_chartIntervalo) && _chartFuente === 'mercado') {
    const { markers: bbMarkers, currentPhase } = _detectBullBear(renderData);
    if (bbMarkers.length) priceSeries.setMarkers(bbMarkers);
    if (_bbBadge && currentPhase) {
      _bbBadge.textContent = currentPhase === 'bull' ? '▲ Bull Market' : '▼ Bear Market';
      _bbBadge.style.color = currentPhase === 'bull' ? '#267326' : '#CC0000';
      _bbBadge.style.display = 'block';
    }
  }

  // Normalise data to {time, value} for all indicator calculations
  const lineData = renderData.map(d => ({ time: d.time, value: d.close ?? d.value }));

  // SMA 20
  if (_chartIndicators.has('sma20')) {
    const sma = _calcSMA(lineData, 20);
    if (sma.length) {
      const s = _lwChart.addLineSeries({ color: '#FF8C00', lineWidth: 1, title: 'SMA 20', lastValueVisible: true });
      s.setData(sma);
      _lwSeries.sma20 = s;
    }
  }
  // SMA 50
  if (_chartIndicators.has('sma50')) {
    const sma = _calcSMA(lineData, 50);
    if (sma.length) {
      const s = _lwChart.addLineSeries({ color: '#267326', lineWidth: 1, title: 'SMA 50', lastValueVisible: true });
      s.setData(sma);
      _lwSeries.sma50 = s;
    }
  }
  // EMA 20
  if (_chartIndicators.has('ema20')) {
    const ema = _calcEMA(lineData, 20);
    if (ema.length) {
      const s = _lwChart.addLineSeries({
        color: '#CC0000', lineWidth: 1, title: 'EMA 20',
        lineStyle: LightweightCharts.LineStyle.Dashed,
        lastValueVisible: true,
      });
      s.setData(ema);
      _lwSeries.ema20 = s;
    }
  }
  // Bollinger Bands
  if (_chartIndicators.has('bb')) {
    const bb = _calcBollinger(lineData, 20, 2);
    if (bb.length) {
      const dotted = LightweightCharts.LineStyle.Dotted;
      const ub = _lwChart.addLineSeries({ color: 'rgba(140, 0, 200, 0.65)', lineWidth: 1, title: 'BB+2σ', lineStyle: dotted, lastValueVisible: false });
      const mb = _lwChart.addLineSeries({ color: 'rgba(140, 0, 200, 0.90)', lineWidth: 1, title: 'BB mid', lastValueVisible: false });
      const lb = _lwChart.addLineSeries({ color: 'rgba(140, 0, 200, 0.65)', lineWidth: 1, title: 'BB-2σ', lineStyle: dotted, lastValueVisible: false });
      ub.setData(bb.map(d => ({ time: d.time, value: d.upper })));
      mb.setData(bb.map(d => ({ time: d.time, value: d.mid   })));
      lb.setData(bb.map(d => ({ time: d.time, value: d.lower })));
      _lwSeries.bb = { ub, mb, lb };
    }
  }

  // ── RSI pane ──────────────────────────────────────────────────────────────
  if (hasRsi) {
    _lwChartRsi = _makeChart('chartRsiContainer', 120);
    const rsiData = _calcRSI(lineData, 14);
    if (rsiData.length) {
      const s = _lwChartRsi.addLineSeries({ color: '#0054E3', lineWidth: 1, title: 'RSI 14' });
      s.setData(rsiData);
      const ob = _lwChartRsi.addLineSeries({ color: 'rgba(204,0,0,0.45)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false });
      const os = _lwChartRsi.addLineSeries({ color: 'rgba(38,115,38,0.45)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false });
      ob.setData(rsiData.map(d => ({ time: d.time, value: 70 })));
      os.setData(rsiData.map(d => ({ time: d.time, value: 30 })));
      _lwSeries.rsi = s;
    }
  }

  // ── MACD pane ─────────────────────────────────────────────────────────────
  if (hasMacd) {
    _lwChartMacd = _makeChart('chartMacdContainer', 120);
    const { macdLine, signalLine, histogram } = _calcMACD(lineData);
    if (macdLine.length) {
      const ms = _lwChartMacd.addLineSeries({ color: '#0054E3', lineWidth: 1, title: 'MACD' });
      const ss = _lwChartMacd.addLineSeries({ color: '#FF8C00', lineWidth: 1, title: 'Signal' });
      const hs = _lwChartMacd.addHistogramSeries({ priceFormat: { type: 'price', minMove: 0.001 }, lastValueVisible: false });
      ms.setData(macdLine);
      ss.setData(signalLine);
      hs.setData(histogram.map(d => ({
        time:  d.time,
        value: d.value,
        color: d.value >= 0 ? 'rgba(38,115,38,0.70)' : 'rgba(204,0,0,0.70)',
      })));
      _lwSeries.macd = { ms, ss, hs };
    }
  }

  // ── Sync time scales across panes ─────────────────────────────────────────
  if (_lwChartRsi || _lwChartMacd) {
    _lwChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (!range) return;
      if (_lwChartRsi)  _lwChartRsi.timeScale().setVisibleLogicalRange(range);
      if (_lwChartMacd) _lwChartMacd.timeScale().setVisibleLogicalRange(range);
    });
  }

  // Fit content on render
  _lwChart.timeScale().fitContent();
}

// Handle window resize while chart modal is open
window.addEventListener('resize', () => {
  if (!document.getElementById('modalGrafico')?.classList.contains('active')) return;
  const resize = (chart, id) => {
    const el = document.getElementById(id);
    if (chart && el) chart.applyOptions({ width: el.clientWidth });
  };
  resize(_lwChart,     'chartMainContainer');
  resize(_lwChartRsi,  'chartRsiContainer');
  resize(_lwChartMacd, 'chartMacdContainer');
});

// ── Bull/Bear market phase detection (classic 20% drawdown/rally rule) ────────

const _INTRADAY_IVS = new Set(['15m','30m','45m','1h','2h','3h','4h']);

/**
 * Detects bull/bear market transitions using the 20% rule.
 * Returns LWC markers array + the current phase ('bull'|'bear'|null).
 * Not meaningful for intraday data — caller should skip those intervals.
 */
function _detectBullBear(data) {
  if (data.length < 10) return { markers: [], currentPhase: null };
  const THRESHOLD = 0.20;
  const markers = [];
  let phase = null;  // null = no phase detected yet
  let refPrice = data[0].close ?? data[0].value;

  for (let i = 1; i < data.length; i++) {
    const p = data[i].close ?? data[i].value;
    if (phase === null || phase === 'bull') {
      if (p > refPrice) {
        refPrice = p;  // rising peak
      } else if ((refPrice - p) / refPrice >= THRESHOLD) {
        phase = 'bear';
        markers.push({ time: data[i].time, position: 'aboveBar', color: '#CC0000', shape: 'arrowDown', text: 'Bear' });
        refPrice = p;  // track trough from here
      }
    } else {  // phase === 'bear'
      if (p < refPrice) {
        refPrice = p;  // falling trough
      } else if ((p - refPrice) / refPrice >= THRESHOLD) {
        phase = 'bull';
        markers.push({ time: data[i].time, position: 'belowBar', color: '#267326', shape: 'arrowUp', text: 'Bull' });
        refPrice = p;  // track peak from here
      }
    }
  }

  return { markers, currentPhase: phase };
}

// ── Technical indicator calculations ──────────────────────────────────────────

function _calcSMA(data, period) {
  if (data.length < period) return [];
  const result = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i].value;
  result.push({ time: data[period - 1].time, value: sum / period });
  for (let i = period; i < data.length; i++) {
    sum += data[i].value - data[i - period].value;
    result.push({ time: data[i].time, value: sum / period });
  }
  return result;
}

function _calcEMA(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += data[i].value;
  ema /= period;
  const result = [{ time: data[period - 1].time, value: ema }];
  for (let i = period; i < data.length; i++) {
    ema = data[i].value * k + ema * (1 - k);
    result.push({ time: data[i].time, value: ema });
  }
  return result;
}

function _calcBollinger(data, period = 20, mult = 2) {
  if (data.length < period) return [];
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j].value;
    const mean = sum / period;
    let variance = 0;
    for (let j = 0; j < period; j++) variance += (data[i - j].value - mean) ** 2;
    const std = Math.sqrt(variance / period);
    result.push({ time: data[i].time, upper: mean + mult * std, mid: mean, lower: mean - mult * std });
  }
  return result;
}

function _calcRSI(data, period = 14) {
  if (data.length < period + 1) return [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = data[i].value - data[i - 1].value;
    if (delta > 0) avgGain += delta; else avgLoss += -delta;
  }
  avgGain /= period; avgLoss /= period;
  const result = [];
  for (let i = period; i < data.length; i++) {
    if (i > period) {
      const delta = data[i].value - data[i - 1].value;
      avgGain = (avgGain * (period - 1) + Math.max(delta,  0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
    }
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    result.push({ time: data[i].time, value: 100 - 100 / (1 + rs) });
  }
  return result;
}

function _calcMACD(data, fast = 12, slow = 26, signal = 9) {
  const ema12 = _calcEMA(data, fast);
  const ema26 = _calcEMA(data, slow);
  if (!ema12.length || !ema26.length) return { macdLine: [], signalLine: [], histogram: [] };
  const offset   = ema12.length - ema26.length;
  const macdLine = ema26.map((d, i) => ({ time: d.time, value: ema12[offset + i].value - d.value }));
  const signalLine = _calcEMA(macdLine, signal);
  const sigOffset  = macdLine.length - signalLine.length;
  const histogram  = signalLine.map((d, i) => ({
    time:  d.time,
    value: macdLine[sigOffset + i].value - d.value,
  }));
  return { macdLine, signalLine, histogram };
}

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
async function init() {
  // Verify session — redirects to /login on 401 via apiFetch interceptor
  const meRes = await apiFetch('/api/auth/me');
  if (!meRes.ok) return; // apiFetch already redirected on 401
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

// ── HEATMAP DE POSICIONES ───────────────────────────────────────────────────
let _heatmapVisible = false;

function toggleHeatmap() {
  _heatmapVisible = !_heatmapVisible;
  const hm    = document.getElementById('posicionesHeatmapPanel');
  const table = document.getElementById('posicionesTablePanel');
  const btn   = document.getElementById('btnToggleHeatmap');
  if (hm)    hm.style.display    = _heatmapVisible ? '' : 'none';
  if (table) table.style.display = _heatmapVisible ? 'none' : '';
  if (btn)   btn.textContent     = _heatmapVisible ? 'Ver Tabla' : 'Ver Mapa';
}

function renderHeatmap(posiciones) {
  const grid = document.getElementById('heatmapGrid');
  if (!grid) return;
  const activas = (posiciones || []).filter(p => p.cantidad_neta !== 0);
  if (!activas.length) {
    grid.innerHTML = '<p style="color:var(--text3);padding:16px;font-size:12px;text-align:center">Sin posiciones activas</p>';
    return;
  }
  grid.innerHTML = activas.map(p => {
    const pnl = p.pnl_no_realizado;
    const hmCls  = pnl > 0 ? 'hm-pos' : pnl < 0 ? 'hm-neg' : '';
    const pnlCls = pnl > 0 ? 'hm-pos-val' : pnl < 0 ? 'hm-neg-val' : '';
    const pnlStr = pnl != null ? `${pnl >= 0 ? '+' : ''}${fmt(pnl)}` : '—';
    return `
      <div class="heatmap-card ${hmCls}" title="${esc(p.especie)} — ${esc(p.cliente)}">
        <div class="hm-especie">${esc(p.especie)}</div>
        <div class="hm-cliente">${esc(p.cliente)}</div>
        <div class="hm-neta">Neto: ${p.cantidad_neta > 0 ? '+' : ''}${p.cantidad_neta}</div>
        <div class="hm-pnl ${pnlCls}">${pnlStr}</div>
      </div>`;
  }).join('');
}

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
  const tbody = document.getElementById('firmaPosBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 7);
  try {
    const res = await apiFetch('/api/firma/posiciones');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.posiciones?.length) {
      tbody.innerHTML = _emptyTableRow(7, 'Sin posiciones.');
      return;
    }
    const fmt = v => v == null ? '—' : parseFloat(v).toLocaleString('es-AR', { minimumFractionDigits: 4 });
    tbody.innerHTML = data.posiciones.map(p => `<tr>
      <td><strong>${p.especie}</strong></td>
      <td>${p.mercado || '—'}</td>
      <td style="text-align:right">${(p.cantidad_comprada||0).toLocaleString('es-AR')}</td>
      <td style="text-align:right">${(p.cantidad_vendida||0).toLocaleString('es-AR')}</td>
      <td style="text-align:right;font-weight:700;color:${(p.cantidad_neta||0)>=0?'var(--buy,#4caf50)':'var(--sell,#e05c5c)'}">${(p.cantidad_neta||0).toLocaleString('es-AR')}</td>
      <td style="text-align:right">${fmt(p.costo_promedio_compra)}</td>
      <td style="text-align:right">${(p.cantidad_pendiente_liquidacion||0).toLocaleString('es-AR')}</td>
    </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted">Error al cargar: ${esc(e.message)}</td></tr>`;
  }
}

// ── Cuentas Operadores ────────────────────────────────────────────────────────

let _opMovActual = null;  // operador id cuya detail está visible

async function cargarCuentasOperadores() {
  const tbody = document.getElementById('cuentasOpBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 6);
  try {
    const res = await apiFetch('/api/cuentas/operadores');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.operadores?.length) {
      tbody.innerHTML = _emptyTableRow(6, 'No hay operadores registrados.');
      return;
    }
    const fmt = v => v == null ? '—' : parseFloat(v).toLocaleString('es-AR', { minimumFractionDigits: 2 });
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
  } catch(e) {
    document.getElementById('cuentasOpBody').innerHTML = `<tr><td colspan="6" class="text-muted">Error: ${esc(e.message)}</td></tr>`;
  }
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
        <td>${a.especie ? `<span class="especie-tag">${esc(a.especie)}</span>` : '<span style="color:var(--text3)">Todas</span>'}</td>
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
      const desde = (_auditPage - 1) * parseInt(perPage) + 1;
      const hasta = Math.min(_auditPage * parseInt(perPage), data.total);
      totalEl.textContent = data.total
        ? `Mostrando ${desde}–${hasta} de ${data.total} registros`
        : 'Sin registros';
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

  if (!monto || monto <= 0) { resultEl.textContent = '⚠ Ingresá un monto válido.'; return; }
  if (desc.length < 5)      { resultEl.textContent = '⚠ La descripción debe tener al menos 5 caracteres.'; return; }

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
  const tbody = document.getElementById('usuariosBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 8);
  try {
    const res  = await apiFetch('/api/users');
    const data = await res.json();
    if (!data.length) {
      tbody.innerHTML = _emptyTableRow(8, 'Sin usuarios');
      return;
    }
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
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
}

function abrirModalUsuario(usuario = null) {
  _pushModalFocus();
  if (typeof usuario === 'number' || (typeof usuario === 'string' && usuario !== '')) {
    usuario = _usuarioDataMap[+usuario] || null;
  }
  const modal = document.getElementById('modalUsuario');
  document.getElementById('usuarioResult').textContent = '';
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
  resEl.textContent = '';
  const id       = document.getElementById('u-id').value;
  const username = document.getElementById('u-username').value.trim();
  const email    = document.getElementById('u-email').value.trim();
  const role     = document.getElementById('u-rol').value;
  const password = document.getElementById('u-password').value;

  await _withButtonLoading(btn, async () => {
    try {
      let res;
      if (id) {
        const body = { role, email: email || null };
        if (password) body.password = password;
        res = await _apiFetchJson(`/api/users/${id}`, 'PATCH', body);
      } else {
        if (!username || !password) { resEl.textContent = 'Username y contraseña son requeridos.'; return; }
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
  try {
    await _apiFetchJson(`/api/users/${userId}`, 'PATCH', { is_active: activo });
    await cargarUsuarios();
  } catch(e) {
    await cargarUsuarios(); // refresh to restore correct state
  }
}

// ── CLIENTES ──────────────────────────────────────────────────────────────────
async function cargarClientesAdmin() {
  const tbody = document.getElementById('clientesAdminBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 7);
  try {
    const res  = await apiFetch('/api/clientes');
    const data = await res.json();
    if (!data.length) {
      tbody.innerHTML = _emptyTableRow(7, 'Sin clientes');
      return;
    }
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
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
}

function abrirModalCliente(cliente = null) {
  _pushModalFocus();
  if (typeof cliente === 'string' && cliente !== '') {
    cliente = _clienteDataMap[cliente] || null;
  }
  const modal = document.getElementById('modalCliente');
  document.getElementById('clienteResult').textContent = '';
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
  resEl.textContent = '';
  const codigoOrig = document.getElementById('c-codigo-orig').value;
  const codigo     = document.getElementById('c-codigo').value.trim().toUpperCase();
  const nombre     = document.getElementById('c-nombre').value.trim();
  const razon      = document.getElementById('c-razon').value.trim();
  if (!codigo || !nombre || !razon) { resEl.textContent = 'Todos los campos son requeridos.'; return; }

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
  try {
    await _apiFetchJson(`/api/clientes/${codigo}`, 'PATCH', { activo });
    await cargarClientesAdmin();
  } catch {
    await cargarClientesAdmin();
  }
}

// ── TICKERS ───────────────────────────────────────────────────────────────────
async function cargarTickersAdmin() {
  const tbody = document.getElementById('tickersAdminBody');
  if (!tbody) return;
  const panel = document.getElementById('tickerPanelFiltro')?.value || '';
  _setTbodyLoading(tbody, 6);
  try {
    const res  = await apiFetch('/api/admin/tickers');
    let data   = await res.json();
    if (panel) data = data.filter(t => t.panel === panel);
    if (!data.length) {
      tbody.innerHTML = _emptyTableRow(6, 'Sin tickers');
      return;
    }
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
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
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
  try {
    await _apiFetchJson(`/api/admin/tickers/${especie}`, 'PATCH', { activo });
    await cargarTickersAdmin();
  } catch {
    await cargarTickersAdmin();
  }
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
  const tbody = document.getElementById('botsBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 9);
  try {
    const res  = await apiFetch('/api/admin/bots');
    const data = await res.json();
    // Sync global toggle: checked when ALL bots respect schedule
    const sw = document.getElementById('switch-horario-global');
    if (sw) sw.checked = data.length > 0 && data.every(b => b.respetar_horario !== false);
    if (!data.length) {
      tbody.innerHTML = _emptyTableRow(9, 'Sin instancias. Creá una con "+ Nueva instancia".');
      return;
    }
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
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
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

  if (!nombre)       { resEl.textContent = 'El nombre es requerido.'; return; }
  if (!tipos.length) { resEl.textContent = 'Seleccioná al menos un tipo de orden.'; return; }

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

const _fmtARS = v =>
  v == null ? '—' : Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const _fmtARSCompact = v => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'M';
  if (Math.abs(n) >= 1_000)     return (n / 1_000).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'K';
  return _fmtARS(v);
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
  ['resumen', 'movimientos', 'operaciones'].forEach(t => {
    document.getElementById(`cb-tab-${t}`).style.display      = t === tab ? '' : 'none';
    document.getElementById(`cbTab-${t}`)?.classList.toggle('active', t === tab);
  });
  if (tab === 'movimientos' && !_cbMovCargados) cargarMovimientosBot(1);
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
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px;color:${montoClr}">${montoSign}$${_fmtARS(e.monto)}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">$${_fmtARS(e.balance_post)}</td>
        <td style="font-size:10px;color:var(--text3);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.descripcion||'')}">${esc(e.descripcion || '—')}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
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
    resEl.textContent = `Ajuste registrado. Saldo post: $${_fmtARS(data.balance_post)}`;
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
      `Reconciliado. Balance nuevo: $${_fmtARS(data.balance_nuevo)} ` +
      `(antes: $${_fmtARS(data.balance_antes)}, drift: ${drift >= 0 ? '+' : ''}$${_fmtARS(drift)})`;
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
  const tbody = document.getElementById('instrumentosBody');
  if (!tbody) return;
  const tipo        = document.getElementById('instTipoFiltro')?.value || '';
  const soloActivos = document.getElementById('instSoloActivos')?.checked !== false;
  _setTbodyLoading(tbody, 7);
  try {
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
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
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
  ['base','rf','futuro','margen'].forEach(t => {
    const btn = document.getElementById(`instSubTab-${t}`);
    const div = document.getElementById(`instTab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    if (div) div.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'margen' && _instCurrentId) cargarLlamados(_instCurrentId);
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
  try {
    await _apiFetchJson(`/api/instrumentos/${id}`, 'PATCH', { activo });
    await cargarInstrumentos();
  } catch { await cargarInstrumentos(); }
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
  const tbody = document.getElementById('llamadosBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 5);
  try {
    const res   = await apiFetch(`/api/instrumentos/${instId}/llamados-margen`);
    const data  = await res.json();
    const items = data.llamados_margen || [];
    if (!items.length) { tbody.innerHTML = _emptyTableRow(5, 'Sin llamados.'); return; }
    const estadoColor = { PENDIENTE:'#f0a500', INTEGRADO:'var(--green)', VENCIDO:'var(--red)' };
    tbody.innerHTML = items.map(ll => `
      <tr>
        <td style="font-size:11px">${esc(ll.fecha)}</td>
        <td style="font-size:11px">${esc(ll.cuenta_id)}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">$${_fmtARS(ll.monto)}</td>
        <td><span style="font-size:10px;font-weight:600;color:${estadoColor[ll.estado]||'var(--text2)'}">${esc(ll.estado)}</span></td>
        <td>${ll.estado==='PENDIENTE'?`<button class="btn-mini" onclick="integrarLlamado(${ll.id})">Integrar</button>`:''}</td>
      </tr>
    `).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
}

function abrirModalLlamado() {
  if (!_instCurrentId) { showToast('Guardá primero el instrumento.', 'warn'); return; }
  document.getElementById('llamadoInstEspecie').textContent = document.getElementById('inst-especie').value || '—';
  document.getElementById('lm-fecha').value       = new Date().toISOString().slice(0,10);
  document.getElementById('lm-cuenta').value      = '';
  document.getElementById('lm-monto').value       = '';
  document.getElementById('lm-descripcion').value = '';
  document.getElementById('llamadoResult').textContent = '';
  document.getElementById('modalLlamado').classList.add('active');
}

async function guardarLlamado(btn) {
  const resEl    = document.getElementById('llamadoResult');
  resEl.textContent = '';
  const cuentaId = parseInt(document.getElementById('lm-cuenta').value);
  const monto    = parseFloat(document.getElementById('lm-monto').value);
  const fecha    = document.getElementById('lm-fecha').value;
  const desc     = document.getElementById('lm-descripcion').value.trim() || null;
  if (!fecha || !(cuentaId > 0) || !(monto > 0)) {
    _showResultErr(resEl, 'Completá fecha, cuenta y monto.'); return;
  }
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
  return `<span style="color:${c};font-family:'IBM Plex Mono',monospace;font-size:11px">${s}$${_fmtARS(v)}</span>`;
};

async function cargarPnl() {
  const tbody = document.getElementById('pnlBody');
  if (!tbody) return;
  const desde   = document.getElementById('pnlFechaDesde')?.value || '';
  const hasta   = document.getElementById('pnlFechaHasta')?.value || '';
  const cliente = document.getElementById('pnlCliente')?.value.trim() || '';
  const especie = document.getElementById('pnlEspecie')?.value.trim() || '';
  _setTbodyLoading(tbody, 9);
  try {
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
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.volumen_comprado!=null?_fmtARS(r.volumen_comprado):'—'}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.volumen_vendido !=null?_fmtARS(r.volumen_vendido) :'—'}</td>
      </tr>
    `).join('');
    if (hasta) cargarResumenPnl(hasta);
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
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
          <div style="font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:var(--text1)">$${venta!=null?_fmtARS(venta):'—'}</div>
          ${compra ? `<div style="font-size:10px;color:var(--text3);margin-top:2px">Compra: $${_fmtARS(compra)}</div>` : ''}
        </div>`;
    }).filter(Boolean).join('');
    if (!el.innerHTML) el.innerHTML = '<div style="color:var(--text3);font-size:11px">Sin datos de tipo de cambio disponibles.</div>';
  } catch(e) {
    el.innerHTML = `<div style="color:var(--red);font-size:11px">Error: ${esc(e.message)}</div>`;
  }
}

async function cargarTcHistorico() {
  const tbody = document.getElementById('tcHistoricoBody');
  if (!tbody) return;
  const tipo  = document.getElementById('tcTipoFiltro')?.value  || '';
  const desde = document.getElementById('tcFechaDesde')?.value  || '';
  const hasta = document.getElementById('tcFechaHasta')?.value  || '';
  _setTbodyLoading(tbody, 5);
  try {
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
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.valor_compra!=null?'$'+_fmtARS(r.valor_compra):'—'}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.valor_venta !=null?'$'+_fmtARS(r.valor_venta) :'—'}</td>
        <td style="font-size:11px;color:var(--text3)">${esc(r.fuente||'—')}</td>
      </tr>
    `).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
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
  const tbody = document.getElementById('contrapartesBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 5);
  try {
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
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
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
  try {
    await _apiFetchJson(`/api/contrapartes/${id}`, 'PATCH', { activo });
    await cargarContrapartes();
  } catch { await cargarContrapartes(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── LÍMITES DE RIESGO ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarLimites() {
  const tbody = document.getElementById('limitesBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 8);
  try {
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
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">$${_fmtARS(l.valor_limite)}</td>
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
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
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
  try {
    await _apiFetchJson(`/api/riesgo/limites/${id}`, 'PATCH', { activo });
    await cargarLimites();
  } catch { await cargarLimites(); }
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
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">${r.precio!=null?'$'+_fmtARS(r.precio):'—'}</td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(r.fecha_liquidacion||'—')}</td>
        <td style="font-size:11px;color:var(--text3)">${esc(r.mercado||'—')}</td>
        <td><span style="font-size:10px;font-weight:600;color:#f0a500">${esc(r.estado||'PENDIENTE')}</span></td>
      </tr>
    `).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
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
      <td><span class="especie-tag">${esc(o.especie)}</span></td>
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
              <td><span class="especie-tag">${esc(o.especie)}</span></td>
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
          <td><span class="especie-tag">${esc(p.especie)}</span></td>
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
  const tbody = document.getElementById('operadoresBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 6);
  try {
    const res = await apiFetch('/api/operadores');
    if (!res.ok) return;
    const d = await res.json();
    const ops = d.operadores || [];
    if (!ops.length) {
      tbody.innerHTML = _emptyTableRow(7, 'Sin operadores registrados.');
      return;
    }
    tbody.innerHTML = ops.map(o => `<tr data-op-id="${o.id}" data-op-nombre="${esc(o.nombre)}" data-op-desk="${esc(o.desk)}" data-op-cliente="${esc(o.cliente_codigo || '')}">
      <td style="font-size:11px;color:var(--text3)">${o.id}</td>
      <td>${esc(o.nombre)}</td>
      <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(o.username)}</td>
      <td><span style="font-size:10px;font-weight:700;background:var(--bg4);border:1px solid var(--border);border-radius:2px;padding:2px 6px">${esc(o.desk)}</span></td>
      <td style="font-size:11px;color:var(--text2)">${o.cliente_codigo ? esc(o.cliente_codigo) : '<span style="color:var(--text3)">—</span>'}</td>
      <td><span style="color:${o.activo ? 'var(--green)' : 'var(--red)'};font-size:11px">${o.activo ? 'Activo' : 'Inactivo'}</span></td>
      <td><button class="btn-mini" onclick="abrirModalOperador(${o.id})">Editar</button></td>
    </tr>`).join('');
  } catch (e) { tbody.innerHTML = _emptyTableRow(6, 'Error al cargar.'); }
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

  if (!nombre) { if (resEl) resEl.innerHTML = '<span style="color:var(--red)">El nombre es requerido.</span>'; return; }
  if (!editId && !username) { if (resEl) resEl.innerHTML = '<span style="color:var(--red)">El username es requerido.</span>'; return; }

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
  const fechaEl = document.getElementById('pnlDeskFecha');
  const tbody   = document.getElementById('pnlDeskBody');
  if (!tbody) return;
  const fecha = fechaEl?.value || new Date().toISOString().slice(0, 10);
  _setTbodyLoading(tbody, 7);
  try {
    const res = await apiFetch(`/api/pnl/por-desk?fecha=${fecha}`);
    if (!res.ok) return;
    const d = await res.json();
    const desks = d.desks || [];
    if (!desks.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-muted">Sin datos P&L para ${esc(fecha)}.</td></tr>`;
      return;
    }
    const fmtARS = v => Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    tbody.innerHTML = desks.map(dk => {
      const totalColor = dk.pnl_total >= 0 ? 'var(--green)' : 'var(--red)';
      return `<tr>
        <td><span style="font-size:10px;font-weight:700;background:var(--bg4);border:1px solid var(--border);border-radius:2px;padding:2px 6px">${esc(dk.desk)}</span></td>
        <td style="text-align:right;color:${dk.pnl_realizado >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtARS(dk.pnl_realizado)}</td>
        <td style="text-align:right;color:${dk.pnl_no_realizado >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtARS(dk.pnl_no_realizado)}</td>
        <td style="text-align:right;color:${totalColor};font-weight:700">${fmtARS(dk.pnl_total)}</td>
        <td style="text-align:right">${fmtARS(dk.volumen_comprado)}</td>
        <td style="text-align:right">${fmtARS(dk.volumen_vendido)}</td>
        <td style="text-align:right;color:var(--text3)">${dk.n_posiciones}</td>
      </tr>`;
    }).join('');
  } catch (e) { tbody.innerHTML = _emptyTableRow(7, 'Error al cargar P&L por desk.'); }
}


// ═══════════════════════════════════════════════════════════════════════════
// ── VALUACIÓN DE PRECIOS (Feature 16) ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarPreciosHistorico() {
  const tbody = document.getElementById('preciosHistBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 5);
  const especie    = (document.getElementById('vpFiltroEspecie')?.value || '').trim().toUpperCase();
  const tipo       = document.getElementById('vpFiltroTipo')?.value || '';
  const desde      = document.getElementById('vpFiltroDesde')?.value || '';
  const hasta      = document.getElementById('vpFiltroHasta')?.value || '';
  const params = new URLSearchParams();
  if (especie) params.set('especie', especie);
  if (tipo)    params.set('precio_tipo', tipo);
  if (desde)   params.set('fecha_desde', desde);
  if (hasta)   params.set('fecha_hasta', hasta);
  try {
    const res = await apiFetch(`/api/prices/historico?${params}`);
    if (!res.ok) return;
    const d = await res.json();
    const rows = d.precios || [];
    if (!rows.length) { tbody.innerHTML = _emptyTableRow(5, 'Sin resultados.'); return; }
    const fmtP = v => Number(v).toLocaleString('es-AR', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
    const tipoBadge = t => {
      const colors = { AJUSTE: '#4a9eff', CORTE_MAE: '#f0a500', CIERRE: 'var(--text3)' };
      return `<span style="font-size:9px;font-weight:700;color:#fff;background:${colors[t]||'var(--border)'};border-radius:2px;padding:1px 4px">${esc(t)}</span>`;
    };
    tbody.innerHTML = rows.map(r => `<tr>
      <td style="font-size:11px">${esc(r.fecha)}</td>
      <td><span class="especie-tag">${esc(r.especie)}</span></td>
      <td class="precio-cell">${fmtP(r.precio)}</td>
      <td>${tipoBadge(r.precio_tipo)}</td>
      <td style="font-size:11px;color:var(--text3)">${esc(r.fuente)}</td>
    </tr>`).join('');
  } catch (e) { tbody.innerHTML = _emptyTableRow(5, 'Error al cargar.'); }
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
// ── SEGUIDOS (User Watchlist) ──────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════════

// ── Shared formatters ────────────────────────────────────────────────────────
const _fmtP = (v) => (v == null || v === 0) ? '—'
  : Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _fmtV = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(2);
const _varCls = (v) => v == null ? 'var-neutral' : (v >= 0 ? 'var-positiva' : 'var-negativa');

async function cargarSeguidos() {
  try {
    const res  = await apiFetch('/api/seguidos/lista');
    const data = await res.json();
    const tbody    = document.getElementById('tbl-seguidos-body');
    const emptyDiv = document.getElementById('seguidos-empty');

    if (!data || data.length === 0) {
      tbody.innerHTML = '';
      if (emptyDiv) emptyDiv.style.display = 'flex';
      return;
    }
    if (emptyDiv) emptyDiv.style.display = 'none';

    tbody.innerHTML = data.map(s => {
      const minMax = (s.precio_minimo_dia && s.precio_maximo_dia)
        ? `${_fmtP(s.precio_minimo_dia)} - ${_fmtP(s.precio_maximo_dia)}` : '—';
      return `<tr data-id="${s.id}">
        <td class="drag-handle" title="Arrastrar para reordenar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/>
            <circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/>
            <circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>
          </svg>
        </td>
        <td><span class="especie-link" data-action="abrir-ctx-seguido" data-especie="${esc(s.especie)}" data-id="${s.id}">${esc(s.especie)}</span></td>
        <td class="precio-cell">${_fmtP(s.precio_actual)}</td>
        <td class="precio-cell ${_varCls(s.variacion_diaria)}">${_fmtV(s.variacion_diaria)}%</td>
        <td class="precio-cell">${_fmtP(s.precio_cierre)}</td>
        <td class="cantidad-cell">${s.cantidad_compra}</td>
        <td class="precio-cell">${_fmtP(s.precio_promedio_compra)}</td>
        <td class="cantidad-cell">${s.cantidad_venta}</td>
        <td class="precio-cell">${_fmtP(s.precio_promedio_venta)}</td>
        <td class="minmax-cell">${minMax}</td>
        <td class="acciones">
          <button class="btn-remove" data-action="eliminar-seguido" data-id="${s.id}" title="Remover" aria-label="Remover">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </td>
      </tr>`;
    }).join('');

    _initDragSeguidos();
  } catch {
    document.getElementById('tbl-seguidos-body').innerHTML =
      '<tr><td colspan="11" style="text-align:center;color:var(--text3);padding:12px">Error al cargar seguidos.</td></tr>';
    const emptyDiv = document.getElementById('seguidos-empty');
    if (emptyDiv) emptyDiv.style.display = 'none';
  }
}

// ── Drag & drop para reordenar seguidos ──────────────────────────────────────

let _dragSrc       = null;  // fila siendo arrastrada
let _ordenSnapshot = null;  // IDs en orden previo al drag (para rollback)

function _initDragSeguidos() {
  const tbody = document.getElementById('tbl-seguidos-body');
  if (!tbody || tbody._dndBound) return;
  tbody._dndBound = true;

  // Activar draggable solo cuando el pointerdown viene del handle
  tbody.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('tr');
    if (!row) return;
    row.draggable = !!e.target.closest('.drag-handle');
  });

  tbody.addEventListener('dragstart', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (!row || !row.draggable) {
      e.preventDefault();
      return;
    }
    _dragSrc       = row;
    _ordenSnapshot = Array.from(tbody.querySelectorAll('tr[data-id]')).map(r => r.dataset.id);
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.id); // requerido por Firefox
  });

  tbody.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('tr[data-id]');
    if (!target || target === _dragSrc) return;

    tbody.querySelectorAll('tr.drag-over-top, tr.drag-over-bottom')
         .forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));

    const rect = target.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      target.classList.add('drag-over-top');
      tbody.insertBefore(_dragSrc, target);
    } else {
      target.classList.add('drag-over-bottom');
      tbody.insertBefore(_dragSrc, target.nextSibling);
    }
  });

  tbody.addEventListener('dragleave', (e) => {
    const target = e.target.closest('tr[data-id]');
    if (target) target.classList.remove('drag-over-top', 'drag-over-bottom');
  });

  tbody.addEventListener('drop', (e) => {
    e.preventDefault();
    tbody.querySelectorAll('tr.drag-over-top, tr.drag-over-bottom')
         .forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
    if (_dragSrc) {
      _dragSrc.classList.remove('dragging');
      _dragSrc.draggable = false;
    }
    _dragSrc = null;
    _persistirOrdenSeguidos();
  });

  tbody.addEventListener('dragend', () => {
    tbody.querySelectorAll('tr').forEach(r => {
      r.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
      r.draggable = false;
    });
    _dragSrc = null;
    _ordenSnapshot = null;
  });
}

async function _persistirOrdenSeguidos() {
  const tbody    = document.getElementById('tbl-seguidos-body');
  const snapshot = _ordenSnapshot;
  _ordenSnapshot = null;

  const ids = Array.from(tbody.querySelectorAll('tr[data-id]'))
                   .map(r => Number(r.dataset.id));

  try {
    const res = await apiFetch('/api/seguidos/reordenar', {
      method : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(await res.text());
  } catch {
    showToast('Error al guardar el orden — revertiendo', 'error');
    if (snapshot) {
      const map = {};
      tbody.querySelectorAll('tr[data-id]').forEach(r => { map[r.dataset.id] = r; });
      snapshot.forEach(id => tbody.appendChild(map[id]));
    }
  }
}

// ── Context menu Seguidos ─────────────────────────────────────────────────────

let _ctxEspecie = null;
let _ctxSegId   = null;

function abrirCtxSeguido(e, especie, id) {
  e.preventDefault();
  e.stopPropagation();
  _ctxEspecie = especie;
  _ctxSegId   = id;

  const menu = document.getElementById('ctxMenuSeguido');
  if (!menu) return;

  // Position near cursor, adjust if near edge
  const pad  = 6;
  const mw   = 170;
  const mh   = 120;
  let x = e.clientX;
  let y = e.clientY;
  if (x + mw > window.innerWidth  - pad) x = window.innerWidth  - mw - pad;
  if (y + mh > window.innerHeight - pad) y = window.innerHeight - mh - pad;

  menu.style.left    = x + 'px';
  menu.style.top     = y + 'px';
  menu.style.display = 'block';
  menu.focus();
}

function cerrarCtxSeguido() {
  const menu = document.getElementById('ctxMenuSeguido');
  if (menu) menu.style.display = 'none';
  _ctxEspecie = null;
  _ctxSegId   = null;
}

function ctxSegVerPuntas() {
  const esp = _ctxEspecie;
  cerrarCtxSeguido();
  if (esp) abrirModalDetalleSeguido(esp);
}

function ctxSegNuevaOrden() {
  const esp = _ctxEspecie;
  cerrarCtxSeguido();
  if (esp) abrirModalOrdenConEspecie(esp);
}

function ctxSegRemover() {
  const id      = _ctxSegId;
  const especie = _ctxEspecie;
  cerrarCtxSeguido();
  if (id == null) return;
  eliminarSeguido({ dataset: { id: String(id) } }, especie);
}

// Close context menu on outside click or Escape
document.addEventListener('click', (e) => {
  const menu = document.getElementById('ctxMenuSeguido');
  if (menu && menu.style.display !== 'none' && !menu.contains(e.target)) {
    cerrarCtxSeguido();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const menu = document.getElementById('ctxMenuSeguido');
    if (menu && menu.style.display !== 'none') { cerrarCtxSeguido(); }
  }
});

// ── Modal detalle (ver puntas, modo solo lectura) ─────────────────────────────

function abrirModalDetalleSeguido(especie) {
  const modal    = document.getElementById('modalAgregarSeguido');
  const inner    = modal?.querySelector('.modal-seguido');
  const titulo   = document.getElementById('modalSeguidoTitulo');
  const subtitulo = document.getElementById('modalSeguidoSubtitulo');
  if (!modal || !inner) return;

  inner.classList.add('modo-detalle');
  if (titulo)    titulo.textContent    = especie;
  if (subtitulo) subtitulo.textContent = 'Precio y puntas en tiempo real';

  _stopPreviewPolling();
  _resetPreviewSeguido();

  // Pre-fill input (hidden in modo-detalle but used by poll/refresh)
  const input = document.getElementById('seguirInputModal');
  if (input) input.value = especie;

  modal.classList.add('active');
  _cargarPreviewSeguido(especie);
  _startPreviewPolling();
}

// ── Nueva orden con especie pre-cargada ───────────────────────────────────────

function abrirModalOrdenConEspecie(especie) {
  _resetNuevaOrdenForm();
  const fEspecie = document.getElementById('f-especie');
  if (fEspecie) {
    fEspecie.value = especie.toUpperCase();
    // Trigger the input event so the orderbook loads automatically
    fEspecie.dispatchEvent(new Event('input'));
  }
  abrirModalOrden();
}

// ── Modal Agregar Seguido ─────────────────────────────────────────────────────

let _segPreviewInterval = null;
const _SEG_PREVIEW_INTERVAL_MS = 15_000;

function _getEspecieModal() {
  return (document.getElementById('seguirInputModal')?.value || '').trim().toUpperCase();
}

function _refrescarPreviewSeguidoManual() {
  const esp = _getEspecieModal();
  if (esp.length >= 2) _cargarPreviewSeguido(esp);
}

function _startPreviewPolling() {
  _stopPreviewPolling();
  _segPreviewInterval = setInterval(() => {
    const esp = _getEspecieModal();
    if (esp.length >= 2) _cargarPreviewSeguido(esp);
  }, _SEG_PREVIEW_INTERVAL_MS);
}

function _stopPreviewPolling() {
  if (_segPreviewInterval !== null) {
    clearInterval(_segPreviewInterval);
    _segPreviewInterval = null;
  }
}

async function abrirModalSeguido() {
  const modal = document.getElementById('modalAgregarSeguido');
  if (!modal) return;

  // Reset state
  _stopPreviewPolling();
  _resetPreviewSeguido();
  const input = document.getElementById('seguirInputModal');
  if (input) { input.value = ''; input.focus(); }

  const btnConfirmar = document.getElementById('btnConfirmarSeguido');
  if (btnConfirmar) btnConfirmar.disabled = true;

  // Populate datalist
  try {
    const res = await apiFetch('/api/seguidos/especies');
    const especies = await res.json();
    const datalist = document.getElementById('especiesListModal');
    if (datalist) datalist.innerHTML = especies.map(e => `<option value="${e}">`).join('');
  } catch { /* non-critical */ }

  modal.classList.add('active');
  _startPreviewPolling();
}

function cerrarModalSeguido() {
  _stopPreviewPolling();
  const modal = document.getElementById('modalAgregarSeguido');
  if (!modal) return;
  modal.classList.remove('active');

  // Restore to "agregar" mode in case it was opened in detalle mode
  const inner     = modal.querySelector('.modal-seguido');
  const titulo    = document.getElementById('modalSeguidoTitulo');
  const subtitulo = document.getElementById('modalSeguidoSubtitulo');
  inner?.classList.remove('modo-detalle');
  if (titulo)    titulo.textContent    = 'Agregar activo a Seguidos';
  if (subtitulo) subtitulo.textContent = 'Buscá un instrumento, revisá su info y agregalo a tu lista';
}

function _resetPreviewSeguido() {
  document.getElementById('seguido-preview')?.style.setProperty('display', 'none');
  const ph = document.getElementById('seguido-preview-placeholder');
  if (ph) ph.style.display = '';
  document.getElementById('obPanelSeguido').innerHTML =
    '<div class="ob-placeholder">Ingresá una especie para ver las puntas</div>';
  const btnConfirmar = document.getElementById('btnConfirmarSeguido');
  if (btnConfirmar) btnConfirmar.disabled = true;
}

async function _cargarPreviewSeguido(especie) {
  // Load price preview
  const pm = document.getElementById('seguido-preview');
  const ph = document.getElementById('seguido-preview-placeholder');

  try {
    const res  = await apiFetch(`/api/seguidos/preview/${encodeURIComponent(especie)}`);
    if (!res.ok) { _resetPreviewSeguido(); return; }
    const data = await res.json();

    // Populate preview card
    document.getElementById('sp-especie').textContent = especie;

    const varVal = data.variacion_pct;
    const varEl  = document.getElementById('sp-var');
    varEl.textContent = varVal != null ? (varVal >= 0 ? '+' : '') + varVal.toFixed(2) + '%' : '—';
    varEl.className = 'seguido-preview-var ' + (varVal == null ? 'neu' : varVal >= 0 ? 'pos' : 'neg');

    document.getElementById('sp-precio').textContent = data.precio != null ? _fmtP(data.precio) : '—';
    document.getElementById('sp-cierre').textContent = _fmtP(data.precio_cierre);
    document.getElementById('sp-min').textContent    = _fmtP(data.precio_minimo);
    document.getElementById('sp-max').textContent    = _fmtP(data.precio_maximo);
    document.getElementById('sp-vol').textContent    = data.volumen_dia
      ? Number(data.volumen_dia).toLocaleString('es-AR') : '—';

    if (ph) ph.style.display = 'none';
    if (pm) pm.style.display = '';

    // Enable confirm button
    const btn = document.getElementById('btnConfirmarSeguido');
    if (btn) btn.disabled = false;
  } catch {
    _resetPreviewSeguido();
  }

  // Load orderbook independently (non-blocking)
  try {
    const obRes  = await apiFetch(`/api/orderbook/${encodeURIComponent(especie)}`);
    const obData = await obRes.json();
    _renderOrderbookSeguido(obData);
  } catch {
    document.getElementById('obPanelSeguido').innerHTML = '<div class="ob-error">Error al cargar puntas</div>';
  }
}

function _renderOrderbookSeguido(data) {
  const panel = document.getElementById('obPanelSeguido');
  if (!panel) return;

  if (!data.tiene_datos) {
    panel.innerHTML = `<div class="ob-placeholder">Sin datos para <b>${esc(data.especie)}</b></div>`;
    return;
  }

  const fmt  = v => v == null ? '—' : Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQ = v => v == null ? '—' : Number(v).toLocaleString('es-AR');

  const allQty = [...data.bids, ...data.asks].map(r => r.cantidad || 0).filter(Boolean);
  const maxQty = allQty.length ? Math.max(...allQty) : 1;

  const varStr = data.variacion_pct != null
    ? `<span class="ob-var ${data.variacion_pct >= 0 ? 'ob-var-pos' : 'ob-var-neg'}">${data.variacion_pct >= 0 ? '+' : ''}${data.variacion_pct}%</span>`
    : '';

  const numRows = Math.max(data.bids.length, data.asks.length, 1);
  let rows = '';
  for (let i = 0; i < numRows; i++) {
    const bid = data.bids[i] || null;
    const ask = data.asks[i] || null;
    const bidPct = bid?.cantidad ? Math.round(bid.cantidad / maxQty * 100) : 0;
    const askPct = ask?.cantidad ? Math.round(ask.cantidad / maxQty * 100) : 0;
    rows += `<tr class="ob4-row">
      <td class="ob4-bid-qty" style="--d:${bidPct}%">${bid ? fmtQ(bid.cantidad) : ''}</td>
      <td class="ob4-bid-price">${bid ? fmt(bid.precio) : ''}</td>
      <td class="ob4-ask-price">${ask ? fmt(ask.precio) : ''}</td>
      <td class="ob4-ask-qty" style="--d:${askPct}%">${ask ? fmtQ(ask.cantidad) : ''}</td>
    </tr>`;
  }
  if (!data.bids.length && !data.asks.length) {
    rows = `<tr><td colspan="4" style="padding:8px 4px;color:var(--text3);font-size:11px;text-align:center">Sin puntas disponibles</td></tr>`;
  }

  panel.innerHTML = `
    <div class="ob-header">
      <div class="ob-especie-name">${esc(data.especie)}</div>
      <div class="ob-last-line">${data.ultimo != null ? fmt(data.ultimo) : '—'}${varStr}</div>
    </div>
    <table class="ob-table ob4-table">
      <thead><tr>
        <th class="ob4-th ob4-th-r">Cant.</th>
        <th class="ob4-th ob4-th-r">Compra</th>
        <th class="ob4-th">Venta</th>
        <th class="ob4-th">Cant.</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function confirmarAgregarSeguido() {
  const input   = document.getElementById('seguirInputModal');
  const especie = (input?.value || '').trim().toUpperCase();
  if (!especie) return;

  const btn = document.getElementById('btnConfirmarSeguido');
  if (btn) { btn.disabled = true; btn.textContent = 'Agregando...'; }

  try {
    const res = await apiFetch('/api/seguidos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ especie, precio_compra_meta: null, precio_venta_meta: null }),
    });

    if (res.ok) {
      cerrarModalSeguido();
      showToast(`${especie} agregado a seguidos ✓`, 'success');
      await cargarSeguidos();
    } else {
      const err = await res.json();
      showToast(err.detail || 'Error al agregar', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '+ Agregar a Seguidos'; }
    }
  } catch {
    showToast('Error de red', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '+ Agregar a Seguidos'; }
  }
}

function eliminarSeguido(el, especieOverride) {
  const seguido_id = Number(el.dataset.id);
  const row = el.closest?.('tr');
  const especie = especieOverride || (row ? row.querySelector('.especie-link')?.textContent.trim() : null) || 'activo';

  _confirmar(
    'Quitar seguido',
    `¿Removés ${especie} de tu lista de seguidos?`,
    async () => {
      try {
        const res = await apiFetch(`/api/seguidos/${seguido_id}`, { method: 'DELETE' });
        if (res.ok) {
          showToast(`${especie} removido ✓`, 'success');
          await cargarSeguidos();
        } else {
          showToast('Error al remover', 'error');
        }
      } catch (e) {
        showToast('Error de red', 'error');
      }
    }
  );
}

async function refrescarSeguidos() {
  const btn = document.getElementById('btnRefreshSeguidos');
  if (!btn) return;

  const svgHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
  btn.disabled = true;
  btn.classList.add('spinning');
  btn.innerHTML = `${svgHTML} Actualizando...`;

  try {
    // First refresh market prices
    await apiFetch('/api/mercado/refresh', { method: 'POST' });
    // Then reload watchlist
    await cargarSeguidos();
    btn.classList.remove('spinning');
    btn.innerHTML = `${svgHTML} ✓ Actualizado`;
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = `${svgHTML} Actualizar`;
    }, 2000);
  } catch (e) {
    btn.classList.remove('spinning');
    btn.innerHTML = `${svgHTML} Error`;
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = `${svgHTML} Actualizar`;
    }, 2000);
  }
}
