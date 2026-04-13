// ═══════════════════════════════════════════════════════════════════════════
// ── INSTRUMENTOS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

let _instCurrentId = null;

function parseFloatOrNull(s) {
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

async function cargarInstrumentos() {
  await _cargarTabla('instrumentosBody', 7, async (tbody) => {
    const tipo        = document.getElementById('instTipoFiltro')?.value || '';
    const soloActivos = document.getElementById('instSoloActivos')?.checked !== false;
    let url = '/api/instrumentos?';
    if (tipo) url += `tipo=${encodeURIComponent(tipo)}&`;
    url += `solo_activos=${soloActivos}`;
    const res   = await apiFetch(url);
    const data  = await res.json();
    const items = data.instrumentos || [];
    if (!items.length) {
      tbody.innerHTML = _emptyTableRow(7, 'Sin instrumentos');
      return;
    }
    _instrumentoDataMap = _buildDataMap(items);
    const tipoColor = { ACCION:'var(--green)', RENTA_FIJA:'#4a9eff', FUTURO:'#f0a500', CAUCION:'var(--text2)', CPD:'var(--text2)', FX:'#00d4aa', OTRO:'var(--text3)' };
    tbody.innerHTML = items.map(i => `
      <tr>
        <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(i.especie)}</span></td>
        <td><span style="font-size:10px;font-weight:600;color:${tipoColor[i.tipo]||'var(--text2)'}">${esc(i.tipo)}</span></td>
        <td style="font-size:11px">${esc(i.moneda)}</td>
        <td style="font-size:11px;color:var(--text3)">${esc(i.mercado_principal||'—')}</td>
        <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.descripcion||'')}">${esc(i.descripcion||'—')}</td>
        <td>
          <label class="toggle-switch">
            <input type="checkbox" ${i.activo ? 'checked' : ''} onchange="toggleInstrumentoActivo(${i.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td><button class="btn-mini" onclick="abrirModalInstrumento(${i.id})">Editar</button></td>
      </tr>
    `).join('');
  });
}

function instActualizarSubtabs() {
  const tipo    = document.getElementById('inst-tipo')?.value;
  const showRf  = tipo === 'RENTA_FIJA';
  const showFut = tipo === 'FUTURO';
  const rfBtn   = document.getElementById('instSubTab-rf');
  const futBtn  = document.getElementById('instSubTab-futuro');
  const mrgBtn  = document.getElementById('instSubTab-margen');
  if (rfBtn)  rfBtn.style.display  = showRf  ? '' : 'none';
  if (futBtn) futBtn.style.display = showFut ? '' : 'none';
  if (mrgBtn) mrgBtn.style.display = showFut ? '' : 'none';
}

function switchInstTab(tab) {
  _switchTab(tab, ['base','rf','futuro','margen'], 'instSubTab-', 'instTab-',
    t => { if (t === 'margen' && _instCurrentId) cargarLlamados(_instCurrentId); });
}

function abrirModalInstrumento(inst = null) {
  if (typeof inst === 'number' || (typeof inst === 'string' && inst !== '')) {
    inst = _instrumentoDataMap[+inst] || null;
  }
  _instCurrentId = inst ? inst.id : null;
  document.getElementById('instResult').textContent = '';
  document.getElementById('rfResult').textContent   = '';
  document.getElementById('futResult').textContent  = '';

  if (inst && typeof inst === 'object') {
    document.getElementById('modalInstTitulo').textContent = 'Editar Instrumento';
    document.getElementById('inst-id').value          = inst.id;
    document.getElementById('inst-especie').value     = inst.especie;
    document.getElementById('inst-especie').disabled  = true;
    document.getElementById('inst-tipo').value        = inst.tipo;
    document.getElementById('inst-moneda').value      = inst.moneda || 'ARP';
    document.getElementById('inst-mercado').value     = inst.mercado_principal || '';
    document.getElementById('inst-descripcion').value = inst.descripcion || '';
    if (inst.renta_fija) {
      const rf = inst.renta_fija;
      document.getElementById('rf-tir').value            = rf.tir_referencia  ?? '';
      document.getElementById('rf-duration').value       = rf.duration        ?? '';
      document.getElementById('rf-vencimiento').value    = rf.fecha_vencimiento || '';
      document.getElementById('rf-precio-sucio').value   = rf.precio_sucio    ?? '';
      document.getElementById('rf-precio-limpio').value  = rf.precio_limpio   ?? '';
      document.getElementById('rf-cupon').value          = rf.tasa_cupon      ?? '';
      document.getElementById('rf-frecuencia').value     = rf.frecuencia_cupon || '';
      document.getElementById('rf-moneda-emision').value = rf.moneda_emision  || '';
      document.getElementById('rf-emisor').value         = rf.emisor          || '';
      document.getElementById('rf-amortiza').checked     = !!rf.amortiza;
    }
    if (inst.futuro) {
      const f = inst.futuro;
      document.getElementById('fut-contrato').value       = f.contrato          || '';
      document.getElementById('fut-subyacente').value     = f.activo_subyacente || '';
      document.getElementById('fut-vencimiento').value    = f.mes_vencimiento   || '';
      document.getElementById('fut-precio-ajuste').value  = f.precio_ajuste     ?? '';
      document.getElementById('fut-margen-inicial').value = f.margen_inicial    ?? '';
      document.getElementById('fut-margen-var').value     = f.margen_variacion  ?? '';
      document.getElementById('fut-tick').value           = f.tick_size         ?? '';
      document.getElementById('fut-multiplicador').value  = f.multiplicador     ?? 1;
    }
  } else {
    document.getElementById('modalInstTitulo').textContent = 'Nuevo Instrumento';
    document.getElementById('inst-id').value          = '';
    document.getElementById('inst-especie').value     = '';
    document.getElementById('inst-especie').disabled  = false;
    document.getElementById('inst-tipo').value        = 'ACCION';
    document.getElementById('inst-moneda').value      = 'ARP';
    document.getElementById('inst-mercado').value     = '';
    document.getElementById('inst-descripcion').value = '';
  }
  instActualizarSubtabs();
  switchInstTab('base');
  document.getElementById('modalInstrumento').classList.add('active');
}

async function guardarInstrumento() {
  const resEl   = document.getElementById('instResult');
  resEl.textContent = '';
  const id      = document.getElementById('inst-id').value;
  const especie = document.getElementById('inst-especie').value.trim().toUpperCase();
  const tipo    = document.getElementById('inst-tipo').value;
  const moneda  = document.getElementById('inst-moneda').value;
  const mercado = document.getElementById('inst-mercado').value.trim() || null;
  const desc    = document.getElementById('inst-descripcion').value.trim() || null;
  if (!especie) { _showResultErr(resEl, 'La especie es requerida.'); return; }
  const btn = document.getElementById('instGuardarBtn');

  await _withButtonLoading(btn, async () => {
    try {
      let res;
      if (id) {
        res = await _apiFetchJson(`/api/instrumentos/${id}`, 'PATCH',
          { descripcion: desc, mercado_principal: mercado });
      } else {
        res = await _apiFetchJson('/api/instrumentos', 'POST',
          { especie, tipo, moneda, mercado_principal: mercado, descripcion: desc });
      }
      if (!res.ok) {
        const err = await res.json();
        _showResultErr(resEl, err.detail || 'Error al guardar');
        return;
      }
      const saved = await res.json();
      _instCurrentId = saved.id;
      document.getElementById('inst-id').value         = saved.id;
      document.getElementById('inst-especie').disabled = true;
      _showResultOk(resEl, `Guardado. ID: ${saved.id}`);
      await cargarInstrumentos();
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

async function toggleInstrumentoActivo(id, activo) {
  return _togglePatch(`/api/instrumentos/${id}`, { activo }, cargarInstrumentos);
}

async function guardarDetalleRentaFija(btn) {
  const resEl = document.getElementById('rfResult');
  resEl.textContent = '';
  if (!_instCurrentId) { _showResultErr(resEl, 'Guardá primero el instrumento.'); return; }
  const body = {
    tir_referencia:    parseFloatOrNull(document.getElementById('rf-tir').value),
    duration:          parseFloatOrNull(document.getElementById('rf-duration').value),
    fecha_vencimiento: document.getElementById('rf-vencimiento').value || null,
    precio_sucio:      parseFloatOrNull(document.getElementById('rf-precio-sucio').value),
    precio_limpio:     parseFloatOrNull(document.getElementById('rf-precio-limpio').value),
    tasa_cupon:        parseFloatOrNull(document.getElementById('rf-cupon').value),
    frecuencia_cupon:  document.getElementById('rf-frecuencia').value || null,
    moneda_emision:    document.getElementById('rf-moneda-emision').value.trim() || null,
    emisor:            document.getElementById('rf-emisor').value.trim() || null,
    amortiza:          document.getElementById('rf-amortiza').checked,
  };
  await _withButtonLoading(btn, async () => {
    try {
      const res = await _apiFetchJson(`/api/instrumentos/${_instCurrentId}/renta-fija`, 'PUT', body);
      if (!res.ok) { const e = await res.json(); _showResultErr(resEl, e.detail || 'Error'); return; }
      _showResultOk(resEl, 'Detalle RF guardado.');
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

async function guardarDetalleFuturo(btn) {
  const resEl = document.getElementById('futResult');
  resEl.textContent = '';
  if (!_instCurrentId) { _showResultErr(resEl, 'Guardá primero el instrumento.'); return; }
  const body = {
    contrato:          document.getElementById('fut-contrato').value.trim() || null,
    activo_subyacente: document.getElementById('fut-subyacente').value.trim() || null,
    mes_vencimiento:   document.getElementById('fut-vencimiento').value || null,
    precio_ajuste:     parseFloatOrNull(document.getElementById('fut-precio-ajuste').value),
    margen_inicial:    parseFloatOrNull(document.getElementById('fut-margen-inicial').value),
    margen_variacion:  parseFloatOrNull(document.getElementById('fut-margen-var').value),
    tick_size:         parseFloatOrNull(document.getElementById('fut-tick').value),
    multiplicador:     parseFloat(document.getElementById('fut-multiplicador').value) || 1.0,
  };
  await _withButtonLoading(btn, async () => {
    try {
      const res = await _apiFetchJson(`/api/instrumentos/${_instCurrentId}/futuro`, 'PUT', body);
      if (!res.ok) { const e = await res.json(); _showResultErr(resEl, e.detail || 'Error'); return; }
      _showResultOk(resEl, 'Detalle Futuro guardado.');
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

// ── Llamados a Margen ────────────────────────────────────────────────────────

async function cargarLlamados(instId) {
  await _cargarTabla('llamadosBody', 5, async (tbody) => {
    const res   = await apiFetch(`/api/instrumentos/${instId}/llamados-margen`);
    const data  = await res.json();
    const items = data.llamados_margen || [];
    if (!items.length) { tbody.innerHTML = _emptyTableRow(5, 'Sin llamados.'); return; }
    const estadoColor = { PENDIENTE:'#f0a500', INTEGRADO:'var(--green)', VENCIDO:'var(--red)' };
    tbody.innerHTML = items.map(ll => `
      <tr>
        <td style="font-size:11px">${esc(ll.fecha)}</td>
        <td style="font-size:11px">${esc(ll.cuenta_id)}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">$${fmt(ll.monto)}</td>
        <td><span style="font-size:10px;font-weight:600;color:${estadoColor[ll.estado]||'var(--text2)'}">${esc(ll.estado)}</span></td>
        <td>${ll.estado==='PENDIENTE'?`<button class="btn-mini" onclick="integrarLlamado(${ll.id})">Integrar</button>`:''}</td>
      </tr>
    `).join('');
  });
}

function abrirModalLlamado() {
  if (!_instCurrentId) { showToast('Guardá primero el instrumento.', 'warn'); return; }
  document.getElementById('llamadoInstEspecie').textContent = document.getElementById('inst-especie').value || '—';
  document.getElementById('lm-fecha').value       = new Date().toISOString().slice(0,10);
  document.getElementById('lm-cuenta').value      = '';
  document.getElementById('lm-monto').value       = '';
  document.getElementById('lm-descripcion').value = '';
  document.getElementById('llamadoResult').textContent = '';
  _clearFieldErrors(document.getElementById('modalLlamado'));
  document.getElementById('modalLlamado').classList.add('active');
}

async function guardarLlamado(btn) {
  const resEl    = document.getElementById('llamadoResult');
  const modal    = document.getElementById('modalLlamado');
  _clearFieldErrors(modal);
  resEl.textContent = '';
  const cuentaId = parseInt(document.getElementById('lm-cuenta').value);
  const monto    = parseFloat(document.getElementById('lm-monto').value);
  const fecha    = document.getElementById('lm-fecha').value;
  const desc     = document.getElementById('lm-descripcion').value.trim() || null;
  let hasError = false;
  if (!fecha)         { _setFieldError('lm-fecha',  'La fecha es requerida.'); hasError = true; }
  if (!(cuentaId > 0)){ _setFieldError('lm-cuenta', 'Seleccioná una cuenta.'); hasError = true; }
  if (!(monto > 0))   { _setFieldError('lm-monto',  'Ingresá un monto válido.'); hasError = true; }
  if (hasError) return;
  await _withButtonLoading(btn, async () => {
    try {
      const res = await _apiFetchJson(`/api/instrumentos/${_instCurrentId}/llamados-margen`, 'POST',
        { cuenta_id: cuentaId, fecha, monto, descripcion: desc });
      if (!res.ok) { const e = await res.json(); _showResultErr(resEl, e.detail || 'Error'); return; }
      document.getElementById('modalLlamado').classList.remove('active');
      await cargarLlamados(_instCurrentId);
    } catch(e) { _showResultErr(resEl, e.message); }
  });
}

async function integrarLlamado(llamadoId) {
  try {
    const res = await apiFetch(`/api/instrumentos/llamados-margen/${llamadoId}/integrar`, { method: 'POST' });
    if (!res.ok) { const e=await res.json(); showToast(e.detail||'Error al integrar','error'); return; }
    showToast('Llamado integrado.','ok');
    if (_instCurrentId) await cargarLlamados(_instCurrentId);
  } catch(e) { showToast(e.message,'error'); }
}
