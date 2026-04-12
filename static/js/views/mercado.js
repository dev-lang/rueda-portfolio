// ── MERCADO ──────────────────────────────────────────────────────────────────

let _tcMEP = null;  // tipo de cambio MEP vigente

function switchMercadoTab(tab) {
  document.querySelectorAll('[data-mercado-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mercadoTab === tab);
  });
  document.querySelectorAll('.mercado-moneda-tab').forEach(el => {
    el.style.display = el.id === `mercado-tab-${tab}` ? '' : 'none';
  });
}

async function cargarMercado() {
  try {
    const res  = await apiFetch('/api/mercado/grupos');
    const data = await res.json();
    const tc   = data.tipo_cambio || {};
    _tcMEP = tc.mep || tc.ccl || null;
    renderTipoCambio(tc);
    renderGrupo('tbl-byma-body',   data.byma,           false);
    renderGrupo('tbl-merval-body', data.merval_general,  true);

    // USD tab: show table if there are USD tickers, else show placeholder
    const usdItems = data.usd || [];
    const usdPlaceholder = document.getElementById('mercado-usd-placeholder');
    const usdTable       = document.getElementById('mercado-usd-table');
    if (usdItems.length) {
      usdPlaceholder.style.display = 'none';
      usdTable.style.display       = '';
      renderGrupo('tbl-usd-body', usdItems, false);
    } else {
      usdPlaceholder.style.display = '';
      usdTable.style.display       = 'none';
    }

    // Auto-refresh on first load if DB has no prices yet
    const allItems = [...(data.byma || []), ...(data.merval_general || [])];
    const hasAnyPrice = allItems.some(r => r.precio != null);
    if (!hasAnyPrice) refrescarMercado();
  } catch {
    document.getElementById('tbl-byma-body').innerHTML   = '<tr><td colspan="4" class="text-muted">Error al cargar datos.</td></tr>';
    document.getElementById('tbl-merval-body').innerHTML = _emptyTableRow(5, 'Error al cargar datos.');
  }
}

function renderTipoCambio(tc) {
  const el = document.getElementById('mercadoTc');
  if (!el) return;
  const f = v => v ? Number(v).toLocaleString('es-AR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—';
  el.innerHTML = `MEP <strong>${f(tc.mep)}</strong> &nbsp;·&nbsp; CCL <strong>${f(tc.ccl)}</strong> &nbsp;·&nbsp; Oficial <strong>${f(tc.oficial)}</strong>`;
}

function renderGrupo(tbodyId, items, showUSD) {
  const fmtN = v => v == null ? '—' : Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtV = v => {
    if (v == null) return '<td style="text-align:right;color:var(--text3)">—</td>';
    const cls = v >= 0 ? 'neta-pos' : 'neta-neg';
    return `<td class="${cls}" style="text-align:right">${v >= 0 ? '+' : ''}${v}%</td>`;
  };
  const isD = esp => esp.endsWith('D') || esp.endsWith('.D') || esp.endsWith('.C') || esp.endsWith('C');
  const rows = items.map(r => {
    const usdCell = showUSD
      ? `<td style="text-align:right;font-size:11px;color:var(--text3);font-family:'IBM Plex Mono',monospace">${(r.precio && _tcMEP && isD(r.especie)) ? 'U$S ' + fmtN(r.precio / _tcMEP) : '—'}</td>`
      : '';
    return `
    <tr style="cursor:pointer" data-especie="${esc(r.especie)}" class="mercado-row">
      <td><span class="badge-tipo" style="font-family:'IBM Plex Mono',monospace;font-size:12px">${esc(r.especie)}</span></td>
      <td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-size:12px">${fmtN(r.precio)}</td>
      ${fmtV(r.variacion_pct)}
      ${usdCell}
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-mini mercado-chart-btn" data-especie="${esc(r.especie)}" style="margin-right:3px">Gráfico</button>
        <button class="btn-mini mercado-orden-btn" data-especie="${esc(r.especie)}">+ Orden</button>
      </td>
    </tr>`;
  }).join('');
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = rows || '<tr><td colspan="5" class="text-muted">Sin datos</td></tr>';
  // Attach click handlers via event delegation (avoids onclick injection)
  tbody.querySelectorAll('tr.mercado-row').forEach(row => {
    row.addEventListener('click', () => abrirModalOrdenEspecie(row.dataset.especie));
  });
  tbody.querySelectorAll('.mercado-chart-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); abrirModalGrafico(btn.dataset.especie); });
  });
  tbody.querySelectorAll('.mercado-orden-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); abrirModalOrdenEspecie(btn.dataset.especie); });
  });
}

async function refrescarMercado() {
  const btn = document.getElementById('btnRefreshMercado');
  const svgHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
  btn.disabled = true;
  btn.classList.add('spinning');
  btn.innerHTML = `${svgHTML} Actualizando...`;
  try {
    const res  = await apiFetch('/api/mercado/refresh', { method: 'POST' });
    const data = await res.json();
    await cargarMercado();
    btn.classList.remove('spinning');
    btn.innerHTML = `${svgHTML} ✓ ${data.total} actualizados`;
    setTimeout(() => { btn.disabled = false; btn.innerHTML = `${svgHTML} Actualizar precios`; }, 3000);
  } catch {
    btn.classList.remove('spinning');
    btn.innerHTML = `${svgHTML} Error`;
    setTimeout(() => { btn.disabled = false; btn.innerHTML = `${svgHTML} Actualizar precios`; }, 2000);
  }
}

function abrirModalOrdenEspecie(especie) {
  document.getElementById('f-especie').value = especie;
  abrirModalOrden();
  // Trigger order book load for this especie
  clearTimeout(_obTimer);
  cargarOrderbook(especie);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRÁFICO DE PRECIOS — TradingView Lightweight Charts
// ══════════════════════════════════════════════════════════════════════════════

let _chartData       = [];
let _chartEspecie    = null;
let _chartIntervalo  = '1d';        // candle resolution
let _chartFuente     = 'mercado';   // 'mercado' | 'sistema'
let _chartIndicators = new Set(['sma20', 'sma50']);
let _lwChart         = null;
let _lwChartRsi      = null;
let _lwChartMacd     = null;
let _lwSeries        = {};

// Implied date range (days back) for each candle interval
const _TF_CONFIG = {
  '15m': { dias: 5   },
  '30m': { dias: 7   },
  '45m': { dias: 7   },
  '1h':  { dias: 30  },
  '2h':  { dias: 60  },
  '3h':  { dias: 90  },
  '4h':  { dias: 90  },
  '1d':  { dias: 90  },
  '1w':  { dias: 730 },
  '1mo': { dias: 1825 },
  '3mo': { dias: null },   // all available
};

function _intervaloFechaDesde(intervalo) {
  const cfg = _TF_CONFIG[intervalo];
  if (!cfg || !cfg.dias) return null;
  const d = new Date();
  d.setDate(d.getDate() - cfg.dias);
  return d.toISOString().slice(0, 10);
}

async function abrirModalGrafico(especie) {
  _chartEspecie   = especie;
  _chartIntervalo = '1d';
  _chartFuente    = 'mercado';
  document.getElementById('graficoEspecie').textContent = especie;
  document.getElementById('graficoPrecio').textContent  = 'Cargando...';
  document.getElementById('modalGrafico').classList.add('active');
  const sel = document.getElementById('chartIntervalo');
  if (sel) sel.value = _chartIntervalo;
  document.querySelectorAll('.chart-tf-btn[data-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === _chartFuente)
  );
  await _cargarYRenderizarGrafico();
}

async function cambiarModoGrafico(modo) {
  _chartFuente = modo;
  document.querySelectorAll('.chart-tf-btn[data-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === modo)
  );
  _destruirGraficos();
  await _cargarYRenderizarGrafico();
}

function cerrarModalGrafico(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modalGrafico').classList.remove('active');
  _destruirGraficos();
}

function _destruirGraficos() {
  if (_lwChart)     { _lwChart.remove();     _lwChart     = null; }
  if (_lwChartRsi)  { _lwChartRsi.remove();  _lwChartRsi  = null; }
  if (_lwChartMacd) { _lwChartMacd.remove(); _lwChartMacd = null; }
  _lwSeries  = {};
  _chartData = [];
}

async function cambiarIntervalo(intervalo) {
  _chartIntervalo = intervalo;
  _destruirGraficos();
  await _cargarYRenderizarGrafico();
}

function toggleIndicador(ind) {
  if (_chartIndicators.has(ind)) _chartIndicators.delete(ind);
  else _chartIndicators.add(ind);
  document.querySelectorAll('.chart-ind-btn').forEach(b => {
    if (b.dataset.ind === ind) b.classList.toggle('active', _chartIndicators.has(ind));
  });
  if (_chartData.length) _renderizarGrafico(_chartData);
}

async function _cargarYRenderizarGrafico() {
  const desde = _intervaloFechaDesde(_chartIntervalo);
  let url = `/api/prices/chart/${encodeURIComponent(_chartEspecie)}?fuente=${_chartFuente}&intervalo=${_chartIntervalo}`;
  if (desde) url += `&fecha_desde=${desde}`;

  document.getElementById('graficoPrecio').textContent = 'Cargando...';
  try {
    const res  = await apiFetch(url);
    const json = await res.json();

    if (json.sin_ticker) {
      document.getElementById('graficoPrecio').textContent =
        'Sin ticker de mercado para esta especie (modo Mercado). Usá modo Sistema.';
      return;
    }

    _chartData = json.data || [];
    if (_chartData.length === 0) {
      const msg = _chartFuente === 'sistema'
        ? 'Sin ejecuciones registradas para este período'
        : 'Sin datos históricos — probá otro intervalo o modo Sistema';
      document.getElementById('graficoPrecio').textContent = msg;
      return;
    }
    const last      = _chartData[_chartData.length - 1];
    const lastPrice = last.close ?? last.value;
    const barLabel  = _chartData.length === 1 ? 'barra' : 'barras';
    const label     = _chartFuente === 'sistema' ? 'Últ. ejec.' : 'Último';
    document.getElementById('graficoPrecio').textContent =
      `${label}: ${Number(lastPrice).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${_chartData.length} ${barLabel}`;
    _renderizarGrafico(_chartData);
  } catch {
    document.getElementById('graficoPrecio').textContent = 'Error al cargar datos';
  }
}

function _chartThemeOptions() {
  const html   = document.documentElement;
  const isDark = html.classList.contains('theme-legacy');
  const isSap  = html.classList.contains('theme-sap');
  if (isDark) return { bg: '#16162A', text: '#C8C5BC', grid: '#252538', border: '#3A3A5E' };
  if (isSap)  return { bg: '#F5F5F5', text: '#003366', grid: '#E0E8F0', border: '#B0C4D8' };
  return       { bg: '#ECE9D8',  text: '#222222', grid: '#D0CCC0', border: '#ACA899' };
}

function _makeChart(containerId, height) {
  const { bg, text, grid, border } = _chartThemeOptions();
  const el = document.getElementById(containerId);
  return LightweightCharts.createChart(el, {
    width:  el.clientWidth,
    height,
    layout:          { background: { color: bg }, textColor: text },
    grid:            { vertLines: { color: grid }, horzLines: { color: grid } },
    rightPriceScale: { borderColor: border },
    timeScale:       { borderColor: border, timeVisible: true, secondsVisible: false },
    crosshair:       { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll:    true,
    handleScale:     true,
  });
}

function _crearSeriesPrincipal(renderData, isOHLCV) {
  let priceSeries;
  if (isOHLCV) {
    priceSeries = _lwChart.addCandlestickSeries({
      upColor:        '#267326',
      downColor:      '#CC0000',
      borderUpColor:  '#267326',
      borderDownColor:'#CC0000',
      wickUpColor:    '#267326',
      wickDownColor:  '#CC0000',
    });
    priceSeries.setData(renderData.map(d => ({
      time:  d.time,
      open:  d.open,
      high:  d.high,
      low:   d.low,
      close: d.close,
    })));
    const volSeries = _lwChart.addHistogramSeries({
      priceFormat:  { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
    });
    _lwChart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.80, bottom: 0 },
    });
    volSeries.setData(renderData.map(d => ({
      time:  d.time,
      value: d.volume,
      color: d.close >= d.open ? 'rgba(38,115,38,0.50)' : 'rgba(204,0,0,0.50)',
    })));
    _lwSeries.vol = volSeries;
  } else {
    priceSeries = _lwChart.addAreaSeries({
      lineColor:        '#0054E3',
      topColor:         'rgba(0, 84, 227, 0.28)',
      bottomColor:      'rgba(0, 84, 227, 0.02)',
      lineWidth:        2,
      priceLineVisible: true,
      crosshairMarkerVisible: true,
    });
    priceSeries.setData(renderData);
  }
  _lwSeries.price = priceSeries;
  return priceSeries;
}

function _aplicarIndicadores(priceSeries, lineData) {
  const bbBadge = document.getElementById('chartBullBearPhase');
  if (bbBadge) bbBadge.style.display = 'none';
  if (_chartIndicators.has('bullbear') && !_INTRADAY_IVS.has(_chartIntervalo) && _chartFuente === 'mercado') {
    const { markers: bbMarkers, currentPhase } = _detectBullBear(lineData);
    if (bbMarkers.length) priceSeries.setMarkers(bbMarkers);
    if (bbBadge && currentPhase) {
      bbBadge.textContent = currentPhase === 'bull' ? '▲ Bull Market' : '▼ Bear Market';
      bbBadge.style.color = currentPhase === 'bull' ? '#267326' : '#CC0000';
      bbBadge.style.display = 'block';
    }
  }
  if (_chartIndicators.has('sma20')) {
    const sma = _calcSMA(lineData, 20);
    if (sma.length) {
      const s = _lwChart.addLineSeries({ color: '#FF8C00', lineWidth: 1, title: 'SMA 20', lastValueVisible: true });
      s.setData(sma);
      _lwSeries.sma20 = s;
    }
  }
  if (_chartIndicators.has('sma50')) {
    const sma = _calcSMA(lineData, 50);
    if (sma.length) {
      const s = _lwChart.addLineSeries({ color: '#267326', lineWidth: 1, title: 'SMA 50', lastValueVisible: true });
      s.setData(sma);
      _lwSeries.sma50 = s;
    }
  }
  if (_chartIndicators.has('ema20')) {
    const ema = _calcEMA(lineData, 20);
    if (ema.length) {
      const s = _lwChart.addLineSeries({
        color: '#CC0000', lineWidth: 1, title: 'EMA 20',
        lineStyle: LightweightCharts.LineStyle.Dashed,
        lastValueVisible: true,
      });
      s.setData(ema);
      _lwSeries.ema20 = s;
    }
  }
  if (_chartIndicators.has('bb')) {
    const bb = _calcBollinger(lineData, 20, 2);
    if (bb.length) {
      const dotted = LightweightCharts.LineStyle.Dotted;
      const ub = _lwChart.addLineSeries({ color: 'rgba(140, 0, 200, 0.65)', lineWidth: 1, title: 'BB+2σ', lineStyle: dotted, lastValueVisible: false });
      const mb = _lwChart.addLineSeries({ color: 'rgba(140, 0, 200, 0.90)', lineWidth: 1, title: 'BB mid', lastValueVisible: false });
      const lb = _lwChart.addLineSeries({ color: 'rgba(140, 0, 200, 0.65)', lineWidth: 1, title: 'BB-2σ', lineStyle: dotted, lastValueVisible: false });
      ub.setData(bb.map(d => ({ time: d.time, value: d.upper })));
      mb.setData(bb.map(d => ({ time: d.time, value: d.mid   })));
      lb.setData(bb.map(d => ({ time: d.time, value: d.lower })));
      _lwSeries.bb = { ub, mb, lb };
    }
  }
}

function _crearPaneRSI(lineData) {
  _lwChartRsi = _makeChart('chartRsiContainer', 120);
  const rsiData = _calcRSI(lineData, 14);
  if (rsiData.length) {
    const s = _lwChartRsi.addLineSeries({ color: '#0054E3', lineWidth: 1, title: 'RSI 14' });
    s.setData(rsiData);
    const ob = _lwChartRsi.addLineSeries({ color: 'rgba(204,0,0,0.45)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false });
    const os = _lwChartRsi.addLineSeries({ color: 'rgba(38,115,38,0.45)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false });
    ob.setData(rsiData.map(d => ({ time: d.time, value: 70 })));
    os.setData(rsiData.map(d => ({ time: d.time, value: 30 })));
    _lwSeries.rsi = s;
  }
}

function _crearPaneMACDI(lineData) {
  _lwChartMacd = _makeChart('chartMacdContainer', 120);
  const { macdLine, signalLine, histogram } = _calcMACD(lineData);
  if (macdLine.length) {
    const ms = _lwChartMacd.addLineSeries({ color: '#0054E3', lineWidth: 1, title: 'MACD' });
    const ss = _lwChartMacd.addLineSeries({ color: '#FF8C00', lineWidth: 1, title: 'Signal' });
    const hs = _lwChartMacd.addHistogramSeries({ priceFormat: { type: 'price', minMove: 0.001 }, lastValueVisible: false });
    ms.setData(macdLine);
    ss.setData(signalLine);
    hs.setData(histogram.map(d => ({
      time:  d.time,
      value: d.value,
      color: d.value >= 0 ? 'rgba(38,115,38,0.70)' : 'rgba(204,0,0,0.70)',
    })));
    _lwSeries.macd = { ms, ss, hs };
  }
}

function _renderizarGrafico(data) {
  _destruirGraficos();

  const hasRsi  = _chartIndicators.has('rsi');
  const hasMacd = _chartIndicators.has('macd');

  // Show/hide lower panes
  const rsiEl    = document.getElementById('chartRsiContainer');
  const rsiLbl   = document.getElementById('chartRsiLabel');
  const macdEl   = document.getElementById('chartMacdContainer');
  const macdLbl  = document.getElementById('chartMacdLabel');
  rsiEl.style.display   = hasRsi  ? '' : 'none';
  rsiLbl.style.display  = hasRsi  ? '' : 'none';
  macdEl.style.display  = hasMacd ? '' : 'none';
  macdLbl.style.display = hasMacd ? '' : 'none';

  // ── Main chart ────────────────────────────────────────────────────────────
  _lwChart = _makeChart('chartMainContainer', 360);

  // Use candlestick whenever data has OHLCV fields (sistema always, mercado intraday/weekly too)
  const isOHLCV = data.length > 0 && data[0].open !== undefined;

  // For sistema OHLCV: remap timestamps to sequential integers so LWC renders
  // bars without empty time gaps between sparse executions.
  // Applies to all intervals: intraday (Unix int) and daily/weekly/monthly (ISO string).
  let renderData = data;
  if (_chartFuente === 'sistema' && isOHLCV) {
    const tsLabels = data.map(d => {
      if (typeof d.time === 'number') {
        // Intraday: Unix timestamp → HH:MM
        return new Date(d.time * 1000).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
      }
      // Daily/weekly: ISO date "YYYY-MM-DD" → DD/MM
      const parts = String(d.time).split('-');
      if (parts.length === 3) {
        if (_chartIntervalo === '1mo' || _chartIntervalo === '3mo') {
          // Monthly: show MM/YY
          return `${parts[1]}/${parts[0].slice(2)}`;
        }
        return `${parts[2]}/${parts[1]}`;
      }
      return String(d.time);
    });
    renderData = data.map((d, i) => ({ ...d, time: i + 1 }));
    _lwChart.timeScale().applyOptions({
      tickMarkFormatter: t => tsLabels[t - 1] ?? '',
    });
  }

  const priceSeries = _crearSeriesPrincipal(renderData, isOHLCV);

  // Normalise data to {time, value} for all indicator calculations
  const lineData = renderData.map(d => ({ time: d.time, value: d.close ?? d.value }));
  _aplicarIndicadores(priceSeries, lineData);

  if (hasRsi)  _crearPaneRSI(lineData);
  if (hasMacd) _crearPaneMACDI(lineData);

  // ── Sync time scales across panes ─────────────────────────────────────────
  if (_lwChartRsi || _lwChartMacd) {
    _lwChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (!range) return;
      if (_lwChartRsi)  _lwChartRsi.timeScale().setVisibleLogicalRange(range);
      if (_lwChartMacd) _lwChartMacd.timeScale().setVisibleLogicalRange(range);
    });
  }

  _lwChart.timeScale().fitContent();
}

// Handle window resize while chart modal is open
window.addEventListener('resize', () => {
  if (!document.getElementById('modalGrafico')?.classList.contains('active')) return;
  const resize = (chart, id) => {
    const el = document.getElementById(id);
    if (chart && el) chart.applyOptions({ width: el.clientWidth });
  };
  resize(_lwChart,     'chartMainContainer');
  resize(_lwChartRsi,  'chartRsiContainer');
  resize(_lwChartMacd, 'chartMacdContainer');
});

// ── Bull/Bear market phase detection (classic 20% drawdown/rally rule) ────────

const _INTRADAY_IVS = new Set(['15m','30m','45m','1h','2h','3h','4h']);

function _detectBullBear(data) {
  if (data.length < 10) return { markers: [], currentPhase: null };
  const THRESHOLD = 0.20;
  const markers = [];
  let phase = null;
  let refPrice = data[0].close ?? data[0].value;

  for (let i = 1; i < data.length; i++) {
    const p = data[i].close ?? data[i].value;
    if (phase === null || phase === 'bull') {
      if (p > refPrice) {
        refPrice = p;
      } else if ((refPrice - p) / refPrice >= THRESHOLD) {
        phase = 'bear';
        markers.push({ time: data[i].time, position: 'aboveBar', color: '#CC0000', shape: 'arrowDown', text: 'Bear' });
        refPrice = p;
      }
    } else {
      if (p < refPrice) {
        refPrice = p;
      } else if ((p - refPrice) / refPrice >= THRESHOLD) {
        phase = 'bull';
        markers.push({ time: data[i].time, position: 'belowBar', color: '#267326', shape: 'arrowUp', text: 'Bull' });
        refPrice = p;
      }
    }
  }

  return { markers, currentPhase: phase };
}

// ── Technical indicator calculations ──────────────────────────────────────────

function _calcSMA(data, period) {
  if (data.length < period) return [];
  const result = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i].value;
  result.push({ time: data[period - 1].time, value: sum / period });
  for (let i = period; i < data.length; i++) {
    sum += data[i].value - data[i - period].value;
    result.push({ time: data[i].time, value: sum / period });
  }
  return result;
}

function _calcEMA(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += data[i].value;
  ema /= period;
  const result = [{ time: data[period - 1].time, value: ema }];
  for (let i = period; i < data.length; i++) {
    ema = data[i].value * k + ema * (1 - k);
    result.push({ time: data[i].time, value: ema });
  }
  return result;
}

function _calcBollinger(data, period = 20, mult = 2) {
  if (data.length < period) return [];
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j].value;
    const mean = sum / period;
    let variance = 0;
    for (let j = 0; j < period; j++) variance += (data[i - j].value - mean) ** 2;
    const std = Math.sqrt(variance / period);
    result.push({ time: data[i].time, upper: mean + mult * std, mid: mean, lower: mean - mult * std });
  }
  return result;
}

function _calcRSI(data, period = 14) {
  if (data.length < period + 1) return [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = data[i].value - data[i - 1].value;
    if (delta > 0) avgGain += delta; else avgLoss += -delta;
  }
  avgGain /= period; avgLoss /= period;
  const result = [];
  for (let i = period; i < data.length; i++) {
    if (i > period) {
      const delta = data[i].value - data[i - 1].value;
      avgGain = (avgGain * (period - 1) + Math.max(delta,  0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
    }
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    result.push({ time: data[i].time, value: 100 - 100 / (1 + rs) });
  }
  return result;
}

function _calcMACD(data, fast = 12, slow = 26, signal = 9) {
  const ema12 = _calcEMA(data, fast);
  const ema26 = _calcEMA(data, slow);
  if (!ema12.length || !ema26.length) return { macdLine: [], signalLine: [], histogram: [] };
  const offset   = ema12.length - ema26.length;
  const macdLine = ema26.map((d, i) => ({ time: d.time, value: ema12[offset + i].value - d.value }));
  const signalLine = _calcEMA(macdLine, signal);
  const sigOffset  = macdLine.length - signalLine.length;
  const histogram  = signalLine.map((d, i) => ({
    time:  d.time,
    value: macdLine[sigOffset + i].value - d.value,
  }));
  return { macdLine, signalLine, histogram };
}
