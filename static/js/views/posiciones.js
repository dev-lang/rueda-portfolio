// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: HEATMAP DE POSICIONES
// ══════════════════════════════════════════════════════════════════════════════

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
