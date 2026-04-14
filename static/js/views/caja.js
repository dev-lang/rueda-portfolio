// ═══════════════════════════════════════════════════════════════════════════
// ── CAJA EN TIEMPO REAL — PROYECCIÓN (Feature 12) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function cargarProyeccion() {
  const cliente = document.getElementById('cajaProjCliente')?.value || 'STD';
  const moneda  = document.getElementById('cajaProjMoneda')?.value || 'ARP';
  const fmtARS  = v => Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  try {
    const res = await apiFetch(`/api/cuentas/proyeccion?cliente=${encodeURIComponent(cliente)}&moneda=${moneda}`);
    if (!res.ok) return;
    const d = await res.json();

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('kpi-saldo-actual', fmtARS(d.saldo_actual));
    set('kpi-comprometido', fmtARS(d.comprometido));
    set('kpi-saldo-libre',  fmtARS(d.saldo_proyectado));

    const libreCard = document.getElementById('kpi-libre-card');
    if (libreCard) libreCard.className = 'kpi-card ' + (d.alerta ? 'red' : 'green');

    const alertaEl = document.getElementById('cajaAlerta');
    if (alertaEl) alertaEl.style.display = d.alerta ? '' : 'none';

    const detalleEl = document.getElementById('cajaOrdenesDetalle');
    if (detalleEl) {
      if (!d.ordenes_pendientes.length) {
        detalleEl.innerHTML = '<span class="text-muted" style="font-size:11px">Sin ordenes de compra pendientes.</span>';
      } else {
        detalleEl.innerHTML = `
          <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px">Ordenes que componen el comprometido:</div>
          <table class="orders-table mini-table">
            <thead><tr><th>Nro. Orden</th><th>Especie</th><th>Tipo Precio</th><th>Precio Ref.</th><th>Cant. Pend.</th><th>Importe</th></tr></thead>
            <tbody>${d.ordenes_pendientes.map(o => `<tr>
              <td>${esc(o.nro_orden)}</td>
              <td>${_badgeEspecie(o.especie)}</td>
              <td>${esc(o.tipo_precio)}</td>
              <td class="precio-cell">${fmtARS(o.precio_ref)}</td>
              <td class="ejec-cell">${Number(o.qty_pendiente).toLocaleString('es-AR')}</td>
              <td class="precio-cell"><strong>${fmtARS(o.importe)}</strong></td>
            </tr>`).join('')}</tbody>
          </table>`;
      }
    }
  } catch (e) { showToast('Error al cargar proyección de caja.', 'error'); }
}
