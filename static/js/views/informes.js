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
        <div class="conc-label">${alerta}${_badgeEspecie(r.especie)}</div>
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
      <td>${_badgeEspecie(t.especie)}</td>
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
        <td>${_badgeEspecie(s.especie)}</td>
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
