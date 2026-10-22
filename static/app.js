"use strict";

const css = getComputedStyle(document.documentElement);
const v = (name) => css.getPropertyValue(name).trim();
const COLORS = {
  actual: v("--actual"), champion: v("--champion"), baseline: v("--baseline"), whatif: v("--whatif"),
  championFaded: "rgba(42, 120, 214, 0.35)", whatifWash: "rgba(27, 175, 122, 0.14)",
  grid: "#ecebe7", muted: "#52514e", residual: "#c9c8c3", residualOn: "#52514e",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// What-if offset ranges, in each feature's physical unit
const OFFSET_RANGE = {
  shortwave_radiation: 600, cloud_cover: 100, temperature_2m: 15,
  precipitation: 10, relative_humidity_2m: 50, wind_speed_10m: 20,
};
// Illustrative weather changes, applied on top of the real weather
const PRESETS = [
  { name: "Clear sky", set: { cloud_cover: -100, shortwave_radiation: 150 } },
  { name: "Overcast", set: { cloud_cover: 70, shortwave_radiation: -300 } },
  { name: "Rainy", set: { cloud_cover: 80, shortwave_radiation: -400, precipitation: 3, relative_humidity_2m: 30 } },
  { name: "Heatwave", set: { temperature_2m: 10, relative_humidity_2m: -20 } },
];
const DEFAULTS = { site: 0, month: 0, hour_shift: 0, export_pct: 100 };

const $ = (id) => document.getElementById(id);
const state = {
  weather: [], sources: {}, source: "builtin", site: null, hours: 72,
  data: null, scenario: null, selected: null, overrides: {},
};

// Timestamps stay naive local strings ("2025-12-31T23:00") end to end.
const toMs = (iso) => new Date(iso.slice(0, 16) + "Z").getTime();
const addHours = (iso, h) => new Date(toMs(iso) + h * 3600e3).toISOString().slice(0, 16);
const spanHours = (a, b) => Math.round((toMs(b) - toMs(a)) / 3600e3) + 1;
const fmtDay = (iso) => `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}`;
const fmtTime = (iso) => `${fmtDay(iso)} ${iso.slice(11, 16)}`;
const fmt = (x, d = 1) => (x === null || x === undefined ? "n/a" : x.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (x, d = 1) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x), d)}`;
const pct = (now, was) => (was ? ((now - was) / Math.abs(was)) * 100 : 0);
const sum = (a) => a.reduce((s, x) => s + x, 0);

async function api(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

let toastTimer = null;
function showError(msg) {
  $("error").textContent = msg || "";
  $("error").hidden = !msg;
  clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(() => { $("error").hidden = true; }, 6000);
}

// ---------------------------------------------------------------- what-if state

const isChanged = (key) => state.overrides[key] !== (DEFAULTS[key] ?? 0);
const changedKeys = () => Object.keys(state.overrides).filter(isChanged);
const scenarioActive = () => changedKeys().length > 0;

function resetOverrides() {
  state.overrides = { ...DEFAULTS };
  state.weather.forEach((w) => { state.overrides[w.col] = 0; });
}

function overridesForApi() {
  const o = { ...state.overrides, export_scale: state.overrides.export_pct / 100 };
  delete o.export_pct;
  return o;
}

// ---------------------------------------------------------------- charts

// Hover crosshair, plus the selected hour: a line, dots on the forecasts and a time tag
const guides = {
  id: "guides",
  afterDatasetsDraw(chart) {
    const { ctx, chartArea: a, scales: { x } } = chart;
    const vline = (i, color) => {
      const px = x.getPixelForValue(i);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, a.top);
      ctx.lineTo(px, a.bottom);
      ctx.stroke();
      ctx.restore();
    };
    const active = chart.tooltip?.getActiveElements();
    if (active?.length) vline(active[0].index, "#0b0b0b22");
    const i = state.selected;
    if (i === null || !state.data) return;
    vline(i, "#0b0b0b66");
    if (chart.config.type !== "line") return;

    chart.data.datasets.forEach((ds, k) => {
      if (!ds.marker || chart.getDatasetMeta(k).hidden) return;
      const el = chart.getDatasetMeta(k).data[i];
      if (!el) return;
      ctx.save();
      ctx.beginPath();
      ctx.arc(el.x, el.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = ds.marker;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });

    const label = fmtTime(state.data.timestamps[i]);
    ctx.save();
    ctx.font = "600 11px system-ui, sans-serif";
    const w = ctx.measureText(label).width + 12;
    const px = Math.min(Math.max(x.getPixelForValue(i) - w / 2, a.left), a.right - w);
    ctx.fillStyle = "#0b0b0b";
    ctx.beginPath();
    ctx.roundRect(px, a.top - 20, w, 18, 4);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, px + 6, a.top - 11);
    ctx.restore();
  },
};

// Tick every `step` hours; dates at midnight, times otherwise
function tickStep(n) {
  if (n <= 30) return 3;
  if (n <= 80) return 6;
  if (n <= 200) return 12;
  return 24 * Math.ceil(n / 24 / 10);
}
function tickLabel(i) {
  const ts = state.data.timestamps;
  const step = tickStep(ts.length);
  const hour = +ts[i].slice(11, 13);
  if (step <= 24) return hour % step === 0 ? (hour === 0 ? fmtDay(ts[i]) : ts[i].slice(11, 16)) : null;
  const day = Math.round((toMs(ts[i]) - toMs(ts[0].slice(0, 11) + "00:00")) / 864e5);
  return hour === 0 && day % (step / 24) === 0 ? fmtDay(ts[i]) : null;
}
const isMidnight = (i) => state.data && state.data.timestamps[i]?.slice(11, 13) === "00";

const baseOptions = () => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  interaction: { mode: "index", intersect: false },
  layout: { padding: { top: 22 } },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "#fff", titleColor: "#52514e", bodyColor: "#0b0b0b",
      borderColor: "#d3d2cd", borderWidth: 1, padding: 10, boxPadding: 6, boxWidth: 14, boxHeight: 2,
      bodyFont: { weight: "600" }, titleFont: { weight: "500" },
      callbacks: {
        title: (items) => fmtTime(state.data.timestamps[items[0].dataIndex]),
        label: (item) => ` ${fmt(item.parsed.y)} kWh  ${item.dataset.label}`,
        labelColor: (item) => ({ borderColor: item.dataset.borderColor, backgroundColor: item.dataset.borderColor }),
      },
    },
  },
  scales: {
    x: {
      grid: { color: (c) => (isMidnight(c.index) ? COLORS.grid : "transparent"), drawTicks: false },
      ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: false, padding: 6, callback: tickLabel },
    },
    y: { grid: { color: COLORS.grid }, border: { display: false }, ticks: { color: COLORS.muted } },
  },
});

const mainChart = new Chart($("chart"), {
  type: "line",
  data: { labels: [], datasets: [] },
  options: {
    ...baseOptions(),
    onClick: (evt, _els, chart) => {
      const hit = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
      if (hit.length) select(hit[0].index);
    },
    onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; },
  },
  plugins: [guides],
});
mainChart.options.scales.y.title = { display: true, text: "kWh", color: COLORS.muted };

const residualChart = new Chart($("residual"), {
  type: "bar",
  data: { labels: [], datasets: [] },
  options: {
    ...baseOptions(),
    layout: { padding: 0 },
    onClick: (evt, _els, chart) => {
      const hit = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
      if (hit.length) select(hit[0].index);
    },
  },
  plugins: [guides],
});
residualChart.options.scales.x.ticks.display = false;
residualChart.options.scales.y.ticks.maxTicksLimit = 3;

const line = (label, data, color, extra = {}) => ({
  label, data, borderColor: color, backgroundColor: color, borderWidth: 2,
  pointRadius: 0, pointHoverRadius: 4, tension: 0, ...extra,
});

function drawCharts() {
  const d = state.data;
  const sc = state.scenario;
  const showBaseline = $("baseline").checked;
  const sets = [
    line("Actual", d.actual, COLORS.actual),
    line("Champion", d.series.champion, sc ? COLORS.championFaded : COLORS.champion, { marker: sc ? null : COLORS.champion }),
  ];
  if (showBaseline) sets.push(line("Baseline BiLSTM", d.series.baseline, COLORS.baseline, { borderDash: [5, 4], borderWidth: 1.5 }));
  if (sc) {
    sets.push(line("What-if (Champion)", sc.champion, COLORS.whatif, {
      borderWidth: 2.5, marker: COLORS.whatif,
      fill: { target: 1, above: COLORS.whatifWash, below: COLORS.whatifWash },
    }));
  }
  const labels = d.timestamps.map((_, i) => i);
  mainChart.data = { labels, datasets: sets };
  mainChart.update();

  residualChart.data = {
    labels,
    datasets: [{
      label: "Residual", data: d.actual.map((a, i) => a - d.series.champion[i]),
      backgroundColor: (c) => (c.dataIndex === state.selected ? COLORS.residualOn : COLORS.residual),
      barPercentage: 1, categoryPercentage: 0.85, borderRadius: 2,
    }],
  };
  residualChart.update();

  const key = (cls, style, text) => `<span><i class="sw ${cls}" style="${style}"></i>${text}</span>`;
  $("legend").innerHTML = [
    key("", `border-color:${COLORS.actual}`, "Actual"),
    key(sc ? "faded" : "", `border-color:${COLORS.champion}`, sc ? "Champion (original)" : "Champion (Trial #101)"),
    showBaseline ? key("dashed", `border-color:${COLORS.baseline}`, "Baseline BiLSTM") : "",
    sc ? key("thick", `border-color:${COLORS.whatif}`, "<b>What-if</b> (Champion)") : "",
  ].join("");
}

// ---------------------------------------------------------------- summaries

function drawKpis() {
  const m = state.data.metrics;
  $("k-rmse").textContent = fmt(m.champion.rmse);
  const gain = pct(m.champion.rmse, m.baseline.rmse);
  $("k-gain").textContent = `${fmt(Math.abs(gain), 0)}% ${gain <= 0 ? "lower" : "higher"} error`;
  $("k-gain-sub").textContent = `Baseline RMSE ${fmt(m.baseline.rmse)} kWh`;
  $("k-r2").textContent = fmt(m.champion.r2, 3);
  $("k-r2-sub").textContent = `Baseline ${fmt(m.baseline.r2, 3)} · 1.0 is perfect`;
  const actual = sum(state.data.actual);
  const pred = sum(state.data.series.champion);
  $("k-energy").textContent = fmt(actual, 0);
  $("k-energy-sub").textContent = `Champion predicted ${fmt(pred, 0)} (${signed(pct(pred, actual), 1)}%)`;

  $("metrics").innerHTML = [["Champion (Trial #101)", m.champion], ["Baseline BiLSTM", m.baseline]].map(([n, x]) =>
    `<tr><td>${n}</td><td>${fmt(x.mse, 0)}</td><td>${fmt(x.rmse)}</td><td>${fmt(x.mae)}</td><td>${fmt(x.r2, 3)}</td></tr>`).join("");
}

function drawTable() {
  const d = state.data;
  const sc = state.scenario;
  const cols = ["Hour", "Actual", "Champion", "Baseline", ...(sc ? ["What-if Champion", "What-if Baseline"] : [])];
  $("table").innerHTML =
    `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>` +
    d.timestamps.map((t, i) => {
      const cells = [d.actual[i], d.series.champion[i], d.series.baseline[i], ...(sc ? [sc.champion[i], sc.baseline[i]] : [])];
      return `<tr><td>${t.slice(0, 16).replace("T", " ")}</td>${cells.map((c) => `<td>${fmt(c)}</td>`).join("")}</tr>`;
    }).join("") + "</tbody>";
}

function drawReadout() {
  const d = state.data;
  const sc = state.scenario;
  const i = state.selected;
  const rows = [];
  const row = (k, val) => rows.push(`<span>${k}</span><b>${val}</b>`);
  const was = d.series.champion[i];
  const now = sc ? sc.champion[i] : was;

  $("ro-label").textContent = `Champion forecast · Site ${state.site}, ${fmtTime(d.timestamps[i])}`;
  $("ro-value").textContent = fmt(now);
  $("ro-delta").hidden = !sc;
  if (sc) {
    $("ro-delta").textContent = `${now >= was ? "▲" : "▼"} ${signed(now - was)} kWh`;
    row("Without changes", `${fmt(was)} kWh`);
  }
  row("Actual", `${fmt(d.actual[i])} kWh`);
  if ($("baseline").checked) {
    const bw = d.series.baseline[i];
    row("Baseline BiLSTM", sc ? `${fmt(bw)} → ${fmt(sc.baseline[i])} kWh` : `${fmt(bw)} kWh`);
  }
  if (sc) {
    const tw = sum(d.series.champion);
    const tn = sum(sc.champion);
    row("Whole period", `${fmt(tw, 0)} → ${fmt(tn, 0)} kWh (${signed(pct(tn, tw), 1)}%)`);
  } else {
    const miss = was - d.actual[i];
    row(miss >= 0 ? "Over-predicted by" : "Under-predicted by", `${fmt(Math.abs(miss))} kWh`);
  }
  $("ro-rows").innerHTML = rows.join("");
}

function drawPeriod() {
  const from = $("from").value;
  const to = $("to").value;
  const year = to.slice(0, 4);
  let text;
  if (from.slice(0, 10) === to.slice(0, 10)) text = `${fmtDay(from)} ${year}`;
  else if (from.slice(0, 7) === to.slice(0, 7)) text = `${+from.slice(8, 10)} to ${fmtDay(to)} ${year}`;
  else text = `${fmtDay(from)} to ${fmtDay(to)} ${year}`;
  $("period").textContent = text;
  const m = siteMeta();
  $("prev").disabled = from <= m.start.slice(0, 16);
  $("next").disabled = to >= m.end.slice(0, 16);
}

function drawAll() {
  if (!state.data) return;
  drawCharts();
  drawKpis();
  drawReadout();
  drawTable();
  drawSliderState();
}

// ---------------------------------------------------------------- what-if controls

function sliderDefs() {
  const weather = state.weather.map((w) => ({
    key: w.col, label: w.label, min: -OFFSET_RANGE[w.col], max: OFFSET_RANGE[w.col], step: w.step, group: "weather",
    show: (x) => (x === 0 ? "as recorded" : `${x > 0 ? "+" : "−"}${Math.abs(x)} ${w.unit}`),
    avg: () => `avg ${fmt(state.data.means[w.col], w.unit === "%" || w.unit === "W/m²" ? 0 : 1)} ${w.unit}`,
  }));
  return weather.concat([
    {
      key: "hour_shift", label: "Clock shift", min: -12, max: 12, step: 1, group: "context",
      show: (x) => (x === 0 ? "none" : `${x > 0 ? "+" : "−"}${Math.abs(x)} h`),
      avg: () => "",
    },
    {
      key: "export_pct", label: "Recent export", min: 0, max: 150, step: 5, group: "context",
      show: (x) => (x === 100 ? "as recorded" : `${x}%`),
      avg: () => `avg ${fmt(state.data.means.export, 0)} kWh`,
    },
  ]);
}

function buildControls() {
  const html = (s) => `
    <div class="slider" id="row-${s.key}">
      <label for="s-${s.key}">${s.label} <span class="avg" id="a-${s.key}"></span><span class="val" id="v-${s.key}"></span></label>
      <input type="range" id="s-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}"
        title="Double-click to reset">
    </div>`;
  const defs = sliderDefs();
  $("weather-sliders").innerHTML = defs.filter((s) => s.group === "weather").map(html).join("");
  $("context-sliders").innerHTML = defs.filter((s) => s.group === "context").map(html).join("");
  $("context-sliders").className = "sliders";
  defs.forEach((s) => {
    const el = $(`s-${s.key}`);
    el.addEventListener("input", () => { state.overrides[s.key] = +el.value; onOverridesChanged(); });
    el.addEventListener("dblclick", () => { state.overrides[s.key] = DEFAULTS[s.key] ?? 0; onOverridesChanged(); });
  });

  $("presets").innerHTML = "";
  PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = p.name;
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") === "true";
      state.weather.forEach((w) => { state.overrides[w.col] = on ? 0 : (p.set[w.col] ?? 0); });
      onOverridesChanged();
    });
    $("presets").append(b);
  });

  for (let s = 1; s <= 7; s++) $("o-site").append(new Option(`Site ${s}`, s));
  MONTHS.forEach((m, k) => $("o-month").append(new Option(m, k + 1)));
  ["site", "month"].forEach((k) => $(`o-${k}`).addEventListener("change", () => {
    state.overrides[k] = +$(`o-${k}`).value;
    onOverridesChanged();
  }));
}

// Sync every control to state.overrides, fill each track from its default to its value
function drawSliderState() {
  sliderDefs().forEach((s) => {
    const el = $(`s-${s.key}`);
    const val = state.overrides[s.key];
    el.value = val;
    const at = (x) => ((x - s.min) / (s.max - s.min)) * 100;
    const a = at(DEFAULTS[s.key] ?? 0);
    const b = at(val);
    el.style.setProperty("--lo", `${Math.min(a, b)}%`);
    el.style.setProperty("--hi", `${Math.max(a, b)}%`);
    $(`v-${s.key}`).textContent = s.show(val);
    $(`a-${s.key}`).textContent = state.data ? s.avg() : "";
    $(`row-${s.key}`).classList.toggle("changed", isChanged(s.key));
  });
  $("o-site").value = state.overrides.site;
  $("o-month").value = state.overrides.month;

  [...$("presets").children].forEach((b, k) => {
    const p = PRESETS[k];
    const match = state.weather.every((w) => state.overrides[w.col] === (p.set[w.col] ?? 0));
    b.setAttribute("aria-pressed", String(match));
  });
  const ctx = ["site", "month", "hour_shift", "export_pct"].filter(isChanged).length;
  $("ctx-count").hidden = !ctx;
  $("ctx-count").textContent = `${ctx} changed`;
  $("wi-reset").disabled = !scenarioActive();
}

let scenarioTimer = null;
function onOverridesChanged() {
  drawSliderState();
  clearTimeout(scenarioTimer);
  scenarioTimer = setTimeout(refreshScenario, 60);
}

let scenarioNo = 0;
async function fetchScenario() {
  if (!scenarioActive()) return null;
  const r = await api("/api/scenario", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...rangeParams(), mask: $("mask").checked, overrides: overridesForApi() }),
  });
  return r.series;
}

async function refreshScenario() {
  const mine = ++scenarioNo;
  let sc;
  try {
    sc = await fetchScenario();
  } catch (e) {
    showError(e.message);
    return;
  }
  if (mine !== scenarioNo) return; // a newer slider move already answered
  state.scenario = sc;
  drawAll();
}

// ---------------------------------------------------------------- data loading

const siteMeta = () => state.sources[state.source].sites.find((s) => s.site === state.site);
const rangeParams = () => ({ source: state.source, site: state.site, start: $("from").value, end: $("to").value });

function fillSources() {
  $("source").innerHTML = "";
  Object.entries(state.sources).forEach(([k, s]) => $("source").append(new Option(s.name, k)));
  $("source").value = state.source;
}

function fillSites() {
  const sites = state.sources[state.source].sites.map((s) => s.site);
  if (!sites.includes(state.site)) state.site = sites[0];
  $("sites").innerHTML = "";
  sites.forEach((s) => {
    const b = document.createElement("button");
    b.textContent = s;
    b.title = `Site ${s}`;
    b.setAttribute("aria-pressed", String(s === state.site));
    b.addEventListener("click", () => {
      state.site = s;
      [...$("sites").children].forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      setWindow($("from").value, spanHours($("from").value, $("to").value));
      loadForecast();
    });
    $("sites").append(b);
  });
}

// Place a window of `hours` starting at `from`, kept inside the site's data
function setWindow(from, hours) {
  const m = siteMeta();
  const first = m.start.slice(0, 16);
  const last = m.end.slice(0, 16);
  if (!from || from < first) from = first;
  let to = addHours(from, hours - 1);
  if (to > last) {
    to = last;
    from = addHours(to, -(hours - 1));
    if (from < first) from = first;
  }
  $("from").value = from;
  $("to").value = to;
}

function showLatest() {
  setWindow(addHours(siteMeta().end.slice(0, 16), -(state.hours - 1)), state.hours);
}

function markRange(hours) {
  document.querySelectorAll("#ranges button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.hours === hours)));
  $("custom").hidden = hours !== 0;
}

let loadNo = 0;
async function loadForecast() {
  showError("");
  drawPeriod();
  const keep = state.data && state.selected !== null ? state.data.timestamps[state.selected] : null;
  const mine = ++loadNo;
  const q = new URLSearchParams({ ...rangeParams(), mask: $("mask").checked ? "1" : "0" });
  $("chart-card").classList.add("loading");
  let data, sc;
  try {
    [data, sc] = await Promise.all([api(`/api/forecast?${q}`), fetchScenario()]);
  } catch (e) {
    if (mine === loadNo) {
      showError(e.message);
      $("chart-card").classList.remove("loading");
    }
    return;
  }
  if (mine !== loadNo) return;
  $("chart-card").classList.remove("loading");
  state.data = data;
  state.scenario = sc;
  const kept = keep ? data.timestamps.indexOf(keep) : -1;
  // Otherwise start on the hour with the most export, where there is most to see
  state.selected = kept >= 0 ? kept : data.actual.indexOf(Math.max(...data.actual));
  drawAll();
}

function select(i) {
  if (!state.data) return;
  state.selected = Math.max(0, Math.min(state.data.timestamps.length - 1, i));
  mainChart.update();
  residualChart.update();
  drawReadout();
}

function page(dir) {
  const from = $("from").value;
  const span = spanHours(from, $("to").value);
  setWindow(addHours(from, dir * span), span);
  loadForecast();
}

// ---------------------------------------------------------------- wiring

$("ranges").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const h = +b.dataset.hours;
  markRange(h);
  if (!h) return; // Custom: just reveal the From/To inputs
  state.hours = h;
  // Keep the end of the current view, aligned to the end of its day
  const end = $("to").value.slice(0, 11) + "23:00";
  setWindow(addHours(end, -(h - 1)), h);
  loadForecast();
});
["from", "to"].forEach((id) => $(id).addEventListener("change", loadForecast));
$("prev").addEventListener("click", () => page(-1));
$("next").addEventListener("click", () => page(1));
$("random").addEventListener("click", () => {
  const m = siteMeta();
  const span = spanHours($("from").value, $("to").value);
  const days = Math.floor((toMs(m.end) - toMs(m.start)) / 864e5);
  const day = Math.floor(Math.random() * Math.max(1, days - Math.ceil(span / 24)));
  setWindow(addHours(m.start.slice(0, 11) + "00:00", (day + 1) * 24), span);
  loadForecast();
});
$("source").addEventListener("change", () => {
  state.source = $("source").value;
  fillSites();
  showLatest();
  loadForecast();
});
$("baseline").addEventListener("change", drawAll);
$("mask").addEventListener("change", loadForecast);
$("wi-reset").addEventListener("click", () => { resetOverrides(); onOverridesChanged(); });

document.addEventListener("keydown", (e) => {
  if (!state.data || e.target.closest?.("input, select, textarea") || e.altKey || e.ctrlKey || e.metaKey) return;
  const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (!dir) return;
  e.preventDefault();
  if (e.shiftKey) {
    if (!$(dir < 0 ? "prev" : "next").disabled) page(dir);
  } else {
    select(state.selected + dir);
  }
});

$("file").addEventListener("change", async () => {
  const f = $("file").files[0];
  if (!f) return;
  showError("");
  const form = new FormData();
  form.append("file", f);
  try {
    const m = await api("/api/upload", { method: "POST", body: form });
    state.sources[m.source] = m;
    state.source = m.source;
    fillSources();
    fillSites();
    showLatest();
    await loadForecast();
  } catch (e) {
    showError(e.message);
  } finally {
    $("file").value = "";
  }
});

(async function init() {
  const m = await api("/api/meta");
  state.weather = m.weather;
  state.sources.builtin = m;
  resetOverrides();
  fillSources();
  fillSites();
  buildControls();
  markRange(state.hours);
  showLatest();
  drawSliderState();
  loadForecast();
})();
