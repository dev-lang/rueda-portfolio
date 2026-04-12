// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: SEGUIDOS (User Watchlist)
// ══════════════════════════════════════════════════════════════════════════════

// ── Shared formatters ────────────────────────────────────────────────────────
const _fmtP = v => (v == null || v === 0) ? '—' : fmt(v);
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
    _logError('refrescarSeguidos', e);
    showToast('No se pudieron actualizar los seguidos. Verificá tu conexión.', 'error');
    btn.classList.remove('spinning');
    btn.innerHTML = `${svgHTML} Error`;
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = `${svgHTML} Actualizar`;
    }, 2000);
  }
}
