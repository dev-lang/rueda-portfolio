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

