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


