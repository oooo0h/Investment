(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const C = window.ChartCore;
  const series = [
    { key: 'market', name: 'A股大盘', index: '沪深300', code: '000300', color: '#3478db' },
    { key: 'bank', name: '银行板块', index: '中证银行', code: '399986', color: '#00988e' },
    { key: 'tech', name: '科技板块', index: '全指信息', code: '000993', color: '#8b65c8' },
    { key: 'financing', name: '融资资金比例', index: '融资买入额 / A股成交额', color: '#d88629' }
  ];
  const number = (value, digits = 2) => C.finite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
  const signed = value => C.finite(value) ? `${value > 0 ? '+' : ''}${number(value)}` : '—';
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const status = text => { $('#status').textContent = text; $('#status').hidden = !text; };
  if (!C || !window.echarts || !window.MARKET_DATA?.rows?.length) {
    status('数据或图表文件未能加载。请确认 data 和 vendor 文件夹完整后重新打开页面。');
    $('#refresh').disabled = true;
    return;
  }
  let dataset = window.MARKET_DATA;
  let rows = dataset.rows;
  let state = { selected: Object.fromEntries(C.keys.map(key => [key, true])), start: 0, end: rows.length - 1, mode: 'return', preset: 'all', tab: 'chart' };
  let normalized = C.normalize(rows, state.mode);
  let chart = echarts.init($('#chart'), null, { renderer: 'canvas' });
  let zoomTimer;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function lastValue(key) {
    for (let i = state.end; i >= state.start; i--) if (C.finite(normalized.values[key][i])) return { value: normalized.values[key][i], row: rows[i], i };
    return null;
  }

  function updateLegend() {
    for (const s of series) {
      let button = $(`[data-series="${s.key}"]`);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'series-card';
        button.dataset.series = s.key;
        button.style.setProperty('--series-color', s.color);
        button.addEventListener('click', () => {
          state.selected[s.key] = !state.selected[s.key];
          render();
        });
        $('#series-legend').append(button);
      }
      const last = lastValue(s.key);
      const isPercentage = s.key === 'financing' || state.mode === 'return';
      const formatted = s.key !== 'financing' && state.mode === 'return' ? signed(last?.value) : number(last?.value);
      button.setAttribute('aria-pressed', String(state.selected[s.key]));
      button.setAttribute('aria-label', `${s.name}，${state.selected[s.key] ? '已显示，点击隐藏' : '已隐藏，点击显示'}`);
      button.title = `${s.index}${s.code ? `（${s.code}）` : ''}；数值日期：${last?.row.date ?? '当前区间无数据'}`;
      const detail = s.key === 'financing' ? `沪深口径 · ${last?.row.date ?? '暂无数据'}` : `${s.index} · ${s.code}`;
      button.innerHTML = `<span class="series-name"><span class="legend-line"></span>${s.name}<span class="axis-badge">${s.key === 'financing' ? '右轴' : '左轴'}</span></span><span class="card-value">${formatted}<span class="value-unit">${isPercentage ? '%' : '点'}</span></span><span class="card-detail">${detail}</span>${!state.selected[s.key] ? '<span class="visibility-state">已隐藏</span>' : ''}`;
    }
    const count = C.keys.filter(k => state.selected[k]).length;
    $('#selection-count').textContent = `${count} / 4 条曲线`;
    $('#empty-state').hidden = count !== 0;
  }

  function updateLabels() {
    const start = rows[state.start].date, end = rows[state.end].date;
    $('#start-date').value = start;
    $('#end-date').value = end;
    for (const input of [$('#start-date'), $('#end-date')]) { input.min = rows[0].date; input.max = rows.at(-1).date; }
    for (const button of document.querySelectorAll('[data-range]')) {
      const active = button.dataset.range === state.preset;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    $('#value-mode').value = state.mode;
    $('#left-axis-label').textContent = state.mode === 'return' ? '左轴 · 累计涨跌幅' : '左轴 · 指数点位';
    $('#baseline-note').textContent = state.mode === 'return' ? `以 ${normalized.baseDate} 收盘为基准 · 基准日涨跌幅 0%` : '原始收盘点位 · 各指数基点不同';
    $('#as-of').textContent = `数据截至 ${dataset.meta.lastDate}`;
    $('#coverage').textContent = `${start} — ${end} · ${state.end - state.start + 1} 个交易日 · 沪深A股`;
    $('#fetched-at').textContent = `数据获取时间：${new Date(dataset.meta.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间） · 融资比例截至 ${dataset.meta.financingLastDate} · 缺失 ${dataset.meta.missingFinancingDays} 个交易日。`;
    $('#sources').innerHTML = dataset.meta.sources.map(source => `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer" title="${escape(source.fields)}">${escape(source.name)} ↗</a>`).join('');
  }

  function tooltip(params) {
    const first = params.find(p => p.seriesId && p.seriesId !== 'navigator');
    if (!first) return '';
    const i = first.dataIndex, row = rows[i];
    if (!row) return '';
    let html = `<div style="font-weight:600;margin-bottom:10px;color:#172b43">${row.date}</div>`;
    for (const s of series.filter(s => state.selected[s.key])) {
      const value = normalized.values[s.key][i];
      const label = s.key === 'financing' ? number(value) : state.mode === 'return' ? signed(value) : number(value);
      const unit = C.finite(value) ? (s.key === 'financing' || state.mode === 'return' ? '%' : ' 点') : '';
      const original = s.key !== 'financing' && state.mode === 'return' ? `<small style="color:#8996a8;font-size:11px;margin-left:8px">${number(row[s.key])} 点</small>` : '';
      html += `<div style="display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12px"><span style="width:7px;height:7px;border-radius:50%;background:${s.color}"></span><span style="min-width:90px;color:#67778d">${s.name}</span><span style="margin-left:auto;font-family:Consolas,monospace;color:${s.color}">${label}${unit}</span>${original}</div>`;
    }
    if (state.selected.financing) {
      html += `<div style="border-top:1px solid #e6ebf2;padding-top:8px;margin-top:10px;font-size:11px;color:#8693a4">${C.finite(row.financing) ? `融资买入 ${number(row.financingBuy / 1e8)} 亿 / A股成交 ${number(row.turnover / 1e8)} 亿` : '当日融资或成交额数据尚未公布'}</div>`;
    }
    return html;
  }

  function axes() {
    const scales = C.scaleForVisible(normalized.values, state.selected, state.start, state.end, state.mode);
    const make = (id, scale, side) => ({
      id, type: 'value', position: side, show: scale.hasData, scale: true,
      min: scale.min, max: scale.max, interval: scale.interval,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: side === 'right' ? '#b87a34' : '#8592a5', fontFamily: 'Consolas, monospace', fontSize: 11, margin: 13,
        formatter: value => side === 'right' || state.mode === 'return' ? `${number(value, scale.interval < 1 ? 1 : 0)}%` : number(value, 0) },
      splitLine: { show: side === 'left' || !scales.left.hasData, lineStyle: { color: '#edf0f5', type: 'dashed' } },
      axisPointer: { show: false }
    });
    return [make('indices-axis', scales.left, 'left'), make('financing-axis', scales.right, 'right')];
  }

  function renderTable() {
    const visible = series.filter(s => state.selected[s.key]);
    $('#table-head').innerHTML = `<tr><th scope="col">交易日期</th>${visible.map(s => `<th scope="col" style="color:${s.color}">${s.key === 'financing' ? `${s.name} (%)` : `${s.index} (点)`}</th>`).join('')}</tr>`;
    $('#table-body').innerHTML = rows.slice(state.start, state.end + 1).reverse().map(row => `<tr><td>${row.date}</td>${visible.map(s => `<td>${number(row[s.key])}</td>`).join('')}</tr>`).join('');
    $('#table-count').textContent = `共 ${state.end - state.start + 1} 个交易日 · 最新日期在前`;
  }

  function render({ zoomOnly = false } = {}) {
    updateLegend();
    updateLabels();
    if (state.tab === 'table') renderTable();
    const mobile = window.innerWidth < 760;
    const currentAxes = axes();
    $('#chart').setAttribute('aria-label', `双纵轴折线图。${rows[state.start].date}至${rows[state.end].date}。${currentAxes[0].show ? `左轴范围${currentAxes[0].min}至${currentAxes[0].max}${state.mode === 'return' ? '%' : '点'}。` : '左轴已隐藏。'}${currentAxes[1].show ? `右轴范围${currentAxes[1].min}至${currentAxes[1].max}%。` : '右轴已隐藏。'}可用上方图例和日期控件调整，或切换数据明细读取数值。`);
    if (zoomOnly) { chart.setOption({ yAxis: currentAxes, series: series.map(s => ({ id: s.key, showSymbol: state.end - state.start < 2 })) }); return; }
    chart.setOption({
      animation: !reducedMotion, animationDuration: 400, animationDurationUpdate: reducedMotion ? 0 : 220,
      backgroundColor: '#fff', textStyle: { fontFamily: 'Microsoft YaHei UI, sans-serif' },
      grid: { left: mobile ? 50 : 67, right: mobile ? 51 : 69, top: 27, bottom: 105 },
      legend: { show: false, selected: Object.fromEntries(series.map(s => [s.name, state.selected[s.key]])) },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: '#fffffffa', borderColor: '#e1e7ef', borderWidth: 1,
        padding: [13, 16], extraCssText: 'border-radius:8px;box-shadow:0 8px 32px #18375616;',
        axisPointer: { type: 'line', lineStyle: { color: '#a8b9ce', type: 'dashed' } }, formatter: tooltip },
      xAxis: { type: 'category', boundaryGap: false, data: rows.map(row => row.date), axisLine: { lineStyle: { color: '#e3e9f1' } },
        axisTick: { show: false }, axisPointer: { label: { backgroundColor: '#233e60' } },
        axisLabel: { color: '#8290a3', fontFamily: 'Consolas, monospace', fontSize: mobile ? 10 : 11, margin: 16,
          hideOverlap: true, formatter: value => value.slice(0, 7).replace('-', '/') }, splitLine: { show: false } },
      yAxis: currentAxes,
      dataZoom: [
        { id: 'navigator', type: 'slider', xAxisIndex: 0, startValue: state.start, endValue: state.end,
          filterMode: 'none', left: mobile ? 50 : 67, right: mobile ? 51 : 69, bottom: 26, height: 33,
          brushSelect: false, minValueSpan: 0, realtime: true, borderColor: '#e1e7ef', backgroundColor: '#f7f9fc',
          fillerColor: '#d8e6fa66', dataBackground: { lineStyle: { color: '#a5b6ce', width: 1 }, areaStyle: { color: '#d9e2ef', opacity: 0.35 } },
          selectedDataBackground: { lineStyle: { color: '#7c9ac3', width: 1 }, areaStyle: { color: '#dce7f6', opacity: 0.5 } },
          handleStyle: { color: '#fff', borderColor: '#a8bad4', borderWidth: 1 }, handleSize: '110%',
          moveHandleSize: 0, showDetail: false, showDataShadow: 'auto' },
        { id: 'inside', type: 'inside', xAxisIndex: 0, startValue: state.start, endValue: state.end, filterMode: 'none',
          zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: true, preventDefaultMouseMove: false, minValueSpan: 0 }
      ],
      series: series.map(s => ({ id: s.key, name: s.name, type: 'line', yAxisIndex: s.key === 'financing' ? 1 : 0,
        data: normalized.values[s.key], showSymbol: state.end - state.start < 2, symbol: 'circle', symbolSize: 6,
        smooth: false, connectNulls: false, clip: true,
        lineStyle: { color: s.color, width: s.key === 'financing' ? 1.65 : 2.15, type: s.key === 'financing' ? 'dashed' : 'solid', opacity: s.key === 'financing' ? 0.78 : 1 },
        itemStyle: { color: s.color }, emphasis: { focus: 'series', lineStyle: { width: 3 } },
        z: s.key === 'financing' ? 2 : 3
      }))
    }, { notMerge: true });
  }

  chart.on('datazoom', event => {
    const payload = event.batch?.[0] ?? event;
    const zoom = chart.getOption().dataZoom[0];
    const toIndex = value => typeof value === 'string' ? rows.findIndex(row => row.date === value) : Number(value);
    let start = payload.startValue !== undefined ? toIndex(payload.startValue) : Math.round((payload.start ?? zoom.start) / 100 * (rows.length - 1));
    let end = payload.endValue !== undefined ? toIndex(payload.endValue) : Math.round((payload.end ?? zoom.end) / 100 * (rows.length - 1));
    start = Math.max(0, Math.min(rows.length - 1, start));
    end = Math.max(start, Math.min(rows.length - 1, end));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    state.start = start; state.end = end; state.preset = null;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => render({ zoomOnly: true }), 35);
  });

  $('#presets').addEventListener('click', event => {
    const button = event.target.closest('[data-range]');
    if (!button) return;
    const end = rows.at(-1).date;
    const date = new Date(`${end}T12:00:00Z`);
    if (button.dataset.range === 'ytd') { date.setUTCMonth(0, 1); }
    else if (button.dataset.range !== 'all') {
      const month = { '1y': 12, '6m': 6, '3m': 3 }[button.dataset.range];
      const originalDay = date.getUTCDate();
      date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - month);
      const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(originalDay, daysInMonth));
    }
    const start = button.dataset.range === 'all' ? rows[0].date : date.toISOString().slice(0, 10);
    const range = C.rangeForDates(rows, start, end);
    if (!range) return;
    [state.start, state.end] = range; state.preset = button.dataset.range; status(''); render();
  });
  for (const input of [$('#start-date'), $('#end-date')]) input.addEventListener('change', () => {
    const start = $('#start-date').value, end = $('#end-date').value;
    if (!start || !end) { status('请选择完整的开始日期和结束日期。'); return; }
    if (start > end) { status('开始日期不能晚于结束日期。'); return; }
    const range = C.rangeForDates(rows, start, end);
    if (!range) { status('这个区间没有交易数据，请选择其他日期。'); return; }
    [state.start, state.end] = range; state.preset = null; status(''); render();
  });
  $('#value-mode').addEventListener('change', () => { state.mode = $('#value-mode').value; normalized = C.normalize(rows, state.mode); render(); });
  $('#reset').addEventListener('click', () => {
    state.selected = Object.fromEntries(C.keys.map(key => [key, true])); state.start = 0; state.end = rows.length - 1;
    state.mode = 'return'; state.preset = 'all'; normalized = C.normalize(rows, state.mode); status(''); render();
  });
  $('#show-all').addEventListener('click', () => { state.selected = Object.fromEntries(C.keys.map(key => [key, true])); render(); });
  function switchTab(tab) {
    state.tab = tab;
    for (const name of ['chart', 'table']) {
      const active = name === tab;
      $(`#${name}-tab`).classList.toggle('active', active);
      $(`#${name}-tab`).setAttribute('aria-selected', String(active));
      $(`#${name}-tab`).tabIndex = active ? 0 : -1;
      $(`#${name}-view`).hidden = !active;
    }
    if (tab === 'table') renderTable(); else chart.resize();
  }
  for (const name of ['chart', 'table']) {
    $(`#${name}-tab`).addEventListener('click', () => switchTab(name));
    $(`#${name}-tab`).addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 'chart' : event.key === 'End' ? 'table' : name === 'chart' ? 'table' : 'chart';
        switchTab(next); $(`#${next}-tab`).focus();
      }
    });
  }
  $('#open-method').addEventListener('click', () => {
    $('#method').open = !$('#method').open;
    if ($('#method').open) $('#method').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
  });
  $('#refresh').addEventListener('click', async () => {
    if (location.protocol === 'file:') { status('当前使用离线文件。运行“启动图表.cmd”后打开本地页面，即可联网更新数据。'); return; }
    const button = $('#refresh'); button.disabled = true;
    status('正在获取公开历史数据，通常需要约半分钟…');
    try {
      const response = await fetch('/api/refresh', { method: 'POST', signal: AbortSignal.timeout(300000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '数据源暂时不可用');
      const start = rows[state.start].date, end = rows[state.end].date, followLatest = state.end === rows.length - 1;
      dataset = result; rows = dataset.rows; normalized = C.normalize(rows, state.mode);
      [state.start, state.end] = C.rangeForDates(rows, start, followLatest ? rows.at(-1).date : end) ?? [0, rows.length - 1];
      render(); status(`数据已更新，最新完整交易日为 ${dataset.meta.lastDate}。`);
    } catch (error) { status(`更新未完成，继续显示已保存的数据。${error.name === 'TimeoutError' ? '请求超时，请稍后重试。' : error.message}`); }
    finally { button.disabled = false; }
  });
  new ResizeObserver(() => {
    if (state.tab !== 'chart') return;
    chart.resize();
    const mobile = window.innerWidth < 760;
    chart.setOption({ grid: { left: mobile ? 50 : 67, right: mobile ? 51 : 69 }, dataZoom: [{ id: 'navigator', left: mobile ? 50 : 67, right: mobile ? 51 : 69 }] });
  }).observe($('#chart'));
  render();
})();
