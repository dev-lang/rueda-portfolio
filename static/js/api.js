// ── AUTH / SESSION ─────────────────────────────────────────────────────────
/**
 * Drop-in fetch wrapper that:
 *  - Always sends httpOnly cookies (credentials: 'include')
 *  - On HTTP 401, transparently calls /api/auth/refresh once and retries the
 *    original request before falling back to /login. Concurrent 401s share a
 *    single in-flight refresh promise so we never fire N parallel refreshes.
 */
let _refreshInflight = null;

async function _tryRefreshToken() {
  // Coalesce concurrent refresh attempts onto a single in-flight promise.
  if (_refreshInflight) return _refreshInflight;
  _refreshInflight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      return res.ok;
    } catch {
      return false;
    }
  })();
  try {
    return await _refreshInflight;
  } finally {
    _refreshInflight = null;
  }
}

async function apiFetch(url, opts = {}) {
  const signal = opts.signal ?? state?.navController?.signal;
  const doFetch = () => fetch(url, { ...opts, credentials: 'include', signal });

  let res;
  try {
    res = await doFetch();
  } catch (e) {
    // AbortError fires when the user navigated away mid-request (navController.abort()).
    // The view that issued this fetch is gone, so letting the caller's .catch() run
    // would write "Error: signal is aborted..." into the stale DOM of the hidden view.
    // Instead we return a never-resolving promise: the caller hangs harmlessly and
    // its closures are released when the view is re-rendered on re-entry.
    if (e?.name === 'AbortError') return new Promise(() => {});
    throw e;
  }

  if (res.status === 401) {
    // Don't try to refresh the auth endpoints themselves — that causes loops.
    // /me is allowed to refresh because it's the session check on init.
    const isAuthMutation = /\/api\/auth\/(login|logout|refresh)\b/.test(url);
    if (!isAuthMutation) {
      const refreshed = await _tryRefreshToken();
      if (refreshed) {
        // Retry the original request once with the new cookies in place.
        try {
          res = await doFetch();
        } catch (e) {
          if (e?.name === 'AbortError') return new Promise(() => {});
          throw e;
        }
        if (res.status !== 401) return res;
      }
    }
    window.location.href = '/login';
    // Throw so catch blocks in callers run and can clean up the UI
    throw new Error('401 No autenticado — redirigiendo al login');
  }
  return res;
}

// Helper: true if an error came from a fetch aborted by navigation (defense in depth).
function _isAbort(e) { return e?.name === 'AbortError'; }

async function logout() {
  // Detach all socket listeners before redirecting to prevent listener duplication
  // if the session is later reused within the same page lifetime
  if (state.socket) {
    state.socket.off();
    state.socket.disconnect();
    state.socket = null;
  }
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  window.location.href = '/login';
}

// ── JSON FETCH HELPER ─────────────────────────────────────────────────────
/**
 * Shorthand for apiFetch with Content-Type: application/json.
 * Pass data=null for bodyless requests (DELETE, POST without body).
 */
async function _apiFetchJson(url, method = 'POST', data = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (data != null) opts.body = JSON.stringify(data);
  return apiFetch(url, opts);
}
