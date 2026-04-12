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
    return renderRow(o, isNew);
  }).join('');
  // Reemplaza el Set con los IDs del render actual: evita crecimiento
  // ilimitado y garantiza que el próximo refresh detecte solo filas realmente nuevas.
  _knownOrderIds.clear();
  ordenes.forEach(o => _knownOrderIds.add(o.id));
  _reapplySort(document.getElementById('ordersTable'));
}

const _knownOrderIds = new Set();   // tracks IDs already seen to detect new rows

function renderRow(o, isNew = false) {
  const pct = Number(o.progreso) || 0;
  const isFull = pct >= 100;
  return `
    <tr class="${isNew ? 'new-flash' : ''} row-${esc(o.estado_color)}" data-id="${esc(o.id)}" data-action="ver-detalle">
      <td><span class="tipo-badge tipo-${esc(o.tipo_orden)}">${esc(o.tipo_orden)}</span></td>
      <td><span class="nro-cell">${esc(o.nro_orden)}</span></td>
      <td>${esc(o.fecha_orden)}</td>
      <td>${esc(o.cliente)}</td>
      <td>${esc(o.razon_social)}</td>
      <td>${_badgeEspecie(o.especie)}</td>
      <td class="precio-cell">${esc(o.moneda)}</td>
      <td class="precio-cell">${o.tipo_precio === 'MERCADO' ? '<span style="color:var(--accent);font-size:10px">MKT</span>' : fmt(o.precio_limite)}</td>
      <td>
        <div class="progress-wrap">
          <div class="progress-bar">
            <div class="progress-fill ${isFull ? 'full' : ''}" style="width:${pct}%"></div>
          </div>
          <div class="progress-pct">${pct}%</div>
        </div>
      </td>
      <td><span class="ejec-cell">${esc(o.ejecutado_total)}</span></td>
      <td class="precio-cell">${o.precio_promedio > 0 ? fmt(o.precio_promedio) : '—'}</td>
      <td>
        <span class="inst-badge inst-${esc(o.estado_color)}">
          [${esc(o.instancia_codigo)}] ${esc(o.instancia)}
        </span>
      </td>
    </tr>`;
}

function updateOrdenEnTabla(orden) {
  const tbody = document.getElementById('ordersBody');
  const oldRow = tbody.querySelector(`tr[data-id="${orden.id}"]`);
  if (!oldRow) return;

  const pct = Number(orden.progreso) || 0;
  const isFull = pct >= 100;
  oldRow.className = `updated-flash row-${esc(orden.estado_color)}`;
  oldRow.innerHTML = `
    <td><span class="tipo-badge tipo-${esc(orden.tipo_orden)}">${esc(orden.tipo_orden)}</span></td>
    <td><span class="nro-cell">${esc(orden.nro_orden)}</span></td>
    <td>${esc(orden.fecha_orden)}</td>
    <td>${esc(orden.cliente)}</td>
    <td>${esc(orden.razon_social)}</td>
    <td>${_badgeEspecie(orden.especie)}</td>
    <td class="precio-cell">${esc(orden.moneda)}</td>
    <td class="precio-cell">${orden.tipo_precio === 'MERCADO' ? '<span style="color:var(--accent);font-size:10px">MKT</span>' : fmt(orden.precio_limite)}</td>
    <td>
      <div class="progress-wrap">
        <div class="progress-bar">
          <div class="progress-fill ${isFull ? 'full' : ''}" style="width:${pct}%"></div>
        </div>
        <div class="progress-pct">${pct}%</div>
      </div>
    </td>
    <td><span class="ejec-cell">${esc(orden.ejecutado_total)}</span></td>
    <td class="precio-cell">${orden.precio_promedio > 0 ? fmt(orden.precio_promedio) : '—'}</td>
    <td><span class="inst-badge inst-${esc(orden.estado_color)}">[${esc(orden.instancia_codigo)}] ${esc(orden.instancia)}</span></td>
  `;

  const idx = state.ordenes.findIndex(o => o.id === orden.id);
  if (idx !== -1) state.ordenes[idx] = orden;
}

function renderPaginacion(total, page, pages) {
  const info = document.getElementById('paginationInfo');
  const ctrl = document.getElementById('paginationControls');

  info.textContent = _calcularPaginacion(page, state.perPage, total, 'órdenes').text;

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

function _leerFormOrden() {
  const cantStr = document.getElementById('f-cantidad').value;
  return {
    tipoPrecio:  document.getElementById('f-tipo-precio').value,
    precioStr:   document.getElementById('f-precio').value,
    cantStr,
    tif:         document.getElementById('f-tif').value,
    fechaExp:    document.getElementById('f-fecha-exp').value,
    cantVisible: document.getElementById('f-cant-visible').value,
    tipoAct:     document.getElementById('f-tipo-activacion').value,
    precioAct:   document.getElementById('f-precio-activacion').value,
    deskVal:     document.getElementById('f-desk')?.value || '',
    especie:     document.getElementById('f-especie').value.toUpperCase().trim(),
    cantidad:    parseInt(cantStr),
  };
}

function _validarFormOrden({ especie, cantidad, tipoPrecio, precioStr, tif, fechaExp, tipoAct, precioAct }) {
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
  return hasError;
}

async function enviarNuevaOrden() {
  const btn = document.querySelector('#modalNuevaOrden .btn-nueva-orden[data-action="enviar-nueva-orden"]')
           || document.querySelector('#modalNuevaOrden button[type="submit"]')
           || document.querySelector('#modalNuevaOrden .modal-footer .btn-nueva-orden');
  if (btn?.disabled) return;

  // ── Read + validate BEFORE disabling button (prevents ghost-disabled state) ─
  const fields = _leerFormOrden();
  if (_validarFormOrden(fields)) return;

  const { especie, cantidad, tipoPrecio, precioStr, tif, fechaExp, cantVisible, tipoAct, precioAct, deskVal } = fields;

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
