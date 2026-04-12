// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: UTILITARIOS
// ══════════════════════════════════════════════════════════════════════════════

async function cargarUtilitarios() {
  try {
    const [statsRes, healthRes] = (await Promise.allSettled([
      apiFetch('/api/utils/stats'),
      apiFetch('/api/utils/health'),
    ])).map(r => r.status === 'fulfilled' ? r.value : null);
    if (statsRes?.ok) {
      renderStats(await statsRes.json());
    } else {
      document.getElementById('statsGrid').innerHTML =
        '<div style="color:var(--text3);font-size:12px;padding:8px 0">Sin datos de estadísticas.</div>';
    }
    if (healthRes?.ok) {
      const health = await healthRes.json();
      renderHealth(health.servicios);
    } else {
      document.getElementById('healthGrid').innerHTML =
        '<div class="health-card desconocido"><div class="health-name">Sin datos de servicios</div></div>';
    }
  } catch (e) {
    document.getElementById('healthGrid').innerHTML =
      '<div class="health-card desconocido"><div class="health-name">Error al cargar servicios</div></div>';
    document.getElementById('statsGrid').innerHTML =
      '<div style="color:var(--text3);font-size:12px;padding:8px 0">Error al cargar estadísticas.</div>';
  }
  cargarAuditLog();
}

async function cargarAuditLog() {
  const operacion = document.getElementById('auditFiltroOp').value;
  const params = new URLSearchParams({ limit: 100 });
  if (operacion) params.set('operacion', operacion);

  try {
    const res = await apiFetch(`/api/audit?${params}`);
    const data = await res.json();
    renderAuditLog(data.logs);
  } catch (e) {
    document.getElementById('auditBody').innerHTML =
      `<tr><td colspan="5">Error al cargar audit log.</td></tr>`;
  }
}

function renderAuditLog(logs) {
  const tbody = document.getElementById('auditBody');
  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-muted">Sin entradas en el audit log.</td></tr>`;
    return;
  }
  const opColors = { CREATE: 'green', EXECUTE: 'accent', UPDATE: 'orange', CANCEL: 'red' };
  tbody.innerHTML = logs.map(l => {
    const col = opColors[l.operacion] || 'text3';
    return `
      <tr>
        <td style="color:var(--text3); white-space:nowrap">${esc(l.timestamp)}</td>
        <td><span class="inst-badge inst-${col === 'accent' ? 'green' : col}" style="color:var(--${col})">${esc(l.operacion)}</span></td>
        <td style="color:var(--text3)">${esc(l.tabla)}</td>
        <td style="color:var(--text3)">${esc(l.record_id)}</td>
        <td style="font-size:11px">${esc(l.descripcion) || '—'}</td>
      </tr>
    `;
  }).join('');
}

function renderStats(stats) {
  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card-big">
      <div class="stat-num">${fmtInt(stats.ordenes_total)}</div>
      <div class="stat-desc">Órdenes</div>
    </div>
    <div class="stat-card-big">
      <div class="stat-num">${fmtInt(stats.ejecuciones_total)}</div>
      <div class="stat-desc">Ejecuciones</div>
    </div>
    <div class="stat-card-big">
      <div class="stat-num">${fmtInt(stats.posiciones_total)}</div>
      <div class="stat-desc">Posiciones</div>
    </div>
    <div class="stat-card-big">
      <div class="stat-num">${fmtInt(stats.notificaciones_total)}</div>
      <div class="stat-desc">Notificaciones</div>
    </div>
  `;
}

function renderHealth(servicios) {
  document.getElementById('healthGrid').innerHTML = servicios.map(s => `
    <div class="health-card ${esc(s.estado)}">
      <div class="health-name">
        <span class="health-dot ${esc(s.estado)}"></span>
        ${esc(s.nombre)}
      </div>
      <div class="health-estado">${esc(s.estado).toUpperCase()} · ${esc(s.timestamp) || 'sin datos'}</div>
      <div class="health-msg">${esc(s.mensaje) || '—'}</div>
    </div>
  `).join('');
}

function confirmarReset() {
  const modal = document.getElementById('modalConfirmReset');
  document.getElementById('resetConfirmInput').value = '';
  document.getElementById('btnEjecutarReset').disabled = true;
  modal.classList.add('active');
}

async function ejecutarReset(btn) {
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Ejecutando...'; }
  document.getElementById('modalConfirmReset').classList.remove('active');
  try {
    const res = await apiFetch('/api/utils/seed-reset', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.mensaje, 'ok', 'Reset completado');
      cargarUtilitarios();
    } else {
      showToast(data.detail || 'Error en el reset.', 'error');
    }
  } catch {
    showToast('Error de conexión.', 'error');
  } finally {
    if (btn) { btn.disabled = false; if (origText) btn.textContent = origText; }
  }
}
