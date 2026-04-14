// ═══════════════════════════════════════════════════════════════════════════
// ── CONTRAPARTES ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarContrapartes() {
  await _cargarTabla('contrapartesBody', 5, async (tbody) => {
    const res   = await apiFetch('/api/contrapartes');
    const data  = await res.json();
    const items = data.contrapartes || [];
    if (!items.length) { tbody.innerHTML = _emptyTableRow(5, 'Sin contrapartes.'); return; }
    _contraparteDataMap = _buildDataMap(items);
    tbody.innerHTML = items.map(c => `
      <tr>
        <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(c.codigo)}</span></td>
        <td>${esc(c.nombre)}</td>
        <td><span class="badge-tipo" style="font-size:10px;opacity:.8">${esc(c.tipo||'—')}</span></td>
        <td>
          <label class="toggle-switch">
            <input type="checkbox" ${c.activo?'checked':''} onchange="toggleContraparteActivo(${c.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td><button class="btn-mini" onclick="abrirModalContraparte(${c.id})">Editar</button></td>
      </tr>
    `).join('');
  });
}

function abrirModalContraparte(cp = null) {
  if (typeof cp === 'number' || (typeof cp === 'string' && cp !== '')) {
    cp = _contraparteDataMap[+cp] || null;
  }
  document.getElementById('cpResult').textContent = '';
  if (cp && typeof cp === 'object') {
    document.getElementById('modalCpTitulo').textContent = 'Editar Contraparte';
    document.getElementById('cp-id').value     = cp.id;
    document.getElementById('cp-codigo').value = cp.codigo;
    document.getElementById('cp-nombre').value = cp.nombre;
    document.getElementById('cp-tipo').value   = cp.tipo || 'MERCADO';
    document.getElementById('cp-codigo').disabled = true;
  } else {
    document.getElementById('modalCpTitulo').textContent = 'Nueva Contraparte';
    document.getElementById('cp-id').value     = '';
    document.getElementById('cp-codigo').value = '';
    document.getElementById('cp-nombre').value = '';
    document.getElementById('cp-tipo').value   = 'MERCADO';
    document.getElementById('cp-codigo').disabled = false;
  }
  document.getElementById('cp-lim-valor').value  = '';
  document.getElementById('cp-lim-alerta').value = '80';
  document.getElementById('modalContraparte').classList.add('active');
}

async function guardarContraparte(btn) {
  const resEl  = document.getElementById('cpResult');
  resEl.textContent = '';
  const id     = document.getElementById('cp-id').value;
  const codigo = document.getElementById('cp-codigo').value.trim().toUpperCase();
  const nombre = document.getElementById('cp-nombre').value.trim();
  const tipo   = document.getElementById('cp-tipo').value;
  if (!codigo || !nombre) { _showResultErr(resEl, 'Código y nombre son requeridos.'); return; }

  await _withButtonLoading(btn, async () => {
    try {
      let res, cpId;
      if (id) {
        res  = await _apiFetchJson(`/api/contrapartes/${id}`, 'PATCH', { nombre });
        cpId = id;
      } else {
        res  = await _apiFetchJson('/api/contrapartes', 'POST', { codigo, nombre, tipo });
        if (res.ok) { const d = await res.json(); cpId = d.id; }
      }
      if (!res.ok) { const e = await res.json(); _showResultErr(resEl, e.detail || 'Error'); return; }
      const limValor = parseFloatOrNull(document.getElementById('cp-lim-valor').value);
      if (cpId && limValor > 0) {
        const moneda = document.getElementById('cp-lim-moneda').value;
        const alerta = parseFloat(document.getElementById('cp-lim-alerta').value) || 80;
        await _apiFetchJson(`/api/contrapartes/${cpId}/limites`, 'PUT',
          { moneda, limite: limValor, alerta_pct: alerta });
      }
      document.getElementById('modalContraparte').classList.remove('active');
      await cargarContrapartes();
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

async function toggleContraparteActivo(id, activo) {
  return _togglePatch(`/api/contrapartes/${id}`, { activo }, cargarContrapartes);
}

