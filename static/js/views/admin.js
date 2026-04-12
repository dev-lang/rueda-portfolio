// ══════════════════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════════════════════════════════════

// ── Admin sub-tab switching ──────────────────────────────────────────────────
function switchAdminTab(tab) {
  // Cancel any in-flight API requests from the previous tab
  state.navController?.abort();
  state.navController = new AbortController();

  document.querySelectorAll('.admin-sidebar .admin-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.admin-tab-content').forEach(d => {
    d.classList.toggle('active', d.id === `admin-tab-${tab}`);
  });
  // Lazy load on first switch
  if (tab === 'usuarios')      cargarUsuarios();
  if (tab === 'clientes')      cargarClientesAdmin();
  if (tab === 'tickers')       cargarTickersAdmin();
  if (tab === 'bot')           cargarBots();
  if (tab === 'sistema')       cargarConfigSistema();
  if (tab === 'instrumentos')  cargarInstrumentos();
  if (tab === 'tc')            cargarTcActual();
  if (tab === 'reportes')      inicializarFechasReportes();
  if (tab === 'contrapartes')  cargarContrapartes();
  if (tab === 'riesgo')        cargarLimites();
  if (tab === 'liquidaciones') cargarLiquidaciones();
  if (tab === 'operadores')    cargarOperadores();
  if (tab === 'val-precios')  { const hoy = new Date().toISOString().slice(0,10); const el = document.getElementById('vpFecha'); if (el && !el.value) el.value = hoy; }
  if (tab === 'pnl') {
    const hoy = new Date().toISOString().slice(0,10);
    const d = document.getElementById('pnlFechaDesde'); if (d && !d.value) d.value = hoy;
    const h = document.getElementById('pnlFechaHasta'); if (h && !h.value) h.value = hoy;
    const desk = document.getElementById('pnlDeskFecha'); if (desk && !desk.value) desk.value = hoy;
  }
  if (tab === 'firma')         cargarFirma();
  if (tab === 'cuentas-op')    cargarCuentasOperadores();
  if (tab === 'auditoria')       cargarAuditoria();
  if (tab === 'alertas-usuario') cargarAlertas();
}

// ── Firma ─────────────────────────────────────────────────────────────────────

let _firmaMovPag = 1;

async function cargarFirma(page = 1) {
  _firmaMovPag = page;
  const moneda = document.getElementById('firmaMoneda')?.value || 'ARP';

  // KPIs
  try {
    const res  = await apiFetch('/api/firma/saldo');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saldo = await res.json();
    const kpiEl = document.getElementById('firma-kpis');
    if (kpiEl) {
      const bloque = (saldo.saldo || []).find(b => b.moneda === moneda);
      const total     = bloque?.balance_total     ?? 0;
      const disp      = bloque?.balance_disponible ?? 0;
      const cap       = bloque?.cuentas?.[0]?.capital_inicial ?? 0;
      const pnl       = total - cap;
      const fmt = v => v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const colorPnl  = pnl >= 0 ? 'var(--buy,#4caf50)' : 'var(--sell,#e05c5c)';
      kpiEl.innerHTML = `
        <div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:12px">
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px">SALDO TOTAL ${moneda}</div>
          <div style="font-size:18px;font-weight:700">${fmt(total)}</div>
        </div>
        <div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:12px">
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px">DISPONIBLE</div>
          <div style="font-size:18px;font-weight:700">${fmt(disp)}</div>
        </div>
        <div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:12px">
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px">CAPITAL INICIAL</div>
          <div style="font-size:18px;font-weight:700">${fmt(cap)}</div>
        </div>
        <div style="background:var(--bg4);border:1px solid var(--border);border-radius:4px;padding:12px">
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px">P&L IMPL.</div>
          <div style="font-size:18px;font-weight:700;color:${colorPnl}">${pnl >= 0 ? '+' : ''}${fmt(pnl)}</div>
        </div>`;
    }
  } catch(e) { /* KPI rendering failed — firma still shows */ }

  // Movimientos
  const tbody = document.getElementById('firmaMovBody');
  if (tbody) _setTbodyLoading(tbody, 7);
  try {
    const res = await apiFetch(`/api/firma/movimientos?page=${page}&per_page=${MOV_PER_PAGE}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!tbody) return;
    if (!data.entries?.length) {
      tbody.innerHTML = _emptyTableRow(7, 'Sin movimientos.');
    } else {
      tbody.innerHTML = data.entries.map(e => {
        const color = e.sentido === 'CREDIT' ? 'var(--buy,#4caf50)' : 'var(--sell,#e05c5c)';
        const sign  = e.sentido === 'CREDIT' ? '+' : '−';
        const monto = parseFloat(e.monto || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
        const bal   = parseFloat(e.balance_post || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
        const fecha = _fmtDatetime(e.created_at);
        return `<tr>
          <td style="font-size:10px">${fecha}</td>
          <td><span class="badge">${e.tipo}</span></td>
          <td style="color:${color};font-weight:700">${e.sentido}</td>
          <td style="text-align:right;color:${color}">${sign}${monto}</td>
          <td style="text-align:right">${bal}</td>
          <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.descripcion||''}">${e.descripcion || '—'}</td>
          <td style="font-size:10px">${e.usuario || '—'}</td>
        </tr>`;
      }).join('');
    }
    // Pagination
    const pagEl = document.getElementById('firmaPagBar');
    if (pagEl) {
      const pages = data.pages || 1;
      pagEl.innerHTML = pages > 1
        ? Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<button data-action="cargar-firma" data-page="${p}" style="margin:0 2px;padding:2px 7px;${p===page?'font-weight:700;text-decoration:underline':''}">${p}</button>`
          ).join('')
        : '';
    }
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-muted">Error al cargar: ${esc(e.message)}</td></tr>`;
  }

  // Posiciones
  cargarPosicionesFirma();
}

async function cargarPosicionesFirma() {
  await _cargarTabla('firmaPosBody', 7, async (tbody) => {
    const res = await apiFetch('/api/firma/posiciones');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.posiciones?.length) { tbody.innerHTML = _emptyTableRow(7, 'Sin posiciones.'); return; }
    const fmtP4 = v => v == null ? '—' : parseFloat(v).toLocaleString('es-AR', { minimumFractionDigits: 4 });
    tbody.innerHTML = data.posiciones.map(p => `<tr>
      <td><strong>${p.especie}</strong></td>
      <td>${p.mercado || '—'}</td>
      <td style="text-align:right">${(p.cantidad_comprada||0).toLocaleString('es-AR')}</td>
      <td style="text-align:right">${(p.cantidad_vendida||0).toLocaleString('es-AR')}</td>
      <td style="text-align:right;font-weight:700;color:${(p.cantidad_neta||0)>=0?'var(--buy,#4caf50)':'var(--sell,#e05c5c)'}">${(p.cantidad_neta||0).toLocaleString('es-AR')}</td>
      <td style="text-align:right">${fmtP4(p.costo_promedio_compra)}</td>
      <td style="text-align:right">${(p.cantidad_pendiente_liquidacion||0).toLocaleString('es-AR')}</td>
    </tr>`).join('');
  });
}

// ── Cuentas Operadores ────────────────────────────────────────────────────────

let _opMovActual = null;  // operador id cuya detail está visible

async function cargarCuentasOperadores() {
  await _cargarTabla('cuentasOpBody', 6, async (tbody) => {
    const res = await apiFetch('/api/cuentas/operadores');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.operadores?.length) { tbody.innerHTML = _emptyTableRow(6, 'No hay operadores registrados.'); return; }
    tbody.innerHTML = data.operadores.map(row => {
      const op      = row.operador;
      const cuenta  = row.cuenta;
      const saldo   = cuenta ? fmt(cuenta.balance_cache) : '—';
      const disp    = cuenta ? fmt((cuenta.balance_cache||0) - (cuenta.balance_reservado||0)) : '—';
      const saldoColor = cuenta && parseFloat(cuenta.balance_cache) < 0 ? 'color:var(--sell,#e05c5c)' : '';
      return `<tr>
        <td><strong>${op.nombre}</strong></td>
        <td style="font-size:10px">${op.username}</td>
        <td><span class="badge">${op.desk}</span></td>
        <td style="text-align:right;${saldoColor}">${saldo}</td>
        <td style="text-align:right">${disp}</td>
        <td>
          <button class="btn-refresh" style="padding:2px 7px;font-size:10px;margin-right:3px" data-action="abrir-modal-cuenta-dep" data-id="${op.id}" data-nombre="${esc(op.nombre)}" title="Depositar">+ Dep.</button>
          <button class="btn-refresh" style="padding:2px 7px;font-size:10px;margin-right:3px;background:var(--sell,#e05c5c);border-color:var(--sell,#e05c5c)" data-action="abrir-modal-cuenta-ret" data-id="${op.id}" data-nombre="${esc(op.nombre)}" title="Retirar">− Ret.</button>
          <button class="btn-refresh" style="padding:2px 7px;font-size:10px" data-action="ver-movimientos-op" data-id="${op.id}" data-nombre="${esc(op.nombre)}" title="Ver movimientos">Movim.</button>
        </td>
      </tr>`;
    }).join('');
  });
}

async function verMovimientosOp(opId, nombre, page = 1) {
  _opMovActual = opId;
  const panel = document.getElementById('opMovPanel');
  const title = document.getElementById('opMovTitle');
  const tbody = document.getElementById('opMovBody');
  if (!panel || !tbody) return;
  panel.style.display = '';
  if (title) title.textContent = `Movimientos — ${nombre}`;
  _setTbodyLoading(tbody, 7);
  try {
    const data = await apiFetch(`/api/cuentas/operadores/${opId}/movimientos?page=${page}&per_page=${MOV_PER_PAGE}`).then(r => r.json());
    if (!data.entries?.length) {
      tbody.innerHTML = _emptyTableRow(7, 'Sin movimientos.');
    } else {
      tbody.innerHTML = data.entries.map(e => {
        const color = e.sentido === 'CREDIT' ? 'var(--buy,#4caf50)' : 'var(--sell,#e05c5c)';
        const sign  = e.sentido === 'CREDIT' ? '+' : '−';
        const monto = parseFloat(e.monto || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
        const bal   = parseFloat(e.balance_post || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
        const fecha = _fmtDatetime(e.created_at);
        return `<tr>
          <td style="font-size:10px">${fecha}</td>
          <td><span class="badge">${e.tipo}</span></td>
          <td style="color:${color};font-weight:700">${e.sentido}</td>
          <td style="text-align:right;color:${color}">${sign}${monto}</td>
          <td style="text-align:right">${bal}</td>
          <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.descripcion||''}">${e.descripcion || '—'}</td>
          <td style="font-size:10px">${e.usuario || '—'}</td>
        </tr>`;
      }).join('');
    }
    const pagEl = document.getElementById('opMovPagBar');
    if (pagEl) {
      const pages = data.pages || 1;
      pagEl.innerHTML = pages > 1
        ? Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<button data-action="ver-movimientos-op" data-id="${opId}" data-nombre="${esc(nombre)}" data-page="${p}" style="margin:0 2px;padding:2px 7px;${p===page?'font-weight:700;text-decoration:underline':''}">${p}</button>`
          ).join('')
        : '';
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted">Error al cargar movimientos.</td></tr>`;
  }
}

function recargarMovOp() {
  if (_opMovActual) {
    const title = document.getElementById('opMovTitle')?.textContent || '';
    const nombre = title.replace('Movimientos — ', '');
    verMovimientosOp(_opMovActual, nombre);
  }
}

// ── Auditoría ─────────────────────────────────────────────────────────────────

// ── ALERTAS USUARIO ─────────────────────────────────────────────────────────
async function cargarAlertas() {
  const tbody = document.getElementById('alertasBody');
  if (!tbody) return;
  _showSkeleton('alertasBody', 8, 4);
  try {
    const res = await apiFetch('/api/alertas');
    if (!res.ok) { tbody.innerHTML = _emptyTableRow(8, 'Error cargando alertas.'); return; }
    const rows = await res.json();
    if (!rows.length) {
      tbody.innerHTML = _emptyTableRow(8, 'Sin alertas configuradas.');
      return;
    }
    const LABEL = { ORDEN_MONTO: 'Orden Monto', POSICION_CAIDA: 'Pos. Caída P&L', POSICION_SUBE: 'Pos. Suba P&L', VOLUMEN_CLIENTE: 'Vol. Cliente' };
    tbody.innerHTML = rows.map(a => `
      <tr>
        <td style="font-size:11px;font-weight:600">${esc(LABEL[a.tipo] || a.tipo)}</td>
        <td class="precio-cell">${fmt(a.umbral)}</td>
        <td class="precio-cell">${esc(a.moneda)}</td>
        <td>${a.cliente ? esc(a.cliente) : '<span style="color:var(--text3)">Todos</span>'}</td>
        <td>${_badgeEspecie(a.especie)}</td>
        <td>
          <label class="toggle-switch" title="${a.activo ? 'Activa — click para pausar' : 'Pausada — click para activar'}">
            <input type="checkbox" ${a.activo ? 'checked' : ''} onchange="toggleAlerta(${a.id}, this)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td style="font-size:10px;color:var(--text3)">${_fmtDatetime(a.ultima_vez)}</td>
        <td>
          <button class="btn-danger" style="font-size:10px;padding:2px 8px" data-action="eliminar-alerta" data-id="${a.id}" aria-label="Eliminar alerta">✕</button>
        </td>
      </tr>`).join('');
  } catch { tbody.innerHTML = _emptyTableRow(8, 'Error de red.'); }
}

async function guardarAlerta() {
  const msg = document.getElementById('alertaFormMsg');
  const payload = {
    tipo:    document.getElementById('alerta-tipo').value,
    umbral:  document.getElementById('alerta-umbral').value,
    moneda:  document.getElementById('alerta-moneda').value,
    cliente: document.getElementById('alerta-cliente').value.trim(),
    especie: document.getElementById('alerta-especie').value.trim().toUpperCase(),
  };
  if (!payload.umbral || Number(payload.umbral) <= 0) {
    if (msg) { msg.textContent = 'El umbral debe ser > 0.'; msg.style.color = 'var(--red)'; }
    return;
  }
  try {
    const res = await _apiFetchJson('/api/alertas', 'POST', payload);
    if (!res.ok) {
      const err = await res.json();
      if (msg) { msg.textContent = err.detail || 'Error al crear alerta.'; msg.style.color = 'var(--red)'; }
      return;
    }
    if (msg) { msg.textContent = 'Alerta creada correctamente.'; msg.style.color = 'var(--green)'; setTimeout(() => { msg.textContent = ''; }, 3000); }
    document.getElementById('alerta-umbral').value = '';
    document.getElementById('alerta-cliente').value = '';
    document.getElementById('alerta-especie').value = '';
    cargarAlertas();
  } catch { if (msg) { msg.textContent = 'Error de red.'; msg.style.color = 'var(--red)'; } }
}

async function toggleAlerta(id, checkbox) {
  const estadoPrevio = checkbox ? !checkbox.checked : null;
  try {
    await apiFetch(`/api/alertas/${id}/toggle`, { method: 'PATCH' });
    cargarAlertas();
  } catch(e) {
    if (checkbox && estadoPrevio !== null) checkbox.checked = estadoPrevio;
    showToast('No se pudo cambiar el estado de la alerta.', 'error');
  }
}

async function eliminarAlerta(id) {
  _confirmar(
    'Eliminar Alerta',
    '¿Eliminar esta alerta? Esta acción no se puede deshacer.',
    async () => {
      try {
        await apiFetch(`/api/alertas/${id}`, { method: 'DELETE' });
        showToast('Alerta eliminada.', 'ok');
        cargarAlertas();
      } catch(e) {
        showToast('No se pudo eliminar la alerta.', 'error');
      }
    }
  );
}

let _auditPage = 1;
let _auditTotalPages = 1;

function resetAuditPage() { _auditPage = 1; cargarAuditoria(); }

async function cargarAuditoria() {
  const tbody = document.getElementById('auditBody');
  if (!tbody) return;
  _setTbodyLoading(tbody, 5);
  const tabla    = document.getElementById('auditTablaFiltro')?.value.trim() || '';
  const op       = document.getElementById('auditOpFiltro')?.value || '';
  const perPage  = document.getElementById('auditPerPage')?.value || '50';
  const params   = new URLSearchParams();
  if (tabla) params.set('tabla', tabla);
  if (op)    params.set('operacion', op);
  params.set('page', _auditPage);
  params.set('per_page', perPage);
  try {
    const res = await apiFetch(`/api/audit?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _auditTotalPages = data.pages || 1;
    _auditPage       = data.current_page || 1;

    const totalEl = document.getElementById('auditTotal');
    if (totalEl) {
      totalEl.textContent = _calcularPaginacion(_auditPage, parseInt(perPage), data.total, 'registros').text;
    }

    renderAuditPagBar(data.current_page, data.pages);

    if (!data.logs.length) {
      tbody.innerHTML = _emptyTableRow(5, 'Sin registros para los filtros seleccionados.');
      return;
    }
    const opColor = { CREATE: 'var(--buy,#4caf50)', UPDATE: 'var(--text2)', CANCEL: 'var(--sell,#e05c5c)', EXECUTE: 'var(--accent)' };
    tbody.innerHTML = data.logs.map(r => {
      const color = opColor[r.operacion] || 'var(--text2)';
      return `<tr>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${r.timestamp || '—'}</td>
        <td>${esc(r.tabla)}</td>
        <td style="font-weight:600;color:${color}">${esc(r.operacion)}</td>
        <td style="font-family:'IBM Plex Mono',monospace">${r.record_id}</td>
        <td>${esc(r.usuario || '—')}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-muted">Error: ${esc(e.message)}</td></tr>`;
  }
}

function renderAuditPagBar(page, pages) {
  const bar = document.getElementById('auditPagBar');
  if (!bar || pages <= 1) { if (bar) bar.innerHTML = ''; return; }
  let btns = `<button class="page-btn" data-action="go-audit-page" data-page="${page-1}" ${page<=1?'disabled':''}>‹ Ant.</button>`;
  const start = Math.max(1, page - 2);
  const end   = Math.min(pages, page + 2);
  if (start > 1) btns += `<button class="page-btn" data-action="go-audit-page" data-page="1">1</button>${start > 2 ? '<span style="padding:0 4px">…</span>' : ''}`;
  for (let p = start; p <= end; p++) {
    btns += `<button class="page-btn ${p === page ? 'active' : ''}" data-action="go-audit-page" data-page="${p}">${p}</button>`;
  }
  if (end < pages) btns += `${end < pages - 1 ? '<span style="padding:0 4px">…</span>' : ''}<button class="page-btn" data-action="go-audit-page" data-page="${pages}">${pages}</button>`;
  btns += `<button class="page-btn" data-action="go-audit-page" data-page="${page+1}" ${page>=pages?'disabled':''}>Sig. ›</button>`;
  bar.innerHTML = btns;
}

function goAuditPage(p) {
  if (p < 1 || p > _auditTotalPages) return;
  _auditPage = p;
  cargarAuditoria();
}

// ── Modal depositar / retirar (firma y operadores) ────────────────────────────

function abrirModalCuenta(contexto, sentido, opId = null, opNombre = '') {
  document.getElementById('mcContexto').value = contexto;
  document.getElementById('mcSentido').value  = sentido;
  document.getElementById('mcOpId').value     = opId || '';
  document.getElementById('mcMonto').value    = '';
  document.getElementById('mcDescripcion').value = '';
  document.getElementById('mcResult').textContent = '';
  _clearFieldErrors(document.getElementById('modalCuenta'));

  const esDebit = sentido === 'DEBIT';
  const btn = document.getElementById('mcBtnConfirmar');
  if (btn) {
    btn.textContent = esDebit ? 'Confirmar Retiro' : 'Confirmar Depósito';
    btn.style.background = esDebit ? 'var(--sell,#e05c5c)' : '';
    btn.style.borderColor = esDebit ? 'var(--sell,#e05c5c)' : '';
  }

  const titulo = document.getElementById('modalCuentaTitulo');
  const subtit = document.getElementById('modalCuentaSubtitulo');
  if (contexto === 'firma') {
    if (titulo) titulo.textContent = esDebit ? 'Retirar de la Firma' : 'Depositar a la Firma';
    if (subtit) subtit.textContent = 'Cuenta corriente STD — Cartera Propia';
    // sync moneda with the tab selector
    const monFirma = document.getElementById('firmaMoneda')?.value || 'ARP';
    document.getElementById('mcMoneda').value = monFirma;
  } else {
    if (titulo) titulo.textContent = esDebit ? `Retirar de ${opNombre}` : `Depositar a ${opNombre}`;
    if (subtit) subtit.textContent = `Operador ID ${opId}`;
    document.getElementById('mcMoneda').value = 'ARP';
  }

  document.getElementById('modalCuenta').classList.add('active');
  setTimeout(() => document.getElementById('mcMonto')?.focus(), 80);
}

function cerrarModalCuenta(event) {
  if (event && event.target !== document.getElementById('modalCuenta')) return;
  document.getElementById('modalCuenta').classList.remove('active');
}

async function confirmarModalCuenta() {
  const contexto = document.getElementById('mcContexto').value;
  const sentido  = document.getElementById('mcSentido').value;
  const opId     = document.getElementById('mcOpId').value;
  const monto    = parseFloat(document.getElementById('mcMonto').value);
  const moneda   = document.getElementById('mcMoneda').value;
  const desc     = document.getElementById('mcDescripcion').value.trim();
  const resultEl = document.getElementById('mcResult');
  const modal    = document.getElementById('modalCuenta');

  // Limpiar errores previos antes de revalidar
  _clearFieldErrors(modal);
  resultEl.textContent = '';

  let hasError = false;
  if (!monto || monto <= 0) {
    _setFieldError('mcMonto', 'Ingresá un monto válido.');
    hasError = true;
  }
  if (desc.length < 5) {
    _setFieldError('mcDescripcion', 'Debe tener al menos 5 caracteres.');
    hasError = true;
  }
  if (hasError) return;

  const endpoint = contexto === 'firma'
    ? `/api/firma/${sentido === 'CREDIT' ? 'deposito' : 'retiro'}`
    : `/api/cuentas/operadores/${opId}/${sentido === 'CREDIT' ? 'deposito' : 'retiro'}`;

  const btn = document.getElementById('mcBtnConfirmar');
  if (btn) btn.disabled = true;
  resultEl.textContent = 'Procesando...';

  try {
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monto, moneda, descripcion: desc }),
    });
    const data = await res.json();
    if (!res.ok) {
      resultEl.textContent = `✗ ${data.detail || 'Error al procesar.'}`;
    } else {
      resultEl.textContent = '';
      document.getElementById('modalCuenta').classList.remove('active');
      // Refresh the relevant tab
      if (contexto === 'firma') {
        cargarFirma(_firmaMovPag);
      } else {
        cargarCuentasOperadores();
        if (_opMovActual == opId) recargarMovOp();
      }
    }
  } catch(e) {
    resultEl.textContent = '✗ Error de conexión.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function inicializarFechasReportes() {
  const hoy = new Date().toISOString().slice(0, 10);
  ['rptCnvFecha', 'rptBcraFecha', 'rptUifFecha'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = hoy;
  });
}

function filtrarPorEstado(color) {
  const sel = document.getElementById('filtroEstado');
  if (sel) sel.value = color;
  setView('ordenes');
  cargarOrdenes();
}

// ── Collapsible panels ────────────────────────────────────────────────────────
function initCollapsiblePanels() {
  document.querySelectorAll('.panel').forEach((panel, idx) => {
    const header = panel.querySelector(':scope > .panel-header');
    if (!header || header.querySelector('.panel-toggle-btn')) return;

    // Stable storage key: prefer panel's section id, else a positional index
    const storageKey = 'panel_collapsed_' + (panel.id || panel.closest('[id]')?.id || idx);

    // Inject toggle chevron at the right end of the header
    const btn = document.createElement('button');
    btn.className = 'panel-toggle-btn';
    btn.innerHTML = '&#9660;';  // ▼
    btn.title = 'Expandir / Contraer';
    btn.addEventListener('click', e => e.stopPropagation());
    header.appendChild(btn);

    // Restore saved state
    if (localStorage.getItem(storageKey) === 'true') {
      panel.classList.add('collapsed');
    }

    // Toggle on header click
    header.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      localStorage.setItem(storageKey, panel.classList.contains('collapsed'));
    });
  });
}

// ── USUARIOS ─────────────────────────────────────────────────────────────────
async function cargarUsuarios() {
  await _cargarTabla('usuariosBody', 8, async (tbody) => {
    const res  = await apiFetch('/api/users');
    const data = await res.json();
    if (!data.length) { tbody.innerHTML = _emptyTableRow(8, 'Sin usuarios'); return; }
    _usuarioDataMap = _buildDataMap(data);
    tbody.innerHTML = data.map(u => `
      <tr>
        <td>${esc(u.id)}</td>
        <td><strong>${esc(u.username)}</strong></td>
        <td>${esc(u.email || '—')}</td>
        <td><span class="badge-tipo" style="font-size:10px">${esc(u.role)}</span></td>
        <td>
          <label class="toggle-switch" title="${u.is_active ? 'Desactivar' : 'Activar'}">
            <input type="checkbox" ${u.is_active ? 'checked' : ''} onchange="toggleUsuarioActivo(${u.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td style="font-size:11px;color:var(--text3)">${esc(u.created_at || '—')}</td>
        <td style="font-size:11px;color:var(--text3)">${esc(u.last_login || '—')}</td>
        <td>
          <button class="btn-mini" data-action="abrir-modal-usuario" data-id="${u.id}">Editar</button>
        </td>
      </tr>
    `).join('');
  });
}

function abrirModalUsuario(usuario = null) {
  _pushModalFocus();
  if (typeof usuario === 'number' || (typeof usuario === 'string' && usuario !== '')) {
    usuario = _usuarioDataMap[+usuario] || null;
  }
  const modal = document.getElementById('modalUsuario');
  document.getElementById('usuarioResult').textContent = '';
  _clearFieldErrors(modal);
  if (usuario && typeof usuario === 'object') {
    document.getElementById('modalUsuarioTitulo').textContent = 'Editar Usuario';
    document.getElementById('u-id').value       = usuario.id;
    document.getElementById('u-username').value  = usuario.username;
    document.getElementById('u-email').value     = usuario.email || '';
    document.getElementById('u-rol').value       = usuario.role;
    document.getElementById('u-password').value  = '';
    document.getElementById('u-username').disabled = true;
    document.getElementById('u-pass-label').textContent = 'Nueva contraseña (vacío = no cambiar)';
  } else {
    document.getElementById('modalUsuarioTitulo').textContent = 'Nuevo Usuario';
    document.getElementById('u-id').value       = '';
    document.getElementById('u-username').value  = '';
    document.getElementById('u-email').value     = '';
    document.getElementById('u-rol').value       = 'OPERADOR';
    document.getElementById('u-password').value  = '';
    document.getElementById('u-username').disabled = false;
    document.getElementById('u-pass-label').textContent = 'Contraseña';
  }
  modal.classList.add('active');
  _watchModalDirty('modalUsuario');
}

function cerrarModalUsuario(e) {
  if (e.target === document.getElementById('modalUsuario')) {
    _checkModalDirty('modalUsuario', () => {
      document.getElementById('modalUsuario').classList.remove('active');
      _popModalFocus();
    });
  }
}

async function guardarUsuario(btn) {
  const resEl    = document.getElementById('usuarioResult');
  const modal    = document.getElementById('modalUsuario');
  _clearFieldErrors(modal);
  resEl.textContent = '';
  const id       = document.getElementById('u-id').value;
  const username = document.getElementById('u-username').value.trim();
  const email    = document.getElementById('u-email').value.trim();
  const role     = document.getElementById('u-rol').value;
  const password = document.getElementById('u-password').value;

  if (!id) {
    let hasError = false;
    if (!username) { _setFieldError('u-username', 'El username es requerido.'); hasError = true; }
    if (!password) { _setFieldError('u-password', 'La contraseña es requerida.'); hasError = true; }
    if (hasError) return;
  }

  await _withButtonLoading(btn, async () => {
    try {
      let res;
      if (id) {
        const body = { role, email: email || null };
        if (password) body.password = password;
        res = await _apiFetchJson(`/api/users/${id}`, 'PATCH', body);
      } else {
        res = await _apiFetchJson('/api/users', 'POST', { username, email: email || null, role, password });
      }
      if (!res.ok) {
        const err = await res.json();
        const detail = err.detail;
        _showResultErr(resEl, Array.isArray(detail)
          ? detail.map(d => d.msg || JSON.stringify(d)).join(' | ')
          : (detail || 'Error al guardar'));
        return;
      }
      document.getElementById('modalUsuario').classList.remove('active');
      await cargarUsuarios();
    } catch(e) {
      _showResultErr(resEl, e.message);
    }
  });
}

async function toggleUsuarioActivo(userId, activo) {
  return _togglePatch(`/api/users/${userId}`, { is_active: activo }, cargarUsuarios);
}

// ── CLIENTES ──────────────────────────────────────────────────────────────────
async function cargarClientesAdmin() {
  await _cargarTabla('clientesAdminBody', 7, async (tbody) => {
    const res  = await apiFetch('/api/clientes');
    const data = await res.json();
    if (!data.length) { tbody.innerHTML = _emptyTableRow(7, 'Sin clientes'); return; }
    _clienteDataMap = _buildDataMap(data, 'codigo');
    tbody.innerHTML = data.map(c => `
      <tr>
        <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(c.codigo)}</span></td>
        <td>${esc(c.nombre)}</td>
        <td>${esc(c.razon_social)}</td>
        <td style="text-align:center">${c.es_cartera_propia ? '<span style="color:var(--green);font-size:11px">&#10003; Propia</span>' : ''}</td>
        <td style="text-align:center">${c.es_pep ? '<span style="color:#f0a500;font-size:11px">PEP</span>' : ''}</td>
        <td>
          <label class="toggle-switch" title="${c.activo ? 'Desactivar' : 'Activar'}">
            <input type="checkbox" ${c.activo ? 'checked' : ''} onchange="toggleClienteActivo('${esc(c.codigo)}', this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td>
          <button class="btn-mini" data-action="abrir-modal-cliente" data-codigo="${esc(c.codigo)}">Editar</button>
        </td>
      </tr>
    `).join('');
  });
}

function abrirModalCliente(cliente = null) {
  _pushModalFocus();
  if (typeof cliente === 'string' && cliente !== '') {
    cliente = _clienteDataMap[cliente] || null;
  }
  const modal = document.getElementById('modalCliente');
  document.getElementById('clienteResult').textContent = '';
  _clearFieldErrors(modal);
  if (cliente && typeof cliente === 'object') {
    document.getElementById('modalClienteTitulo').textContent = 'Editar Cliente';
    document.getElementById('c-codigo-orig').value = cliente.codigo;
    document.getElementById('c-codigo').value       = cliente.codigo;
    document.getElementById('c-nombre').value       = cliente.nombre;
    document.getElementById('c-razon').value        = cliente.razon_social;
    document.getElementById('c-cartera-propia').checked = !!cliente.es_cartera_propia;
    document.getElementById('c-pep').checked        = !!cliente.es_pep;
    document.getElementById('c-codigo').disabled   = true;
  } else {
    document.getElementById('modalClienteTitulo').textContent = 'Nuevo Cliente';
    document.getElementById('c-codigo-orig').value = '';
    document.getElementById('c-codigo').value       = '';
    document.getElementById('c-nombre').value       = '';
    document.getElementById('c-razon').value        = '';
    document.getElementById('c-cartera-propia').checked = false;
    document.getElementById('c-pep').checked        = false;
    document.getElementById('c-codigo').disabled   = false;
  }
  modal.classList.add('active');
  _watchModalDirty('modalCliente');
}

function cerrarModalCliente(e) {
  if (e.target === document.getElementById('modalCliente')) {
    _checkModalDirty('modalCliente', () => {
      document.getElementById('modalCliente').classList.remove('active');
      _popModalFocus();
    });
  }
}

async function guardarCliente(btn) {
  const resEl      = document.getElementById('clienteResult');
  const modal      = document.getElementById('modalCliente');
  _clearFieldErrors(modal);
  resEl.textContent = '';
  const codigoOrig = document.getElementById('c-codigo-orig').value;
  const codigo     = document.getElementById('c-codigo').value.trim().toUpperCase();
  const nombre     = document.getElementById('c-nombre').value.trim();
  const razon      = document.getElementById('c-razon').value.trim();
  let hasError = false;
  if (!codigo) { _setFieldError('c-codigo', 'El código es requerido.'); hasError = true; }
  if (!nombre) { _setFieldError('c-nombre', 'El nombre es requerido.'); hasError = true; }
  if (!razon)  { _setFieldError('c-razon',  'La razón social es requerida.'); hasError = true; }
  if (hasError) return;

  await _withButtonLoading(btn, async () => {
    try {
      const esCarteraPropia = document.getElementById('c-cartera-propia').checked;
      const esPep           = document.getElementById('c-pep').checked;
      let res;
      if (codigoOrig) {
        res = await _apiFetchJson(`/api/clientes/${codigoOrig}`, 'PATCH',
          { nombre, razon_social: razon, es_cartera_propia: esCarteraPropia, es_pep: esPep });
      } else {
        res = await _apiFetchJson('/api/clientes', 'POST',
          { codigo, nombre, razon_social: razon, es_cartera_propia: esCarteraPropia, es_pep: esPep });
      }
      if (!res.ok) {
        const err = await res.json();
        _showResultErr(resEl, err.detail || 'Error al guardar');
        return;
      }
      document.getElementById('modalCliente').classList.remove('active');
      await cargarClientesAdmin();
    } catch(e) {
      _showResultErr(resEl, e.message);
    }
  });
}

async function toggleClienteActivo(codigo, activo) {
  return _togglePatch(`/api/clientes/${codigo}`, { activo }, cargarClientesAdmin);
}

// ── TICKERS ───────────────────────────────────────────────────────────────────
async function cargarTickersAdmin() {
  await _cargarTabla('tickersAdminBody', 6, async (tbody) => {
    const panel = document.getElementById('tickerPanelFiltro')?.value || '';
    const res  = await apiFetch('/api/admin/tickers');
    let data   = await res.json();
    if (panel) data = data.filter(t => t.panel === panel);
    if (!data.length) { tbody.innerHTML = _emptyTableRow(6, 'Sin tickers'); return; }
    _tickerDataMap = _buildDataMap(data, 'especie');
    const fmtN = v => v != null ? v.toLocaleString('es-AR') : '—';
    tbody.innerHTML = data.map(t => `
      <tr>
        <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(t.especie)}</span></td>
        <td style="font-size:11px">${esc(t.nombre || '—')}</td>
        <td><span class="badge-tipo" style="font-size:10px;opacity:0.8">${esc(t.panel)}</span></td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text3)">${esc(t.yf_symbol || '—')}</td>
        <td style="text-align:right;font-size:11px;color:${t.volumen_max_dia ? 'var(--accent)' : 'var(--text3)'}">${t.volumen_max_dia ? fmtN(t.volumen_max_dia) : '—'}</td>
        <td style="text-align:right;font-size:11px;color:${t.cantidad_max_orden ? 'var(--accent)' : 'var(--text3)'}">${t.cantidad_max_orden ? fmtN(t.cantidad_max_orden) : '—'}</td>
        <td>
          <label class="toggle-switch" title="${t.activo ? 'Deslistar' : 'Listar'}">
            <input type="checkbox" ${t.activo ? 'checked' : ''} onchange="toggleTickerActivo('${esc(t.especie)}', this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td>
          <button class="btn-mini" data-action="abrir-modal-ticker" data-especie="${esc(t.especie)}">Editar</button>
        </td>
      </tr>
    `).join('');
  });
}

function abrirModalTicker(ticker = null) {
  if (typeof ticker === 'string' && ticker !== '') {
    ticker = _tickerDataMap[ticker] || null;
  }
  const modal = document.getElementById('modalTicker');
  document.getElementById('tickerResult').textContent = '';
  if (ticker && typeof ticker === 'object') {
    document.getElementById('modalTickerTitulo').textContent = 'Editar Ticker';
    document.getElementById('t-especie-orig').value  = ticker.especie;
    document.getElementById('t-especie').value        = ticker.especie;
    document.getElementById('t-panel').value          = ticker.panel;
    document.getElementById('t-yf').value             = ticker.yf_symbol || '';
    document.getElementById('t-nombre').value         = ticker.nombre || '';
    document.getElementById('t-volumen-max').value    = ticker.volumen_max_dia || '';
    document.getElementById('t-cantidad-max').value   = ticker.cantidad_max_orden || '';
    document.getElementById('t-especie').disabled    = true;
  } else {
    document.getElementById('modalTickerTitulo').textContent = 'Nuevo Ticker';
    document.getElementById('t-especie-orig').value  = '';
    document.getElementById('t-especie').value        = '';
    document.getElementById('t-panel').value          = 'BYMA';
    document.getElementById('t-yf').value             = '';
    document.getElementById('t-nombre').value         = '';
    document.getElementById('t-volumen-max').value    = '';
    document.getElementById('t-cantidad-max').value   = '';
    document.getElementById('t-especie').disabled    = false;
  }
  modal.classList.add('active');
}

function cerrarModalTicker(e) {
  if (e.target === document.getElementById('modalTicker')) {
    document.getElementById('modalTicker').classList.remove('active');
  }
}

async function guardarTicker(btn) {
  const resEl     = document.getElementById('tickerResult');
  resEl.textContent = '';
  const especieOrig = document.getElementById('t-especie-orig').value;
  const especie     = document.getElementById('t-especie').value.trim().toUpperCase();
  const panel       = document.getElementById('t-panel').value;
  const yfSymbol    = document.getElementById('t-yf').value.trim() || null;
  const nombre      = document.getElementById('t-nombre').value.trim() || null;
  const volumenMax  = parseInt(document.getElementById('t-volumen-max').value) || 0;
  const cantidadMax = parseInt(document.getElementById('t-cantidad-max').value) || 0;
  if (!especie) { resEl.textContent = 'La especie es requerida.'; return; }

  await _withButtonLoading(btn, async () => {
    try {
      let res;
      if (especieOrig) {
        res = await _apiFetchJson(`/api/admin/tickers/${especieOrig}`, 'PATCH',
          { panel, yf_symbol: yfSymbol, nombre, volumen_max_dia: volumenMax, cantidad_max_orden: cantidadMax });
      } else {
        res = await _apiFetchJson('/api/admin/tickers', 'POST',
          { especie, panel, yf_symbol: yfSymbol, nombre });
      }
      if (!res.ok) {
        const err = await res.json();
        _showResultErr(resEl, err.detail || 'Error al guardar');
        return;
      }
      document.getElementById('modalTicker').classList.remove('active');
      await cargarTickersAdmin();
    } catch(e) {
      _showResultErr(resEl, e.message);
    }
  });
}

async function toggleTickerActivo(especie, activo) {
  return _togglePatch(`/api/admin/tickers/${especie}`, { activo }, cargarTickersAdmin);
}

// ── BOTS DE MERCADO (multi-instancia) ─────────────────────────────────────────
const _TIPOS_COMPRA_SET = new Set(['LIMC']);
const _TIPOS_VENTA_SET  = new Set(['LIMV']);

function _tiposBadges(tipos) {
  return tipos.map(t => {
    const cls = _TIPOS_COMPRA_SET.has(t) ? 'ob-var-pos' : 'ob-var-neg';
    return `<span class="${cls}" style="font-size:10px;font-family:'IBM Plex Mono',monospace;padding:1px 5px;border-radius:2px">${esc(t)}</span>`;
  }).join(' ');
}

let _botDataMap          = {};   // id      → bot object
let _usuarioDataMap      = {};   // id      → usuario object
let _clienteDataMap      = {};   // codigo  → cliente object
let _tickerDataMap       = {};   // especie → ticker object
let _instrumentoDataMap  = {};   // id      → instrumento object
let _contraparteDataMap  = {};   // id      → contraparte object
let _limiteDataMap       = {};   // id      → limite object
let _hoveredBotId = null;

async function toggleBotHorario(botId) {
  const bot = _botDataMap[botId];
  if (!bot) return;
  const nuevo = bot.respetar_horario === false ? true : false;
  try {
    await apiFetch(`/api/admin/bots/${botId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ respetar_horario: nuevo }),
    });
    await cargarBots();
  } catch(e) { _logError('toggleHorarioBot', e); showToast('Error al cambiar horario del bot.', 'error'); }
}

async function setBulkHorario(respetar) {
  try {
    await apiFetch('/api/admin/bots/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ respetar_horario: respetar }),
    });
    await cargarBots();
  } catch(e) {
    showToast('Error al cambiar horario de bots.', 'error');
  }
}

async function cargarBots() {
  await _cargarTabla('botsBody', 9, async (tbody) => {
    const res  = await apiFetch('/api/admin/bots');
    const data = await res.json();
    // Sync global toggle: checked when ALL bots respect schedule
    const sw = document.getElementById('switch-horario-global');
    if (sw) sw.checked = data.length > 0 && data.every(b => b.respetar_horario !== false);
    if (!data.length) { tbody.innerHTML = _emptyTableRow(9, 'Sin instancias. Creá una con "+ Nueva instancia".'); return; }
    _botDataMap = _buildDataMap(data);
    const _perfilColor = { CONSERVADOR: '#4a9eff', MODERADO: '#f0a500', AGRESIVO: '#e05252', TRADER: '#00d4aa' };
    tbody.innerHTML = data.map(b => {
      const pColor = _perfilColor[b.perfil] || 'var(--text2)';
      return `
      <tr data-id="${b.id}" onmouseenter="_hoveredBotId=${b.id}" onmouseleave="_hoveredBotId=null" title="E para editar">
        <td><strong>${esc(b.nombre)}</strong></td>
        <td>
          <label class="toggle-switch" title="${b.enabled ? 'Desactivar' : 'Activar'}">
            <input type="checkbox" ${b.enabled ? 'checked' : ''} onchange="toggleBotEnabled(${b.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td><span style="font-size:10px;font-weight:600;color:${pColor};letter-spacing:.5px">${esc(b.perfil||'MODERADO')}</span></td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:12px">${b.interval}s</td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:12px">±${(b.variance*100).toFixed(2)}%</td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:12px">${((b.fill_rate||0.45)*100).toFixed(0)}%</td>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:12px">${b.max_ordenes}</td>
        <td>${_tiposBadges(b.tipos_orden)}</td>
        <td title="${b.respetar_horario ? 'Solo opera en horario de mercado (Lun–Vie 10–17 ART)' : 'Opera fuera de horario'}">
          ${b.respetar_horario
            ? '<span style="font-size:10px;color:var(--text3)">Lun–Vie 10–17</span>'
            : '<span style="font-size:10px;font-weight:600;color:var(--accent)">24/7</span>'}
        </td>
        <td style="display:flex;gap:4px">
          <button class="btn-mini" onclick="abrirModalCuentaBot(${b.id}, '${esc(b.nombre)}')">Cuenta</button>
          <button class="btn-mini" onclick="abrirModalPosicionesBot(${b.id}, '${esc(b.nombre)}')">Posiciones</button>
          <button class="btn-mini" onclick="abrirModalBot(${b.id})">Editar</button>
          <button class="btn-mini btn-danger" onclick="eliminarBot(${b.id}, '${esc(b.nombre)}')">Eliminar</button>
        </td>
      </tr>
    `}).join('');
  });
}

const _TODOS_TIPOS = ['LIMC', 'LIMV'];

// Profile defaults for auto-population when perfil selector changes
const _PERFIL_DEFAULTS = {
  CONSERVADOR: { interval: 15, variance: 0.35, fill_rate: 0.25 },
  MODERADO:    { interval: 7,  variance: 0.85, fill_rate: 0.45 },
  AGRESIVO:    { interval: 4,  variance: 1.75, fill_rate: 0.70 },
  TRADER:      { interval: 2,  variance: 0.10, fill_rate: 0.85 },
};

function aplicarPerfilDefaults() {
  const perfil = document.getElementById('b-perfil')?.value;
  // Only apply if fields are at their pristine (not user-edited) state
  // Use data-auto attribute to detect whether user has manually changed values
  const isNew = !document.getElementById('b-id')?.value;
  if (!isNew) return;  // Don't override values when editing
  const d = _PERFIL_DEFAULTS[perfil];
  if (!d) return;
  document.getElementById('b-interval').value  = d.interval;
  document.getElementById('b-variance').value  = d.variance;
  const fr = document.getElementById('b-fill-rate');
  if (fr) {
    fr.value = d.fill_rate;
    document.getElementById('b-fill-rate-val').textContent = (d.fill_rate * 100).toFixed(0) + '%';
  }
}

function abrirModalBot(bot = null) {
  if (typeof bot === 'number' || (typeof bot === 'string' && bot !== '')) {
    bot = _botDataMap[+bot] || null;
  }
  const modal = document.getElementById('modalBot');
  document.getElementById('botResult').textContent = '';
  _clearFieldErrors(modal);

  if (bot && typeof bot === 'object') {
    document.getElementById('modalBotTitulo').textContent = 'Editar instancia de Bot';
    document.getElementById('b-id').value           = bot.id;
    document.getElementById('b-nombre').value       = bot.nombre;
    document.getElementById('b-perfil').value       = bot.perfil || 'MODERADO';
    document.getElementById('b-interval').value     = bot.interval;
    document.getElementById('b-variance').value     = (bot.variance * 100).toFixed(2);
    document.getElementById('b-max-ordenes').value  = bot.max_ordenes;
    const fr = bot.fill_rate != null ? bot.fill_rate : 0.45;
    document.getElementById('b-fill-rate').value    = fr;
    document.getElementById('b-fill-rate-val').textContent = (fr * 100).toFixed(0) + '%';
    const pmEl = document.getElementById('b-prob-mercado');
    const pmValEl = document.getElementById('b-prob-mercado-val');
    if (pmEl) {
      if (bot.prob_orden_mercado != null) {
        pmEl.value = bot.prob_orden_mercado;
        pmValEl.textContent = (bot.prob_orden_mercado * 100).toFixed(0) + '%';
      } else {
        pmEl.value = '';
        pmValEl.textContent = 'perfil';
      }
    }
    const activos = new Set(bot.tipos_orden);
    _TODOS_TIPOS.forEach(t => {
      const cb = document.getElementById(`bt-${t}`);
      if (cb) cb.checked = activos.has(t);
    });
    const rhCb = document.getElementById('b-respetar-horario');
    if (rhCb) rhCb.checked = bot.respetar_horario !== false;
  } else {
    document.getElementById('modalBotTitulo').textContent = 'Nueva instancia de Bot';
    document.getElementById('b-id').value           = '';
    document.getElementById('b-nombre').value       = '';
    document.getElementById('b-perfil').value       = 'MODERADO';
    document.getElementById('b-interval').value     = '7';
    document.getElementById('b-variance').value     = '0.85';
    document.getElementById('b-max-ordenes').value  = '20';
    document.getElementById('b-fill-rate').value    = '0.45';
    document.getElementById('b-fill-rate-val').textContent = '45%';
    const pmEl = document.getElementById('b-prob-mercado');
    if (pmEl) { pmEl.value = ''; document.getElementById('b-prob-mercado-val').textContent = 'perfil'; }
    // Default: LIMC + LIMV checked
    _TODOS_TIPOS.forEach(t => {
      const cb = document.getElementById(`bt-${t}`);
      if (cb) cb.checked = (t === 'LIMC' || t === 'LIMV');
    });
    const rhCb = document.getElementById('b-respetar-horario');
    if (rhCb) rhCb.checked = true;
  }
  modal.classList.add('active');
}

function cerrarModalBot(e) {
  if (e.target === document.getElementById('modalBot')) {
    _checkModalDirty('modalBot', () => {
      document.getElementById('modalBot').classList.remove('active');
      _popModalFocus();
    });
  }
}

async function guardarBot(btn) {
  const resEl      = document.getElementById('botResult');
  const modal      = document.getElementById('modalBot');
  _clearFieldErrors(modal);
  resEl.textContent = '';

  const id         = document.getElementById('b-id').value;
  const nombre     = document.getElementById('b-nombre').value.trim();
  const perfil     = document.getElementById('b-perfil')?.value || 'MODERADO';
  const interval   = parseFloat(document.getElementById('b-interval').value) || 7;
  const variancePct= parseFloat(document.getElementById('b-variance').value) || 0.85;
  const maxOrdenes = parseInt(document.getElementById('b-max-ordenes').value) || 20;
  const fillRate   = parseFloat(document.getElementById('b-fill-rate')?.value ?? 0.45);
  const tipos      = _TODOS_TIPOS.filter(t => document.getElementById(`bt-${t}`)?.checked);
  const respetar   = document.getElementById('b-respetar-horario')?.checked ?? true;
  const pmRaw      = document.getElementById('b-prob-mercado')?.value;
  const probMercado= pmRaw !== '' && pmRaw != null ? parseFloat(pmRaw) : null;

  let hasError = false;
  if (!nombre)       { _setFieldError('b-nombre', 'El nombre es requerido.'); hasError = true; }
  if (!tipos.length) { _showResultErr(resEl, 'Seleccioná al menos un tipo de orden.'); hasError = true; }
  if (hasError) return;

  const body = { nombre, enabled: true, interval, variance: variancePct / 100, max_ordenes: maxOrdenes,
    tipos_orden: tipos, perfil, fill_rate: fillRate, respetar_horario: respetar, prob_orden_mercado: probMercado };

  await _withButtonLoading(btn, async () => {
    try {
      const res = await (id
        ? _apiFetchJson(`/api/admin/bots/${id}`, 'PATCH', body)
        : _apiFetchJson('/api/admin/bots', 'POST', body));
      if (!res.ok) {
        const err = await res.json();
        _showResultErr(resEl, err.detail || 'Error al guardar');
        return;
      }
      document.getElementById('modalBot').classList.remove('active');
      await cargarBots();
    } catch(e) {
      _showResultErr(resEl, e.message);
    }
  });
}

async function toggleBotEnabled(botId, enabled) {
  try {
    await _apiFetchJson(`/api/admin/bots/${botId}`, 'PATCH', { enabled });
    await cargarBots();
  } catch { await cargarBots(); }
}

async function eliminarBot(botId, nombre) {
  _confirmar(
    'Eliminar instancia',
    `¿Eliminar la instancia "${nombre}"? Esta acción no se puede deshacer.`,
    async () => {
      try {
        await apiFetch(`/api/admin/bots/${botId}`, { method: 'DELETE' });
        showToast(`Instancia "${nombre}" eliminada.`, 'ok');
        await cargarBots();
      } catch(e) {
        showToast('Error al eliminar: ' + e.message, 'error');
      }
    }
  );
}


// ── Sistema config ────────────────────────────────────────────────────────────

async function cargarConfigSistema() {
  try {
    const res  = await apiFetch('/api/admin/config');
    const cfg  = await res.json();
    const cb   = document.getElementById('cfg-auto-matching');
    const sel  = document.getElementById('cfg-matching-mercado');
    const stat = document.getElementById('cfg-matching-status');
    if (cb)   cb.checked = cfg.auto_matching;
    if (sel)  sel.value  = cfg.matching_mercado || 'DEFAULT';
    if (stat) stat.textContent = cfg.auto_matching
      ? `Activo — cruces automáticos habilitados (mercado: ${cfg.matching_mercado})`
      : 'Desactivado — las ejecuciones se registran manualmente.';
    // Sesgo macro
    const sesgo = cfg.mercado_sesgo ?? 0;
    const slider = document.getElementById('cfg-mercado-sesgo');
    const label  = document.getElementById('cfg-sesgo-valor');
    if (slider) slider.value = Math.round(sesgo * 100);
    if (label)  label.textContent = sesgo > 0 ? `+${Math.round(sesgo*100)}%` : `${Math.round(sesgo*100)}%`;
  } catch(e) {
    showToast('Error cargando config: ' + e.message, 'error');
  }
}

async function guardarSesgoMacro(valor) {
  try {
    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mercado_sesgo: valor }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Error: ' + (err.detail || res.status), 'error');
      await cargarConfigSistema();
      return;
    }
    const label = Math.round(valor * 100);
    const txt = label > 0 ? `+${label}% BULL` : label < 0 ? `${label}% BEAR` : 'Neutral';
    showToast(`Sesgo macro actualizado: ${txt}`, 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function toggleAutoMatching(enabled) {
  try {
    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_matching: enabled }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Error: ' + (err.detail || res.status), 'error');
      await cargarConfigSistema(); // revert toggle UI
      return;
    }
    await cargarConfigSistema();
    showToast(`Matching automático ${enabled ? 'activado' : 'desactivado'}.`, enabled ? 'success' : 'info');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
    await cargarConfigSistema();
  }
}

async function guardarMercadoMatching() {
  const sel = document.getElementById('cfg-matching-mercado');
  if (!sel) return;
  try {
    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matching_mercado: sel.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Error: ' + (err.detail || res.status), 'error');
      return;
    }
    await cargarConfigSistema();
    showToast('Mercado de matching actualizado.', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}


async function resetDemoData() {
  const resEl = document.getElementById('demo-reset-result');
  _confirmar(
    '⚠ Reiniciar datos operativos',
    'Se borrarán PERMANENTEMENTE todas las órdenes, ejecuciones, posiciones y movimientos de cuenta del entorno demo. Los usuarios y configuración no se tocan. Esta acción NO se puede deshacer.',
    async () => {
      resEl.textContent = 'Eliminando...';
      _resetDemoDataExec(resEl);
    }
  );
}

async function _resetDemoDataExec(resEl) {
  _setLoadingMessage(resEl, 'Eliminando... (puede demorar unos segundos)');
  resEl.style.color = 'var(--text3)';
  try {
    const res = await apiFetch('/api/admin/demo-reset', { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      resEl.innerHTML = 'Error: ' + esc(err.detail || res.status);
      resEl.style.color = 'var(--red)';
      return;
    }
    const data = await res.json();
    resEl.innerHTML = esc(data.mensaje);
    resEl.style.color = 'var(--green)';
    showToast('Datos operativos eliminados correctamente.', 'ok');
  } catch(e) {
    resEl.innerHTML = 'Error: ' + esc(e.message);
    resEl.style.color = 'var(--red)';
  }
}


// ── MODAL CUENTA BOT ────────────────────────────────────────────────────────

let _cbAccountId        = null;  // account_id del bot actualmente abierto
let _cbBotId            = null;  // bot_id del bot actualmente abierto
let _cbPage             = 1;
let _cbTotalPages       = 1;
let _cbMovCargados      = false; // lazy-load flag

const _fmtARSCompact = v => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1_000_000) return fmt(n / 1_000_000) + 'M';
  if (Math.abs(n) >= 1_000)     return fmt(n / 1_000) + 'K';
  return fmt(v);
};

function cerrarModalCuentaBot(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modalCuentaBot').classList.remove('active');
}

// ── Bot positions modal ────────────────────────────────────────────────────────

async function abrirModalPosicionesBot(botId, botNombre) {
  const modal   = document.getElementById('modalPosicionesBot');
  const titulo  = document.getElementById('posicionesBotTitulo');
  const content = document.getElementById('posicionesBotContent');

  titulo.textContent = `Posiciones: ${botNombre}`;
  content.innerHTML  = '<div class="spinner"></div>';
  modal.classList.add('active');

  try {
    const res  = await apiFetch(`/api/admin/bots/${botId}/posiciones`);
    const data = await res.json();

    if (!data.length) {
      content.innerHTML = '<p style="color:var(--text3);font-size:13px;padding:16px 0">Sin ejecuciones registradas para este bot.</p>';
      return;
    }

    const totalValor = data.reduce((s, r) => s + (r.valor_mercado || 0), 0);
    const totalPnl   = data.reduce((s, r) => s + (r.pnl_estimado || 0), 0);
    const pnlColor   = totalPnl >= 0 ? 'var(--green)' : 'var(--red)';
    const fmt        = v => v == null ? '—' : v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const rows = data.map(r => {
      const neta      = r.cantidad_neta;
      const netaColor = neta > 0 ? 'var(--green)' : neta < 0 ? 'var(--red)' : 'var(--text3)';
      const pnl       = r.pnl_estimado;
      const pnlCl     = pnl == null ? 'var(--text3)' : pnl >= 0 ? 'var(--green)' : 'var(--red)';
      return `
        <tr>
          <td><strong>${esc(r.especie)}</strong></td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${r.cantidad_comprada.toLocaleString('es-AR')}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${r.cantidad_vendida.toLocaleString('es-AR')}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:${netaColor}">${neta.toLocaleString('es-AR')}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${fmt(r.costo_promedio)}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${fmt(r.precio_actual)}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text2)">${fmt(r.valor_mercado)}</td>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${pnlCl}">${pnl == null ? '—' : (pnl >= 0 ? '+' : '') + fmt(pnl)}</td>
        </tr>`;
    }).join('');

    content.innerHTML = `
      <div style="display:flex;gap:24px;margin-bottom:14px;padding:10px 14px;background:var(--bg2);border-radius:6px;font-size:12px">
        <span style="color:var(--text3)">Especies con posición: <strong style="color:var(--text2)">${data.filter(r=>r.cantidad_neta!==0).length}</strong></span>
        <span style="color:var(--text3)">Valor @ mercado: <strong style="color:var(--text2)">$ ${fmt(totalValor)}</strong></span>
        <span style="color:var(--text3)">P&L estimado: <strong style="color:${pnlColor}">${totalPnl >= 0 ? '+' : ''}$ ${fmt(totalPnl)}</strong></span>
      </div>
      <div class="table-wrap">
        <table class="orders-table mini-table">
          <thead>
            <tr>
              <th>Especie</th>
              <th>Comprada</th>
              <th>Vendida</th>
              <th>Neta</th>
              <th>Costo prom.</th>
              <th>Precio actual</th>
              <th>Valor mercado</th>
              <th>P&L estimado</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch(e) {
    content.innerHTML = `<p style="color:var(--red);font-size:13px">${esc(e.message)}</p>`;
  }
}

function switchCuentaBotTab(tab) {
  _switchTab(tab, ['resumen', 'movimientos', 'operaciones'], 'cbTab-', 'cb-tab-',
    t => { if (t === 'movimientos' && !_cbMovCargados) cargarMovimientosBot(1); });
}

async function abrirModalCuentaBot(botId, botNombre) {
  _cbAccountId   = null;
  _cbBotId       = botId;
  _cbPage        = 1;
  _cbTotalPages  = 1;
  _cbMovCargados = false;

  document.getElementById('cuentaBotTitulo').textContent   = `Cuenta: ${botNombre}`;
  document.getElementById('cuentaBotSubtitulo').textContent = 'Cargando...';
  document.getElementById('cb-sin-cuenta').style.display   = 'none';
  document.getElementById('cb-tab-resumen').style.display  = '';
  document.getElementById('cb-tab-movimientos').style.display  = 'none';
  document.getElementById('cb-tab-operaciones').style.display  = 'none';
  document.getElementById('cb-metricas').innerHTML = '<div style="color:var(--text3);font-size:11px;padding:8px 0">Cargando métricas...</div>';
  document.getElementById('cb-stats').textContent  = '';
  document.getElementById('cb-ajuste-result').textContent  = '';

  // Reset form
  document.getElementById('cb-sentido-credit').checked = true;
  document.getElementById('cb-monto').value        = '';
  document.getElementById('cb-descripcion').value  = '';

  // Active tab reset
  document.getElementById('cbTab-resumen').classList.add('active');
  document.getElementById('cbTab-movimientos').classList.remove('active');
  document.getElementById('cbTab-operaciones').classList.remove('active');

  // Show/hide Operaciones tab based on role
  const isAdmin = state.userRole === 'ADMIN';
  document.getElementById('cbTab-operaciones').style.display = isAdmin ? '' : 'none';

  document.getElementById('modalCuentaBot').classList.add('active');

  await cargarRendimientoBot(botId);
}

async function cargarRendimientoBot(botId) {
  try {
    const res  = await apiFetch(`/api/cuentas/bots/${botId}/rendimiento`);
    const data = await res.json();

    if (data.sin_cuenta) {
      document.getElementById('cb-tab-resumen').style.display  = 'none';
      document.getElementById('cb-sin-cuenta').style.display   = '';
      document.getElementById('cb-sin-cuenta-msg').textContent = data.mensaje || 'Sin cuenta asignada.';
      document.getElementById('cuentaBotSubtitulo').textContent = 'Sin cuenta';
      document.getElementById('cbTab-movimientos').disabled    = true;
      document.getElementById('cbTab-operaciones').style.display = 'none';
      // Show init form only for ADMIN
      document.getElementById('cb-init-form').style.display   = state.userRole === 'ADMIN' ? '' : 'none';
      document.getElementById('cb-init-result').textContent   = '';
      document.getElementById('cb-init-capital').value        = '';
      return;
    }

    _cbAccountId = data.account_id;
    document.getElementById('cbTab-movimientos').disabled = false;
    document.getElementById('cuentaBotSubtitulo').textContent =
      `${data.moneda || 'ARS'} · account #${data.account_id}`;

    _renderResumenBot(data);
  } catch(e) {
    document.getElementById('cb-metricas').innerHTML =
      `<div style="color:var(--red);font-size:11px">Error al cargar: ${esc(e.message)}</div>`;
  }
}

function _renderResumenBot(d) {
  const pnlColor    = d.pnl_realizado  >= 0 ? 'var(--green)' : 'var(--red)';
  const retColor    = d.retorno_pct    >= 0 ? 'var(--green)' : 'var(--red)';
  const pnlSign     = d.pnl_realizado  >= 0 ? '+' : '';
  const retSign     = d.retorno_pct    >= 0 ? '+' : '';

  const metricBox = (label, value, color = 'var(--text1)') => `
    <div style="background:var(--bg4);border:1px solid var(--border);border-radius:2px;padding:10px;text-align:center">
      <div style="font-size:10px;color:var(--text3);margin-bottom:5px;letter-spacing:.5px;text-transform:uppercase">${label}</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;color:${color}">${value}</div>
    </div>`;

  document.getElementById('cb-metricas').innerHTML =
    metricBox('Saldo actual',    '$' + _fmtARSCompact(d.balance_cash)) +
    metricBox('Capital inicial', '$' + _fmtARSCompact(d.capital_inicial)) +
    metricBox('PnL realizado',   pnlSign + '$' + _fmtARSCompact(d.pnl_realizado), pnlColor) +
    metricBox('Retorno',         retSign + (d.retorno_pct || 0).toFixed(2) + '%', retColor);

  document.getElementById('cb-stats').innerHTML =
    `Operaciones: <strong>${(d.n_operaciones || 0).toLocaleString('es-AR')}</strong> &nbsp;·&nbsp; ` +
    `Volumen operado: <strong>$${_fmtARSCompact(d.volumen_operado)}</strong> &nbsp;·&nbsp; ` +
    `Compras: <strong>$${_fmtARSCompact(d.total_compras)}</strong> &nbsp;·&nbsp; ` +
    `Ventas: <strong>$${_fmtARSCompact(d.total_ventas)}</strong> &nbsp;·&nbsp; ` +
    `Comisiones: <strong>$${_fmtARSCompact(d.total_comisiones)}</strong>`;
}

async function cargarMovimientosBot(page) {
  if (!_cbAccountId) return;
  _cbPage = page;
  const tbody = document.getElementById('cb-movimientos-body');
  tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Cargando...</td></tr>`;

  try {
    const res  = await apiFetch(`/api/cuentas/${_cbAccountId}/movimientos?page=${page}&per_page=${MOV_PER_PAGE}`);
    const data = await res.json();

    _cbTotalPages  = data.pages || 1;
    _cbMovCargados = true;

    document.getElementById('cb-pag-info').textContent  = `Página ${data.current_page} de ${data.pages}`;
    document.getElementById('cb-pag-prev').disabled     = data.current_page <= 1;
    document.getElementById('cb-pag-next').disabled     = data.current_page >= data.pages;

    if (!data.entries.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Sin movimientos registrados.</td></tr>`;
      return;
    }

    const _tipoColor = {
      COMPRA: 'var(--red)', VENTA: 'var(--green)', COMISION: 'var(--red)',
      AJUSTE_CREDITO: 'var(--green)', AJUSTE_DEBITO: 'var(--red)',
      DEPOSITO: 'var(--green)', RETIRO: 'var(--red)',
      BOT_ASIGNACION: 'var(--green)', BOT_DEVOLUCION: 'var(--red)',
    };

    tbody.innerHTML = data.entries.map(e => {
      const isCredit  = e.sentido === 'CREDIT';
      const montoSign = isCredit ? '+' : '-';
      const montoClr  = isCredit ? 'var(--green)' : 'var(--red)';
      const tipoClr   = _tipoColor[e.tipo] || 'var(--text2)';
      const fecha = _fmtDatetime(e.created_at);
      return `<tr>
        <td style="font-family:'IBM Plex Mono',monospace;font-size:11px;white-space:nowrap">${esc(fecha)}</td>
        <td><span style="font-size:10px;font-weight:600;color:${tipoClr}">${esc(e.tipo)}</span></td>
        <td style="font-size:10px;color:${isCredit ? 'var(--green)' : 'var(--red)'}">${esc(e.sentido)}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px;color:${montoClr}">${montoSign}$${fmt(e.monto)}</td>
        <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11px">$${fmt(e.balance_post)}</td>
        <td style="font-size:10px;color:var(--text3);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.descripcion||'')}">${esc(e.descripcion || '—')}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = _errorTableRow(6, e.message);
  }
}

function cambiarPaginaBot(delta) {
  const nueva = _cbPage + delta;
  if (nueva < 1 || nueva > _cbTotalPages) return;
  cargarMovimientosBot(nueva);
}

async function ejecutarAjusteBot() {
  if (!_cbAccountId) return;
  const resEl = document.getElementById('cb-ajuste-result');
  resEl.style.color   = 'var(--text2)';
  resEl.textContent   = '';

  const sentido    = document.querySelector('input[name="cb-sentido"]:checked')?.value;
  const monto      = parseFloat(document.getElementById('cb-monto').value);
  const descripcion = document.getElementById('cb-descripcion').value.trim();

  if (!sentido)            { resEl.style.color = 'var(--red)'; resEl.textContent = 'Seleccioná una operación.'; return; }
  if (!(monto > 0))        { resEl.style.color = 'var(--red)'; resEl.textContent = 'El monto debe ser mayor a 0.'; return; }
  if (descripcion.length < 5) { resEl.style.color = 'var(--red)'; resEl.textContent = 'La descripción debe tener al menos 5 caracteres.'; return; }

  resEl.textContent = 'Procesando...';
  try {
    const res  = await apiFetch(`/api/cuentas/${_cbAccountId}/ajuste`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ monto, sentido, descripcion }),
    });
    const data = await res.json();
    if (!res.ok) {
      resEl.style.color = 'var(--red)';
      resEl.textContent = data.detail || 'Error al registrar ajuste.';
      return;
    }
    resEl.style.color = 'var(--green)';
    resEl.textContent = `Ajuste registrado. Saldo post: $${fmt(data.balance_post)}`;
    document.getElementById('cb-monto').value       = '';
    document.getElementById('cb-descripcion').value = '';
    // Reload resumen with updated balance
    _cbMovCargados = false;
    await cargarRendimientoBot(_cbBotId);
  } catch(e) {
    resEl.style.color = 'var(--red)';
    resEl.textContent = e.message;
  }
}

async function inicializarCuentaBot() {
  const resEl   = document.getElementById('cb-init-result');
  const capital = parseFloat(document.getElementById('cb-init-capital').value);
  if (!(capital > 0)) {
    resEl.style.color = 'var(--red)';
    resEl.textContent = 'Ingresá un capital mayor a 0.';
    return;
  }
  resEl.style.color = 'var(--text2)';
  resEl.textContent = 'Creando cuenta...';
  try {
    const res  = await apiFetch(`/api/cuentas/bots/${_cbBotId}/inicializar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ capital_inicial: capital }),
    });
    const data = await res.json();
    if (!res.ok) {
      resEl.style.color = 'var(--red)';
      resEl.textContent = data.detail || 'Error al crear cuenta.';
      return;
    }
    // Cuenta creada — recargar el modal desde el inicio
    document.getElementById('cb-sin-cuenta').style.display  = 'none';
    document.getElementById('cb-tab-resumen').style.display = '';
    document.getElementById('cbTab-movimientos').disabled   = false;
    _cbMovCargados = false;
    await cargarRendimientoBot(_cbBotId);
  } catch(e) {
    resEl.style.color = 'var(--red)';
    resEl.textContent = e.message;
  }
}

async function ejecutarReconciliarBot() {
  if (!_cbAccountId) return;
  _confirmar(
    'Reconciliar balance',
    'Se recalculará el balance sumando todos los movimientos del ledger. Operación de solo lectura — actualiza balance_cache.',
    async () => {
      const resEl = document.getElementById('cb-ajuste-result');
      await _reconciliarBotExec(resEl);
    }
  );
}

async function _reconciliarBotExec(resEl) {
  const el = resEl || document.getElementById('cb-ajuste-result');
  el.style.color = 'var(--text2)';
  el.textContent = 'Reconciliando...';
  try {
    const res  = await apiFetch(`/api/cuentas/${_cbAccountId}/reconciliar`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      el.style.color = 'var(--red)';
      el.textContent = data.detail || 'Error al reconciliar.';
      return;
    }
    const drift = data.drift || 0;
    el.style.color = Math.abs(drift) > 0.01 ? 'var(--red)' : 'var(--green)';
    el.textContent =
      `Reconciliado. Balance nuevo: $${fmt(data.balance_nuevo)} ` +
      `(antes: $${fmt(data.balance_antes)}, drift: ${drift >= 0 ? '+' : ''}$${fmt(drift)})`;
    _cbMovCargados = false;
    await cargarRendimientoBot(_cbBotId);
  } catch(e) {
    el.style.color = 'var(--red)';
    el.textContent = e.message;
  }
}
