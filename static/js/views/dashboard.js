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
