// api/chat.js — KV reader + Groq chat
// Data is populated every 15 min by GitHub Actions (scripts/scraper.js)
// No scraping, no AI fallbacks, no Firecrawl here.

const GROQ_BASE       = "https://api.groq.com/openai/v1";
const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";

// ── Cache TTLs (seconds) ──
const CACHE_TTLS = { fuel: 1800, power: 1800, water: 7200, waterlevel: 1800 };

// ── L1: in-memory per-instance (avoids repeat KV hits within same warm instance) ──
const apiCache = {
  fuel:       { data: null, ts: 0 },
  power:      { data: null, ts: 0 },
  water:      { data: null, ts: 0 },
  waterlevel: { data: null, ts: 0 }
};

// ── L2: Vercel KV (persistent, shared across all instances) ──
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_PFX   = 'priceph:';

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/get/${KV_PFX}${key}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      signal: AbortSignal.timeout(2000)
    });
    const { result } = await res.json();
    return result ? JSON.parse(result) : null;
  } catch(e) { console.warn('[kv] get failed:', e.message); return null; }
}

// ── getCache: L1 → L2 → miss ──
async function getCache(key) {
  const ttlMs = (CACHE_TTLS[key] || 900) * 1000;
  const e = apiCache[key];
  if (e?.data && (Date.now() - e.ts) < ttlMs) {
    console.log(`[cache] L1 hit: ${key}`);
    return e.data;
  }
  const kvData = await kvGet(key);
  if (kvData) {
    console.log(`[cache] L2 hit: ${key}`);
    apiCache[key] = { data: kvData, ts: Date.now() };
    return kvData;
  }
  return null;
}

// ── Main handler ──
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};
  const { action = "chat", system, messages, region = "metro_manila" } = body;

  try {
    if (action === "debug")      return await handleDebug(res);
    if (action === "fuel")       return await handleFuel(res, region);
    if (action === "power")      return await handlePower(res);
    if (action === "water")      return await handleWater(res);
    if (action === "waterlevel") return await handleWaterLevel(res);
    return await handleChat(system, messages, res);
  } catch (err) {
    console.error("[chat.js] unhandled:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

/* ── DEBUG ── */
async function handleDebug(res) {
  const [fuel, power, water, waterlevel] = await Promise.all([
    kvGet('fuel'), kvGet('power'), kvGet('water'), kvGet('waterlevel')
  ]);
  return res.status(200).json({
    groqKeyPresent:  !!process.env.GROQ_API_KEY,
    kvConfigured:    !!(KV_URL && KV_TOKEN),
    cache_fuel:       fuel       ? `present (ron91: ${fuel.prices?.petron?.ron91})` : 'empty',
    cache_power:      power      ? `present (level: ${power.grid_status?.level})`   : 'empty',
    cache_water:      water      ? `present (${water.interruptions?.length} items)`  : 'empty',
    cache_waterlevel: waterlevel ? `present (${waterlevel.dams?.length} dams)`       : 'empty',
    nodeVersion:     process.version,
    vercelRegion:    process.env.VERCEL_REGION || 'unknown',
    scraper:         'github-actions (runs every 15 min)'
  });
}

/* ── CHAT (Groq only — for the user chat assistant) ── */
async function handleChat(system, messages, res) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GROQ_API_KEY missing" });
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages array required" });

  const r = await groqPost("/chat/completions", {
    model: GROQ_CHAT_MODEL,
    max_tokens: 800,
    messages: [
      { role: "system", content: system || "You are a helpful assistant." },
      ...messages.slice(-10)
    ]
  });

  if (!r.ok) return res.status(r.status).json({ error: r.data?.error || r.data });
  const text = r.data.choices?.[0]?.message?.content || "";
  return res.status(200).json({ content: [{ text }] });
}

/* ── FUEL ── */
async function handleFuel(res) {
  const cached = await getCache("fuel");
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(cached);
  }
  const today = phDate();
  return res.status(200).json({
    effective_date: today, week_label: `Week of ${today}`,
    doe_adjustment: { gasoline_ron91_95: null, diesel_std: null, kerosene: null, lpg_per_kg: null,
      note: "Data is being refreshed. Check back in a minute." },
    prices: {
      petron: { ron91: null, ron95: null, ron100: null, diesel_std: null, diesel_prem: null, kerosene: null },
      shell:  { ron91: null, ron95: null, ron97: null,  diesel_std: null, diesel_prem: null, kerosene: null },
      unioil: { ron91: null, ron95: null, diesel_std: null }
    },
    trend_context: "Background scraper is refreshing data.",
    next_week_signal: null, fill_up_advice: null, sources: [],
    _meta: { source: 'unavailable', cached_at: new Date().toISOString() }
  });
}

/* ── POWER ── */
async function handlePower(res) {
  const cached = await getCache("power");
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(cached);
  }
  return res.status(200).json({
    grid_status: {
      level: "normal", title: "Grid Status Unavailable",
      subtitle: "Background scraper is refreshing data. Check back in a minute.",
      color: "#6b6a65", bg: "#f0efe9", border: "rgba(0,0,0,.1)", alert_times: []
    },
    interruptions: [], last_updated: phDate(), sources: [],
    _meta: { source: 'unavailable', cached_at: new Date().toISOString() }
  });
}

/* ── WATER ── */
async function handleWater(res) {
  const cached = await getCache("water");
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(cached);
  }
  return res.status(200).json({
    interruptions: [], last_updated: phDate(), sources: [],
    _meta: { source: 'unavailable', cached_at: new Date().toISOString() }
  });
}

/* ── WATER LEVEL ── */
async function handleWaterLevel(res) {
  const cached = await getCache("waterlevel");
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(cached);
  }
  return res.status(200).json({
    dams: [], flood_watch: null, stations: [], rainfall: [],
    obs_time: null, ffws_time: null, last_updated: phDate(), sources: [],
    _meta: { source: 'unavailable', cached_at: new Date().toISOString() }
  });
}

/* ── GROQ (chat only) ── */
async function groqPost(path, payload) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await fetch(`${GROQ_BASE}${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : { raw: await res.text() };
  return { ok: res.ok, status: res.status, data };
}

/* ── UTILITIES ── */
function phDate() {
  return new Date().toLocaleDateString("en-PH", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "Asia/Manila"
  });
}
