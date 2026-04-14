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


