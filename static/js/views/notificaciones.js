// ══════════════════════════════════════════════════════════════════════════════
//  VISTA: NOTIFICACIONES
// ══════════════════════════════════════════════════════════════════════════════

/** Returns all notification containers (panel + dropdown body). */
function _notifContainers() {
  return [
    document.getElementById('notifLog'),
    document.getElementById('notifDropdownBody'),
  ].filter(Boolean);
}

async function cargarNotificaciones() {
  const res = await apiFetch('/api/notificaciones');
  const data = await res.json();
  _notifContainers().forEach(log => { log.innerHTML = ''; });
  data.forEach(n => prependNotificacion(n, false));
  _notifContainers().forEach(log => { log.scrollTop = log.scrollHeight; });
}

function prependNotificacion(n, animate = true) {
  if (animate) {
    _notifUnread++;
    _updateNotifBadge();
  }

  _notifContainers().forEach(log => {
    const placeholder = log.querySelector('.notif-placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = `notif-item notif-${n.tipo}`;
    if (!animate) div.style.animation = 'none';
    div.innerHTML = `
      <span class="notif-ts">${esc(n.timestamp)}</span>
      <span class="notif-srv">[${esc(n.servicio)}]</span>
      <span class="notif-msg">${esc(n.mensaje)}</span>
    `;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 80) log.removeChild(log.firstChild);
  });
}

function limpiarNotificaciones() {
  _notifContainers().forEach(log => {
    log.innerHTML = '<div class="notif-placeholder">Log limpiado</div>';
  });
}
