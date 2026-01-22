const $ = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);

const STORAGE_KEYS = {
  SETTINGS: "goldwise_settings_goldapi_v1",
  DAYSTATS: "goldwise_day_stats_v1",
  HISTORY: "goldwise_price_history_v1"
};

const DEFAULT_SETTINGS = { defaultCity: "Srinagar" };
const BASE_URL = location.hostname.includes("localhost")
  ? "http://localhost:5050"
  : "https://YOUR-RENDER-URL.onrender.com";


const CITIES = [
  { name: "Srinagar", type: "J&K", premium: 1.0 },
  { name: "Jammu", type: "J&K", premium: 1.01 },
  { name: "Anantnag", type: "J&K", premium: 1.02 },
  { name: "Baramulla", type: "J&K", premium: 1.015 },
  { name: "Sopore", type: "J&K", premium: 1.017 }
];

function loadSettings() {
  const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
}
function saveSettings(s) {
  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(s));
}

function moneyINR(n) {
  return `₹ ${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function moneyUSD(n) {
  return `$ ${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
function gramFromTola(t) {
  return t * 11.6638038;
}
function cityPremium(cityName) {
  const c = CITIES.find((x) => x.name === cityName);
  return c ? c.premium : 1.0;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/* ---------------- NEWS (tabs + breaking + time ago) ---------------- */
let NEWS_ACTIVE_CATEGORY = "kashmir";

function timeAgo(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";

  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;

  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

async function loadNews(category = NEWS_ACTIVE_CATEGORY) {
  try {
    NEWS_ACTIVE_CATEGORY = category;

	const url = `${BASE_URL}/api/news?category=${encodeURIComponent(category)}&ts=${Date.now()}`;

    const r = await fetch(url, { cache: "no-store" });
    const data = await r.json();

    if (!data.ok) throw new Error(data.error || "News failed");

    if ($("#newsUpdated")) {
      $("#newsUpdated").textContent =
        `Updated: ${new Date(data.updatedAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }

    // ✅ LIMIT TO ONLY 3
    const top = (data.articles || []).slice(0, 3);

    if (!top.length) {
      $("#newsTicker").innerHTML = `<div class="muted">No relevant news found right now.</div>`;
      return;
    }

    const html = top
      .map((a, i) => {
        const badge =
          i === 0
            ? `<span class="news-badge breaking">BREAKING</span>`
            : `<span class="news-badge">NEWS</span>`;

        const ago = timeAgo(a.publishedAt);

        return `
          <div class="news-line">
            ${badge}
            <div>
              <a href="${a.url}" target="_blank" rel="noopener">${a.title}</a>
              <div class="news-meta">${a.source || "Source"}${ago ? " • " + ago : ""}</div>
            </div>
          </div>
        `;
      })
      .join("");

    $("#newsTicker").innerHTML = html;
  } catch (e) {
    const el = $("#newsTicker");
    if (el) el.innerText = "News unavailable right now. Please try again later.";
  }
}

/* ---------------- LIVE DATA ---------------- */
let LIVE_CACHE = null;
let LIVE_TIMER = null;

async function fetchLiveRates() {
  const res = await fetch(`${BASE_URL}/api/live`);

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Live API failed");
  LIVE_CACHE = data;
  return data;
}

function getBaseRates() {
  if (!LIVE_CACHE?.gold?.inrPerGram24) {
    return { base24: 6600, base22: 6600 * 0.916, base18: 6600 * 0.75 };
  }
  return {
    base24: LIVE_CACHE.gold.inrPerGram24,
    base22: LIVE_CACHE.gold.inrPerGram22,
    base18: LIVE_CACHE.gold.inrPerGram18
  };
}

/* ---------------- CHART DATA ---------------- */
let goldChart = null;
let silverChart = null;

let labels = [];
let goldSeries = [];
let silverSeries = [];

const MAX_POINTS = 120;

function initGoldChart() {
  const ctx = $("#trendChart");
  if (!ctx) return;

  goldChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data: goldSeries,
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } }
    }
  });
}

function initSilverChart() {
  const ctx = $("#silverTrendChart");
  if (!ctx) return;

  silverChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data: silverSeries,
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } }
    }
  });
}

/* ---------------- TREND HELPERS ---------------- */
function trendDirection(arr) {
  if (!arr || arr.length < 6) return "stable";
  const last = arr[arr.length - 1];
  const prev = arr[arr.length - 6];
  if (last > prev) return "up";
  if (last < prev) return "down";
  return "stable";
}

function pctChange(arr, lookback = 6) {
  if (!arr || arr.length < lookback + 1) return 0;
  const last = arr[arr.length - 1];
  const prev = arr[arr.length - 1 - lookback];
  if (!prev) return 0;
  return ((last - prev) / prev) * 100;
}

function classifyVolatility(arr) {
  const move = Math.abs(pctChange(arr, 6));
  if (move >= 0.35) return { label: "HIGH", score: 90 };
  if (move >= 0.18) return { label: "MEDIUM", score: 60 };
  return { label: "LOW", score: 35 };
}

/* ---------------- ✅ FULL DAY STATS (persist) ---------------- */
function loadDayStats() {
  const raw = localStorage.getItem(STORAGE_KEYS.DAYSTATS);
  if (!raw) {
    return { day: todayKey(), low: null, high: null, sum: 0, count: 0 };
  }
  try {
    const obj = JSON.parse(raw);
    if (!obj?.day) return { day: todayKey(), low: null, high: null, sum: 0, count: 0 };
    return obj;
  } catch {
    return { day: todayKey(), low: null, high: null, sum: 0, count: 0 };
  }
}

function saveDayStats(stats) {
  localStorage.setItem(STORAGE_KEYS.DAYSTATS, JSON.stringify(stats));
}

let DAY_STATS = loadDayStats();

/* ---------------- ✅ MULTI-DAY HISTORY (7 days rolling) ---------------- */
const HISTORY_DAYS = 7;

function loadHistory() {
  const raw = localStorage.getItem(STORAGE_KEYS.HISTORY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveHistory(hist) {
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(hist));
}

let HISTORY_STATS = loadHistory();

function addDayToHistory(dayStats) {
  if (
    !dayStats?.day ||
    !Number.isFinite(dayStats.low) ||
    !Number.isFinite(dayStats.high) ||
    !Number.isFinite(dayStats.sum) ||
    !dayStats.count
  ) {
    return;
  }

  const avg = dayStats.sum / dayStats.count;

  // replace if already exists
  HISTORY_STATS = HISTORY_STATS.filter((d) => d.day !== dayStats.day);

  HISTORY_STATS.push({
    day: dayStats.day,
    low: dayStats.low,
    high: dayStats.high,
    avg
  });

  // keep only last N days
  HISTORY_STATS.sort((a, b) => a.day.localeCompare(b.day));
  if (HISTORY_STATS.length > HISTORY_DAYS) {
    HISTORY_STATS = HISTORY_STATS.slice(HISTORY_STATS.length - HISTORY_DAYS);
  }

  saveHistory(HISTORY_STATS);
}

function updateDayStats(current) {
  if (!Number.isFinite(current)) return;

  const key = todayKey();

  // ✅ if day changed → push previous day into history (DO NOT DELETE)
  if (DAY_STATS.day !== key) {
    addDayToHistory(DAY_STATS);

    // new day starts fresh stats, history stays
    DAY_STATS = { day: key, low: null, high: null, sum: 0, count: 0 };
    saveDayStats(DAY_STATS);
  }

  if (DAY_STATS.low === null || current < DAY_STATS.low) DAY_STATS.low = current;
  if (DAY_STATS.high === null || current > DAY_STATS.high) DAY_STATS.high = current;

  DAY_STATS.sum += current;
  DAY_STATS.count += 1;

  if (DAY_STATS.count % 3 === 0) saveDayStats(DAY_STATS);
}

function computeDayAvg() {
  if (!DAY_STATS.count) return null;
  return DAY_STATS.sum / DAY_STATS.count;
}

/* ---------------- ✅ BEST BUY WINDOW (multi-day) ---------------- */
let BUYWINDOW_CACHE = {
  lastCalcAt: 0,
  badge: "⏳ LOADING",
  title: "Collecting price data…",
  description: "Wait a minute so the app can learn movement.",
  action: "Keep tracking for 1–2 minutes.",
  time: `Last ${HISTORY_DAYS} days`,
  risk: "Low",
  pos: 0.5
};

const BUYWINDOW_RECALC_MS = 20 * 60 * 1000;

function buildBuyWindowMultiDay() {
  if (!goldSeries.length) {
    return {
      badge: "⏳ LOADING",
      title: "Collecting price data…",
      description: "Wait a minute so the app can learn movement.",
      action: "Keep tracking for 1–2 minutes.",
      time: `Last ${HISTORY_DAYS} days`,
      risk: "Low",
      pos: 0.5
    };
  }

  const current = goldSeries[goldSeries.length - 1];

  // combine history + today stats
  const combined = [...HISTORY_STATS];

  if (Number.isFinite(DAY_STATS.low) && Number.isFinite(DAY_STATS.high) && DAY_STATS.count > 0) {
    combined.push({
      day: DAY_STATS.day,
      low: DAY_STATS.low,
      high: DAY_STATS.high,
      avg: DAY_STATS.sum / DAY_STATS.count
    });
  }

  if (!combined.length) {
    return {
      badge: "⏳ LOADING",
      title: "Collecting multi-day range…",
      description: "No history yet. Keep app open for some time.",
      action: "Come back after some minutes.",
      time: `Last ${HISTORY_DAYS} days`,
      risk: "Low",
      pos: 0.5
    };
  }

  const multiLow = Math.min(...combined.map((x) => x.low));
  const multiHigh = Math.max(...combined.map((x) => x.high));
  const multiAvg = combined.reduce((s, x) => s + x.avg, 0) / combined.length;

  const range = (multiHigh - multiLow) || 1;
  const pos = clamp((current - multiLow) / range, 0, 1);

  let badge = "🟡 WATCH";
  let title = "Average zone — track for dip";
  let description = "Gold is around the multi-day middle zone.";
  let action = "If not urgent, wait for a better dip.";
  let risk = "Medium";

  if (pos <= 0.35) {
    badge = "🟢 BUY OK";
    title = "Good buy window (near multi-day low)";
    description = "Gold is closer to the lower zone of recent days.";
    action = "Good for planned purchase. Consider buying partial quantity.";
    risk = "Low";
  } else if (pos >= 0.7) {
    badge = "🔴 WAIT";
    title = "Avoid buying (near multi-day high)";
    description = "Gold is near higher zone compared to recent days.";
    action = "Wait for pullback. Set a price alert.";
    risk = "High";
  }

  return {
    badge,
    title,
    description: `${description}
Multi-Low: ${moneyINR(multiLow)} • Multi-Avg: ${moneyINR(multiAvg)} • Multi-High: ${moneyINR(multiHigh)}`,
    action,
    time: `Last ${Math.min(HISTORY_DAYS, combined.length)} days`,
    risk,
    pos
  };
}

function renderBuyBar() {
  const fill = $("#buyBarFill");
  const pointer = $("#buyPointer");
  const lowEl = $("#buyLow");
  const avgEl = $("#buyAvg");
  const highEl = $("#buyHigh");

  if (!fill || !pointer || !lowEl || !avgEl || !highEl) return;

  // show multi-day values
  const combined = [...HISTORY_STATS];
  if (Number.isFinite(DAY_STATS.low) && Number.isFinite(DAY_STATS.high) && DAY_STATS.count > 0) {
    combined.push({
      day: DAY_STATS.day,
      low: DAY_STATS.low,
      high: DAY_STATS.high,
      avg: DAY_STATS.sum / DAY_STATS.count
    });
  }

  if (!combined.length) {
    lowEl.textContent = "--";
    avgEl.textContent = "--";
    highEl.textContent = "--";
    return;
  }

  const multiLow = Math.min(...combined.map((x) => x.low));
  const multiHigh = Math.max(...combined.map((x) => x.high));
  const multiAvg = combined.reduce((s, x) => s + x.avg, 0) / combined.length;

  lowEl.textContent = moneyINR(multiLow);
  avgEl.textContent = moneyINR(multiAvg);
  highEl.textContent = moneyINR(multiHigh);

  const pct = clamp((BUYWINDOW_CACHE.pos ?? 0.5) * 100, 0, 100);
  fill.style.width = `${pct}%`;
  pointer.style.left = `${pct}%`;

  const last = goldSeries.length ? goldSeries[goldSeries.length - 1] : null;
  $("#buyNowRate").textContent = last ? `${moneyINR(last)} / g` : "--";
}

function renderBuyWindow() {
  const el = $("#buyWindow");
  if (!el) return;

  const now = Date.now();
  if (!BUYWINDOW_CACHE.lastCalcAt || now - BUYWINDOW_CACHE.lastCalcAt > BUYWINDOW_RECALC_MS) {
    BUYWINDOW_CACHE = { ...buildBuyWindowMultiDay(), lastCalcAt: now };
  }

  $("#buyBadge").textContent = BUYWINDOW_CACHE.badge;
  $("#buyTitle").textContent = BUYWINDOW_CACHE.title;
  $("#buyDesc").textContent = BUYWINDOW_CACHE.description;
  $("#buyAction").textContent = BUYWINDOW_CACHE.action;

  $("#buyTime").textContent = BUYWINDOW_CACHE.time;
  $("#buyRisk").textContent = BUYWINDOW_CACHE.risk;

  renderBuyBar();
}

/* ---------------- MARKET MOOD ---------------- */
function buildMarketMood() {
  const gTrend = trendDirection(goldSeries);
  const sTrend = trendDirection(silverSeries);
  const vol = classifyVolatility(goldSeries);

  let confidence = 55;

  if (gTrend === "up") confidence += 18;
  if (gTrend === "down") confidence += 10;
  if (gTrend === "stable") confidence -= 5;

  if (silverSeries.length > 6) {
    if (sTrend === gTrend && gTrend !== "stable") confidence += 12;
    if (sTrend !== gTrend && gTrend !== "stable") confidence -= 6;
  }

  confidence += Math.floor((vol.score - 50) * 0.22);
  confidence = clamp(confidence, 25, 95);

  let signal = "WATCH";
  let reason = "Gold and silver are steady — safe to monitor.";
  let tip = "Tip: Jewellery final price = rate + making + GST.";

  if (gTrend === "up" && vol.label !== "LOW") {
    signal = "BUY";
    reason = "Gold is rising — buying early may help reduce cost.";
    tip = "Split buy: part now + part later.";
  } else if (gTrend === "down" && vol.label !== "LOW") {
    signal = "WAIT";
    reason = "Gold is falling — waiting may give better price.";
    tip = "If urgent, buy small quantity now.";
  }

  return {
    signal,
    confidence,
    reason,
    tip,
    goldTrend: gTrend.toUpperCase(),
    silverTrend: sTrend.toUpperCase(),
    volatility: vol.label
  };
}

function renderMarketMood() {
  const elSignal = $("#moodSignalText");
  if (!elSignal) return;

  const mood = buildMarketMood();

  $("#moodGoldTrend").textContent = mood.goldTrend;
  $("#moodSilverTrend").textContent = mood.silverTrend;
  $("#moodVolatility").textContent = mood.volatility;

  $("#moodConfidence").textContent = mood.confidence;
  $("#moodBarFill").style.width = `${mood.confidence}%`;

  $("#moodReason").textContent = mood.reason;
  $("#moodTip").textContent = mood.tip;

  elSignal.textContent = mood.signal;
}

/* ---------------- UI RENDER ---------------- */
function calcCityRateINR(cityName, purity) {
  const base = getBaseRates();
  const premium = cityPremium(cityName);

  let rate = base.base24;
  if (purity === 22) rate = base.base22;
  if (purity === 18) rate = base.base18;

  return rate * premium;
}

function renderHeroRates(settings) {
  const city = settings.defaultCity;

  const g24 = calcCityRateINR(city, 24);
  const g22 = calcCityRateINR(city, 22);

  $("#jk24").textContent = moneyINR(g24);
  $("#jk22").textContent = moneyINR(g22);

  $("#jk24Sub").textContent = `${city} • 10g: ${moneyINR(g24 * 10)}`;
  $("#jk22Sub").textContent = `${city} • 10g: ${moneyINR(g22 * 10)}`;

  const gUsd = LIVE_CACHE?.gold?.usdPerOunce24;
  $("#global24usd").textContent = gUsd ? moneyUSD(gUsd) : "$ --";

  const fx = LIVE_CACHE?.fx?.usdToInr;
  $("#fxRate").textContent = fx ? fx.toFixed(2) : "--";

  $("#lastUpdatedChip").textContent =
    `Updated: ${new Date(LIVE_CACHE?.updatedAt || Date.now()).toLocaleString()} • Premium: ${LIVE_CACHE?.premiumPct ?? "--"}%`;

  const sUsd = LIVE_CACHE?.silver?.usdPerOunce;
  const sInrG = LIVE_CACHE?.silver?.inrPerGram;

  $("#silverUsdOz").textContent = sUsd ? moneyUSD(sUsd) : "$ --";
  $("#silverInrG").textContent = sInrG ? moneyINR(sInrG) : "₹ --";
  $("#silverInr10g").textContent = sInrG ? moneyINR(sInrG * 10) : "₹ --";
  $("#silverInrKg").textContent = sInrG ? moneyINR(sInrG * 1000) : "₹ --";
}

function renderCompare() {
  const purity = Number($("#comparePurity").value);
  const unit = $("#compareUnit").value;

  const list = CITIES
    .map((c) => {
      const perGram = calcCityRateINR(c.name, purity);
      const price = unit === "gram" ? perGram : perGram * gramFromTola(1);
      return { ...c, price };
    })
    .sort((a, b) => a.price - b.price);

  const grid = $("#compareGrid");
  if (!grid) return;
  grid.innerHTML = "";

  list.forEach((item) => {
    const card = document.createElement("div");
    card.className = "compare-card";
    card.innerHTML = `
      <h3>${item.name}</h3>
      <p class="muted">${item.type} • Premium: ${item.premium.toFixed(3)}x</p>
      <div style="font-size:20px;font-weight:950;margin-top:10px">${moneyINR(item.price)}</div>
      <p class="muted" style="margin-top:6px">${purity}K • ${unit === "gram" ? "Per gram" : "Per tola"}</p>
    `;
    grid.appendChild(card);
  });
}

function doCalculate() {
  const city = $("#calcCity").value;
  const purity = Number($("#calcPurity").value);
  const weight = Number($("#calcWeight").value || 0);
  const unit = $("#calcUnit").value;
  const makingPct = Number($("#calcMaking").value || 0);
  const gstPct = Number($("#calcGST").value || 0);

  const perGram = calcCityRateINR(city, purity);
  const weightGram = unit === "gram" ? weight : gramFromTola(weight);

  const baseValue = perGram * weightGram;
  const makingValue = baseValue * (makingPct / 100);
  const subTotal = baseValue + makingValue;
  const gstValue = subTotal * (gstPct / 100);
  const total = subTotal + gstValue;

  $("#baseValue").textContent = moneyINR(baseValue);
  $("#makingValue").textContent = moneyINR(makingValue);
  $("#gstValue").textContent = moneyINR(gstValue);
  $("#totalValue").textContent = moneyINR(total);
}

/* ---------------- AI CHAT ---------------- */
function chatAddMessage(role, text) {
  const box = $("#chatBox");
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  msg.innerHTML = `<div>${text}</div>`;
  box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
}

function extractAmount(text) {
  const m = text.replace(/,/g, "").match(/(\d{4,9})/);
  return m ? Number(m[1]) : null;
}
function extractPurity(text) {
  const t = text.toLowerCase();
  if (t.includes("24")) return 24;
  if (t.includes("22")) return 22;
  if (t.includes("18")) return 18;
  return 22;
}

function advisorReply(userText, settings) {
  const purity = extractPurity(userText);
  const amount = extractAmount(userText);

  const rate = calcCityRateINR(settings.defaultCity, purity);
  const tr = trendDirection(goldSeries);

  const mood =
    tr === "up" ? "📈 Gold rising — buy sooner if urgent." :
    tr === "down" ? "📉 Gold falling — waiting may help." :
    "➖ Gold stable — safe time for normal buying.";

  if (amount) {
    const grams = amount / rate;
    return `Srinagar (${purity}K):
Rate: ${moneyINR(rate)} / gram

With ${moneyINR(amount)} you can buy approx:
✅ ${grams.toFixed(2)} grams

${mood}`;
  }

  return `Srinagar Live (${purity}K)
Rate: ${moneyINR(rate)} / gram
Gold Trend: ${trendDirection(goldSeries).toUpperCase()}
Silver Trend: ${trendDirection(silverSeries).toUpperCase()}

${mood}`;
}

/* ---------------- TABS ---------------- */
function showTab(tabName) {
  $$(".nav-item").forEach((btn) => btn.classList.remove("active"));
  $$(".tab").forEach((t) => t.classList.remove("active"));

  $(`.nav-item[data-tab="${tabName}"]`)?.classList.add("active");
  $(`#tab-${tabName}`)?.classList.add("active");
}

/* ---------------- LIVE LOOP ---------------- */
function pushPoint(label, gVal, sVal) {
  labels.push(label);
  goldSeries.push(Number(gVal));
  silverSeries.push(Number(sVal));

  if (labels.length > MAX_POINTS) {
    labels.shift();
    goldSeries.shift();
    silverSeries.shift();
  }

  if (goldChart) goldChart.update();
  if (silverChart) silverChart.update();
}

function startLive(settings, intervalMs = 5000) {
  if (LIVE_TIMER) clearInterval(LIVE_TIMER);

  const tick = async () => {
    try {
      await fetchLiveRates();

      const timeLabel = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });

      const g = Number(LIVE_CACHE.gold.inrPerGram24.toFixed(2));
      const s = Number(LIVE_CACHE?.silver?.inrPerGram?.toFixed(2) || 0);
      const sSafe = s || (silverSeries.length ? silverSeries[silverSeries.length - 1] : 0);

      updateDayStats(g);
      pushPoint(timeLabel, g, sSafe);

      renderHeroRates(settings);
      renderCompare();
      renderMarketMood();
      renderBuyWindow();
    } catch (err) {
      console.warn("Live update failed:", err.message);
    }
  };

  tick();
  LIVE_TIMER = setInterval(tick, intervalMs);
}

/* ---------------- INIT ---------------- */
function populateCities(settings) {
  const el1 = $("#calcCity");
  const el2 = $("#defaultCity");
  if (!el1 || !el2) return;

  el1.innerHTML = "";
  el2.innerHTML = "";

  CITIES.forEach((c) => {
    const o1 = document.createElement("option");
    o1.value = c.name;
    o1.textContent = `${c.name} (J&K)`;
    el1.appendChild(o1);

    const o2 = document.createElement("option");
    o2.value = c.name;
    o2.textContent = `${c.name} (J&K)`;
    el2.appendChild(o2);
  });

  $("#calcCity").value = settings.defaultCity;
  $("#defaultCity").value = settings.defaultCity;
}

function init() {
  const settings = loadSettings();

  populateCities(settings);
  initGoldChart();
  initSilverChart();

  // Tabs
  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      showTab(btn.dataset.tab);
      document.body.classList.remove("sidebar-open");
    });
  });

  // Mobile drawer
  $("#btnMenu")?.addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
  $("#overlay")?.addEventListener("click", () => document.body.classList.remove("sidebar-open"));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.body.classList.remove("sidebar-open");
  });

  // Calculator
  $("#btnCalc")?.addEventListener("click", doCalculate);

  // Settings
  $("#btnSaveSettings")?.addEventListener("click", () => {
    settings.defaultCity = $("#defaultCity").value;
    saveSettings(settings);
    alert("✅ Saved!");
  });

  // Compare
  $("#comparePurity")?.addEventListener("change", renderCompare);
  $("#compareUnit")?.addEventListener("change", renderCompare);

  // Advisor
  $("#btnChatSend")?.addEventListener("click", () => {
    const val = $("#chatInput").value.trim();
    if (!val) return;
    chatAddMessage("user", val);
    $("#chatInput").value = "";
    setTimeout(() => chatAddMessage("ai", advisorReply(val, settings)), 200);
  });

  $("#chatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btnChatSend").click();
  });

  // Refresh
  $("#btnRefresh")?.addEventListener("click", async () => {
    await fetchLiveRates();
    renderHeroRates(settings);
    renderCompare();
    renderMarketMood();

    // Force recompute Buy Window now
    BUYWINDOW_CACHE.lastCalcAt = 0;
    renderBuyWindow();

    // Reload news
    loadNews(NEWS_ACTIVE_CATEGORY);

    alert("✅ Refreshed!");
  });

  // ✅ News tabs click
  $$(".news-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".news-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      loadNews(btn.dataset.news);
    });
  });

  // ✅ load default news + refresh every 2 mins
  loadNews("kashmir");
  setInterval(() => loadNews(NEWS_ACTIVE_CATEGORY), 120000);

  chatAddMessage("ai", "✅ Best Buy Window now uses multi-day average (stable).");

  startLive(settings, 5000);
}

init();
