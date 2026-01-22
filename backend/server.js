import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

const LIVE_CACHE_MS = 4000;

// Srinagar retail premium (tune for local market)
let calibration = { premiumPct: 4.8 };

let cache = { ts: 0, data: null };

function round2(n){ return Number(Number(n).toFixed(2)); }

async function fetchJSON(url){
  const res = await fetch(url, {
    headers: { "User-Agent":"Mozilla/5.0 (GoldWise FX)" }
  });
  const data = await res.json().catch(()=>null);
  if(!res.ok) throw new Error(`Upstream ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function fetchText(url){
  const res = await fetch(url, {
    headers: { "User-Agent":"Mozilla/5.0 (GoldWise News)" }
  });
  const text = await res.text().catch(()=>null);
  if(!res.ok) throw new Error(`Upstream ${res.status}: ${text?.slice(0,200)}`);
  return text;
}

/* ✅ REAL FX with fallback */
async function getUsdToInr(){
  const providers = [
    async () => {
      const fx = await fetchJSON("https://open.er-api.com/v6/latest/USD");
      const rate = Number(fx?.rates?.INR);
      if(!Number.isFinite(rate)) throw new Error("open.er-api invalid");
      return rate;
    },
    async () => {
      const fx = await fetchJSON("https://api.exchangerate.host/latest?base=USD&symbols=INR");
      const rate = Number(fx?.rates?.INR);
      if(!Number.isFinite(rate)) throw new Error("exchangerate.host invalid");
      return rate;
    }
  ];

  for(const fn of providers){
    try{
      const r = await fn();
      if(Number.isFinite(r)) return r;
    }catch(e){}
  }

  return 83.0;
}

/* ✅ Spot Gold + Silver */
async function getSpot(){
  const gold = await fetchJSON("https://api.gold-api.com/price/XAU");
  const silver = await fetchJSON("https://api.gold-api.com/price/XAG");

  const goldUsdOz = Number(gold?.price);
  const silverUsdOz = Number(silver?.price);

  if(!Number.isFinite(goldUsdOz)) throw new Error("Gold upstream invalid price");
  if(!Number.isFinite(silverUsdOz)) throw new Error("Silver upstream invalid price");

  const usdToInr = await getUsdToInr();
  return { goldUsdOz, silverUsdOz, usdToInr };
}

/* ✅ Optional: allow user to calibrate premium */
app.post("/api/calibrate", (req, res) => {
  const premiumPct = Number(req.body?.premiumPct);

  if(!Number.isFinite(premiumPct) || premiumPct < 0 || premiumPct > 12){
    return res.status(400).json({
      ok:false,
      error:"Invalid premiumPct (0 to 12). Example: { premiumPct: 5.2 }"
    });
  }

  calibration.premiumPct = round2(premiumPct);
  cache = { ts: 0, data: null };

  res.json({
    ok:true,
    message:"✅ Premium updated",
    premiumPct: calibration.premiumPct
  });
});

/* ✅ LIVE Endpoint */
app.get("/api/live", async (req, res) => {
  try{
    const now = Date.now();
    if(cache.data && (now - cache.ts) < LIVE_CACHE_MS){
      return res.json(cache.data);
    }

    const spot = await getSpot();
    const GRAMS_PER_OUNCE = 31.1034768;

    const inrPerOunceGold = spot.goldUsdOz * spot.usdToInr;
    const inrPerOunceSilver = spot.silverUsdOz * spot.usdToInr;

    const goldSpotGram24 = inrPerOunceGold / GRAMS_PER_OUNCE;
    const silverSpotGram = inrPerOunceSilver / GRAMS_PER_OUNCE;

    const factor = 1 + (calibration.premiumPct / 100);

    const goldInrGram24 = goldSpotGram24 * factor;
    const goldInrGram22 = goldInrGram24 * (22/24);
    const goldInrGram18 = goldInrGram24 * (18/24);

    const payload = {
      ok:true,
      mode:"SRINAGAR_RETAIL_LIVE_FREE_REALFX",
      updatedAt:new Date().toISOString(),
      premiumPct: calibration.premiumPct,

      gold:{
        usdPerOunce24: round2(spot.goldUsdOz),
        inrPerGram24: round2(goldInrGram24),
        inrPerGram22: round2(goldInrGram22),
        inrPerGram18: round2(goldInrGram18)
      },

      silver:{
        usdPerOunce: round2(spot.silverUsdOz),
        inrPerGram: round2(silverSpotGram)
      },

      fx:{
        usdToInr: round2(spot.usdToInr)
      }
    };

    cache = { ts: now, data: payload };
    res.json(payload);

  }catch(e){
    res.status(500).json({
      ok:false,
      error:String(e.message || e)
    });
  }
});

/* ✅ NEWS (Google RSS → JSON with categories + filter) */
function parseRSSItems(xml){
  const items = [];
  const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for(const block of itemBlocks){
    const title =
      (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
       block.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim();

    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]?.trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]?.trim();

    let publishedAt = null;
    try{
      if(pubDate) publishedAt = new Date(pubDate).toISOString();
    }catch(e){}

    if(title && link){
      items.push({
        title,
        url: link,
        source: "Google News",
        publishedAt
      });
    }
  }

  // remove duplicates
  const seen = new Set();
  return items.filter(x => {
    const key = x.url || x.title;
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRelevantGoldNews(title){
  const t = String(title || "").toLowerCase();

  // ✅ Must include at least one
  const mustHave = [
    "gold", "bullion", "24k", "22k", "hallmark", "jewellery", "jewelry",
    "mcx", "xau", "xauusd", "sovereign", "karat", "carat"
  ];

  const hasMust = mustHave.some(k => t.includes(k));
  if(!hasMust) return false;

  // ✅ Remove noise/irrelevant
  const blocked = [
    "bitcoin", "crypto", "nft", "football", "cricket",
    "movie", "celebrity", "song", "game"
  ];

  if(blocked.some(k => t.includes(k))) return false;

  return true;
}

const NEWS_CACHE_MS = 2 * 60 * 1000;
let NEWS_CACHE = {}; // category -> {ts,data}

function buildRssUrl(category){
  const map = {
    kashmir: "gold price Kashmir OR Srinagar OR bullion Kashmir OR jewellery Kashmir",
    india: "gold price India OR MCX gold OR bullion India OR jewellery India",
    global: "gold price global OR XAUUSD OR inflation OR Federal Reserve OR bullion market",
    silver: "silver price India OR XAG OR silver demand OR silver market"
  };

  const q = encodeURIComponent(map[category] || map.india);
  return `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
}

app.get("/api/news", async (req, res) => {
  try{
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    const category = String(req.query.category || "india").toLowerCase();

    const now = Date.now();
    if(NEWS_CACHE[category]?.data && (now - NEWS_CACHE[category].ts) < NEWS_CACHE_MS){
      return res.json(NEWS_CACHE[category].data);
    }

    const rssUrl = buildRssUrl(category);
    const xml = await fetchText(rssUrl);

    let articles = parseRSSItems(xml);

    // ✅ filter only relevant gold/silver headlines
    articles = articles.filter(a => isRelevantGoldNews(a.title));

    // limit
    articles = articles.slice(0, 12);

    const payload = {
      ok:true,
      category,
      updatedAt: new Date().toISOString(),
      articles
    };

    NEWS_CACHE[category] = { ts: now, data: payload };
    res.json(payload);

  }catch(e){
    res.status(500).json({
      ok:false,
      error:String(e.message || e)
    });
  }
});
app.get("/", (req, res) => {
  res.send("✅ GoldWise Backend is running!");
});

app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
