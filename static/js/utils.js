// ── XSS SANITIZATION ───────────────────────────────────────────────────────
/**
 * Escapes HTML special characters to prevent XSS when inserting
 * server-supplied strings into innerHTML contexts.
 */
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── DEBOUNCE ────────────────────────────────────────────────────────────────
function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── ERROR LOGGING (B38) ────────────────────────────────────────────────────
/**
 * Centralized error logger. Drop-in for console.error that can be wired
 * to a monitoring service (Sentry, LogRocket, etc.) without changing call sites.
 * Add ?debug=1 to the URL to see stack traces in the browser console.
 */
function _logError(context, err) {
  // Aborts from navController.abort() are expected control flow, not errors.
  if (_isAbort(err)) return;
  const isDebug = new URLSearchParams(window.location.search).has('debug');
  if (isDebug) {
    console.error(`[${context}]`, err);
  } else {
    console.warn(`[${context}] ${err?.message || err}`);
  }
  // Replace this comment with: Sentry.captureException(err, { extra: { context } });
}

// ── CENTRALIZED API ERROR MESSAGES (C2) ────────────────────────────────────
/**
 * Extracts a user-friendly message from a failed API response.
 * Differentiates: validation (400/422), forbidden (403), server (500), network.
 */
function _apiErrMsg(res, result, fallback = 'Error inesperado.') {
  if (!res) return fallback;
  const detail = result?.detail;
  if (res.status === 422 || res.status === 400) {
    if (Array.isArray(detail)) return detail.map(d => d.msg || d.message || JSON.stringify(d)).join(' · ');
    return typeof detail === 'string' ? detail : fallback;
  }
  if (res.status === 403) return 'Sin permisos para realizar esta acción.';
  if (res.status === 404) return 'Recurso no encontrado.';
  if (res.status >= 500) return 'Error interno del servidor.';
  if (detail?.mensaje) return detail.mensaje;
  if (typeof detail === 'string') return detail;
  return fallback;
}

// ── FORMATO ────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('es-AR');
}

// ── DATE FORMATTING HELPERS (A7) ───────────────────────────────────────────
/**
 * Format an ISO datetime string to "DD/MM/YYYY HH:MM" using Argentine locale.
 * Accepts both "2025-03-21T10:04:00" and "2025-03-21 10:04:00" forms.
 */
function _fmtDatetime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d)) return String(isoStr).slice(0, 16).replace('T', ' ');
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── ISO DATE HELPERS ────────────────────────────────────────────────────────
function _isoToday() { return new Date().toISOString().slice(0, 10); }
function _isoMinus(days) {
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
