// ═══════════════════════════════════════════════════════════════════════════
// ── OPERADORES / DESKS (Feature 15) ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarOperadores() {
  await _cargarTabla('operadoresBody', 7, async (tbody) => {
    const res = await apiFetch('/api/operadores');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const ops = d.operadores || [];
    if (!ops.length) { tbody.innerHTML = _emptyTableRow(7, 'Sin operadores registrados.'); return; }
    tbody.innerHTML = ops.map(o => `<tr data-op-id="${o.id}" data-op-nombre="${esc(o.nombre)}" data-op-desk="${esc(o.desk)}" data-op-cliente="${esc(o.cliente_codigo || '')}">
      <td style="font-size:11px;color:var(--text3)">${o.id}</td>
      <td>${esc(o.nombre)}</td>
      <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(o.username)}</td>
      <td><span style="font-size:10px;font-weight:700;background:var(--bg4);border:1px solid var(--border);border-radius:2px;padding:2px 6px">${esc(o.desk)}</span></td>
      <td style="font-size:11px;color:var(--text2)">${o.cliente_codigo ? esc(o.cliente_codigo) : '<span style="color:var(--text3)">—</span>'}</td>
      <td><span style="color:${o.activo ? 'var(--green)' : 'var(--red)'};font-size:11px">${o.activo ? 'Activo' : 'Inactivo'}</span></td>
      <td><button class="btn-mini" onclick="abrirModalOperador(${o.id})">Editar</button></td>
    </tr>`).join('');
  });
}

let _editOpData = null;

async function abrirModalOperador(editId = null) {
  _editOpData = editId;
  const title = document.getElementById('modalOperadorTitle');
  const idInp = document.getElementById('opId');
  const resEl = document.getElementById('opResult');
  if (title) title.textContent = editId ? 'Editar Operador' : 'Nuevo Operador';
  if (idInp) idInp.value = editId || '';
  if (resEl) resEl.textContent = '';
  const opModal = document.getElementById('modalOperador');
  if (opModal) _clearFieldErrors(opModal);

  // Populate client select with current list
  _poblarSelectClientes(document.getElementById('opClienteCodigo'), null);

  if (!editId) {
    ['opNombre', 'opUsername'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('opDesk').value = 'ACCIONES';
  } else {
    // Pre-fill from data attributes stored on the row
    const row = document.querySelector(`#operadoresBody tr[data-op-id="${editId}"]`);
    if (row) {
      document.getElementById('opNombre').value = row.dataset.opNombre || '';
      document.getElementById('opDesk').value   = row.dataset.opDesk   || 'ACCIONES';
      const sel = document.getElementById('opClienteCodigo');
      if (sel) sel.value = row.dataset.opCliente || '';
    }
  }
  document.getElementById('modalOperador').classList.add('active');
}

function cerrarModalOperador(event) {
  if (!event || event.target === document.getElementById('modalOperador')) {
    document.getElementById('modalOperador').classList.remove('active');
  }
}

async function guardarOperador(btn) {
  const editId        = document.getElementById('opId').value;
  const nombre        = document.getElementById('opNombre').value.trim();
  const username      = document.getElementById('opUsername').value.trim();
  const desk          = document.getElementById('opDesk').value;
  const clienteCodigo = document.getElementById('opClienteCodigo')?.value || null;
  const resEl         = document.getElementById('opResult');
  const modal         = document.getElementById('modalOperador');
  if (modal) _clearFieldErrors(modal);
  if (resEl) resEl.textContent = '';

  let hasError = false;
  if (!nombre) { _setFieldError('opNombre', 'El nombre es requerido.'); hasError = true; }
  if (!editId && !username) { _setFieldError('opUsername', 'El username es requerido.'); hasError = true; }
  if (hasError) return;

  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    let res;
    if (editId) {
      res = await apiFetch(`/api/operadores/${editId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, desk, cliente_codigo: clienteCodigo || null }),
      });
    } else {
      res = await apiFetch('/api/operadores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, username, desk, cliente_codigo: clienteCodigo || null }),
      });
    }
    if (res.ok) {
      document.getElementById('modalOperador').classList.remove('active');
      cargarOperadores();
      showToast(editId ? 'Operador actualizado.' : 'Operador creado.', 'ok');
    } else {
      const err = await res.json().catch(() => ({}));
      if (resEl) resEl.innerHTML = `<span style="color:var(--red)">${esc(err.detail || 'Error al guardar.')}</span>`;
    }
  } catch(e) {
    if (resEl) resEl.innerHTML = `<span style="color:var(--red)">${esc(e.message || 'Error de conexión.')}</span>`;
  } finally {
    if (btn) { btn.disabled = false; if (origText) btn.textContent = origText; }
  }
}


