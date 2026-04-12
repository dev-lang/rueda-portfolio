// ── CONSTANTS ──────────────────────────────────────────────────────────────
const TOAST_DURATION_OK       = 3500;  // ms — success/info toasts
const TOAST_DURATION_ERROR    = 6000;  // ms — error toasts stay longer
const MOV_PER_PAGE            = 20;    // rows per page for movement tables
const LIQ_PER_PAGE            = 50;    // rows per page for liquidaciones
const OB_DEBOUNCE_MS          = 600;   // ms — orderbook fetch debounce
const SEARCH_DEBOUNCE_MS      = 180;   // ms — global search debounce
const RECONNECT_FAIL_MS       = 30_000; // ms — show "Sin conexión" banner after this
const CONFIRM_AUTODISMISS_MS  = 10 * 60 * 1000; // 10 min — auto-close stale confirm dialogs
const STATUS_EVENT_DURATION_MS = 5000; // ms — how long status event text stays visible
const TOAST_MAX               = 4;    // max simultaneous toasts before evicting the oldest
