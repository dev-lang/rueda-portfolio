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


