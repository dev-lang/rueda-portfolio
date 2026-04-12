// ── TOAST SYSTEM ───────────────────────────────────────────────────────────
/**
 * showToast(msg, type, title, opts)
 *  type: 'ok' | 'error' | 'warn'  (default 'ok')
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
/**
 * Standard table-load wrapper: guards the element, shows loading, calls fn(tbody),
 * and catches any thrown error, rendering it as an error row automatically.
 * @param {string}   tbodyId – ID of the <tbody> element
 * @param {number}   cols    – colspan for the error row
 * @param {function} fn      – async (tbody: HTMLElement) => void
 */
async function _cargarTabla(tbodyId, cols, fn) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  _setTbodyLoading(tbody, cols);
  try {
    await fn(tbody);
  } catch(e) {
    tbody.innerHTML = _errorTableRow(cols, e.message);
  }
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

// ── ERROR TABLE ROW HELPER ────────────────────────────────────────────────
/** Returns a single-row colspan cell styled as an error message. */
function _errorTableRow(colSpan, msg) {
  return `<tr><td colspan="${colSpan}" style="color:var(--red)">Error: ${esc(msg)}</td></tr>`;
}

// ── PAGINATION HELPER ────────────────────────────────────────────────────
/**
 * Calcula el rango de registros visible en una página y genera el texto descriptivo.
 * @param {number} page    – página actual (1-based)
 * @param {number} perPage – registros por página
 * @param {number} total   – total de registros
 * @param {string} label   – sustantivo plural (ej: 'órdenes', 'registros')
 * @returns {{ from: number, to: number, text: string }}
 */
function _calcularPaginacion(page, perPage, total, label = 'registros') {
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to   = Math.min(page * perPage, total);
  const text = total > 0 ? `Mostrando ${from}–${to} de ${total} ${label}` : `Sin ${label}`;
  return { from, to, text };
}

// ── TAB SWITCH HELPER ─────────────────────────────────────────────────────
/**
 * Activa un tab: marca el botón activo y muestra/oculta los paneles de contenido.
 * @param {string}   tab           – valor del tab activo
 * @param {string[]} tabs          – array de todos los valores posibles
 * @param {string}   btnPrefix     – prefijo del id del botón  (btnPrefix + tab)
 * @param {string}   contentPrefix – prefijo del id del panel  (contentPrefix + tab)
 * @param {function} [onSwitch]    – callback opcional(tab) ejecutado al final
 */
function _switchTab(tab, tabs, btnPrefix, contentPrefix, onSwitch) {
  tabs.forEach(t => {
    const btn = document.getElementById(`${btnPrefix}${t}`);
    const div = document.getElementById(`${contentPrefix}${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    if (div) div.style.display = t === tab ? '' : 'none';
  });
  if (onSwitch) onSwitch(tab);
}

// ── TOGGLE PATCH HELPER ───────────────────────────────────────────────────
/**
 * Send a PATCH for a toggle (active flag, etc.) and refresh the table afterwards.
 * On error, the refresher still runs so the UI snaps back to the real DB state.
 */
async function _togglePatch(url, body, refresher) {
  try { await _apiFetchJson(url, 'PATCH', body); }
  catch(e) { _logError('togglePatch', e); }
  finally { if (refresher) await refresher(); }
}

// ── BADGE HELPERS ──────────────────────────────────────────────────────────
/** Renderiza un span especie-tag, o un texto en gris si especie es falsy. */
function _badgeEspecie(especie, fallback = 'Todas') {
  return especie
    ? `<span class="especie-tag">${esc(especie)}</span>`
    : `<span style="color:var(--text3)">${fallback}</span>`;
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
