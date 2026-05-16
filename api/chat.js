// api/chat.js — GasWatch PH Scraper + Gemini Fallback + Groq Chat Only
// Env vars: GEMINI_API_KEY, GROQ_API_KEY

const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.0-flash-lite";

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';
const FC_DAILY_LIMIT = 16;

const GASWATCH_URLS = {
  metro_manila: "https://gaswatchph.com/",
  cavite: "https://gaswatchph.com/cavite",
  rizal: "https://gaswatchph.com/rizal",
  laguna: "https://gaswatchph.com/laguna",
  pampanga: "https://gaswatchph.com/pampanga"
};

// ── Cache TTLs (seconds) ──
const CACHE_TTLS = { fuel: 900, power: 900, water: 7200, waterlevel: 3600 };

// ── L1: in-memory (per-instance, fast) ──
const apiCache = { fuel: { data: null, ts: 0 }, power: { data: null, ts: 0 }, water: { data: null, ts: 0 }, waterlevel: { data: null, ts: 0 } };

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

async function kvSet(key, value, ttlSeconds) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', KV_PFX + key, JSON.stringify(value), 'EX', ttlSeconds]]),
      signal: AbortSignal.timeout(2000)
    });
  } catch(e) { console.warn('[kv] set failed:', e.message); }
}

// ── Firecrawl daily rate limiter (shared counter across all handlers) ──
async function fcGetCount() {
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const n = await kvGet('fc:' + date);
  return n ? parseInt(n) : 0;
}

async function fcIncrCount() {
  if (!KV_URL || !KV_TOKEN) return;
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  try {
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', KV_PFX + 'fc:' + date],
        ['EXPIRE', KV_PFX + 'fc:' + date, 90000]
      ]),
      signal: AbortSignal.timeout(2000)
    });
  } catch(e) { console.warn('[fc] incr failed:', e.message); }
}

async function firecrawlScrape(url, format = 'markdown') {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('No FIRECRAWL_API_KEY');
  const count = await fcGetCount();
  if (count >= FC_DAILY_LIMIT) throw new Error(`Firecrawl daily limit reached (${count}/${FC_DAILY_LIMIT})`);
  const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: [format], onlyMainContent: true }),
    signal: AbortSignal.timeout(30000)
  });
  await fcIncrCount();
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!data.success) throw new Error('Firecrawl: ' + (data.error || 'failed'));
  console.log(`[fc] scraped ${url} (${count + 1}/${FC_DAILY_LIMIT} today)`);
  return format === 'html' ? (data.data?.html || '') : (data.data?.markdown || '');
}

// ── getCache: L1 → L2 → miss ──
async function getCache(key) {
  const ttlMs = (CACHE_TTLS[key] || 900) * 1000;
  // L1 hit
  const e = apiCache[key];
  if (e?.data && (Date.now() - e.ts) < ttlMs) {
    console.log(`[cache] L1 hit: ${key}`);
    return e.data;
  }
  // L2 hit
  const kvData = await kvGet(key);
  if (kvData) {
    console.log(`[cache] L2 hit: ${key}`);
    apiCache[key] = { data: kvData, ts: Date.now() }; // warm L1
    return kvData;
  }
  return null;
}

// ── setCache: write to both L1 and L2 ──
async function setCache(key, data) {
  const ttl = CACHE_TTLS[key] || 900;
  apiCache[key] = { data, ts: Date.now() };
  await kvSet(key, data, ttl);
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
    if (action === "debug") return await handleDebug(res);
    if (action === "fuel") return await handleFuel(res, region);
    if (action === "power") return await handlePower(res);
    if (action === "water") return await handleWater(res);
    if (action === "waterlevel") return await handleWaterLevel(res);
    return await handleChat(system, messages, res);
  } catch (err) {
    console.error("[chat.js] unhandled:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

/* ── DEBUG ── */
async function handleDebug(res) {
  const groq = process.env.GROQ_API_KEY;
  const gem = process.env.GEMINI_API_KEY;

  let gwResult = null, gwError = null, gwDiag = null;
  try {
    gwResult = await scrapeGasWatch("metro_manila");
  } catch (e) {
    gwError = e.message;
  }

  // Raw diagnostic: fetch data.js and show key snippets
  try {
    const djRes = await fetch("https://gaswatchph.com/js/data.js", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PricePH/1.0)" }
    });
    const js = await djRes.text();
    const phIdx = js.indexOf('PRICE_HISTORY');
    const arrStart = js.indexOf('[', phIdx);
    const objStart = js.indexOf('{', arrStart);
    const weekBlock = extractBlock(js, objStart);
    const brandsIdx = weekBlock ? weekBlock.indexOf('brands') : -1;
    const brandsStart = weekBlock ? weekBlock.indexOf('{', brandsIdx) : -1;
    const brandsBlock = (weekBlock && brandsStart !== -1) ? extractBlock(weekBlock, brandsStart) : null;
    gwDiag = {
      datajs_len: js.length,
      phIdx,
      weekBlock_len: weekBlock ? weekBlock.length : 0,
      weekBlock_start: weekBlock ? weekBlock.slice(0, 120) : null,
      brandsIdx,
      brandsBlock_len: brandsBlock ? brandsBlock.length : 0,
      brandsBlock_preview: brandsBlock ? brandsBlock.slice(0, 300) : null,
      petron_pos: brandsBlock ? brandsBlock.toLowerCase().indexOf('petron:') : -1,
    };
  } catch (e) {
    gwDiag = { error: e.message };
  }

  return res.status(200).json({
    apiKeyPresent: !!groq,
    apiKeyPrefix: groq ? groq.slice(0, 8) + "…" : null,
    geminiKeyPresent: !!gem,
    nodeVersion: process.version,
    vercelRegion: process.env.VERCEL_REGION || "unknown",
    cache_fuel_age: apiCache.fuel.data ? Math.round((Date.now() - apiCache.fuel.ts) / 1000) + "s" : "empty",
    gaswatch_ok: !!gwResult,
    gaswatch_error: gwError,
    gaswatch_foundCount: gwResult?.foundCount,
    gaswatch_petron_ron91: gwResult?.prices?.petron?.ron91,
    gaswatch_petron_kerosene: gwResult?.prices?.petron?.kerosene,
    gaswatch_adj_gasoline: gwResult?.adjustment?.gasoline_ron91_95,
    gaswatch_adj_diesel: gwResult?.adjustment?.diesel_std,
    gaswatch_adj_kerosene: gwResult?.adjustment?.kerosene,
    diag: gwDiag,
  });
}

/* ── CHAT (Groq only) ── */
async function handleChat(system, messages, res) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GROQ_API_KEY missing" });
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }

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

/* ── FUEL (GasWatch PH → Gemini → Groq → Unavailable) ── */
async function handleFuel(res, region) {
  const cached = await getCache("fuel");
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(cached);
  }

  const today = phDate();
  let result = null;
  let source = null;
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;

  // 1. GasWatch + DOE adjustment + next-week forecast in parallel
  let [gwData, adjData, forecastData] = await Promise.all([
    scrapeGasWatch(region).catch(e => { console.warn("[fuel] GasWatch failed:", e.message); return null; }),
    fetchDOEAdjustment(today, geminiKey, groqKey),
    fetchNextWeekForecast(today, geminiKey, groqKey)
  ]);

  // 1b. GasWatch Firecrawl fallback (if data.js scrape failed)
  if (!gwData) {
    try {
      const md = await firecrawlScrape('https://gaswatchph.com/');
      const parsed = parseGasWatchMarkdown(md);
      if (parsed && parsed.prices?.petron?.ron91 > 50) {
        gwData = parsed;
        console.log("[fuel] GasWatch Firecrawl OK, ron91:", parsed.prices.petron.ron91);
      }
    } catch(e) { console.warn("[fuel] GasWatch Firecrawl failed:", e.message); }
  }

  if (gwData && gwData.prices && gwData.prices.petron && gwData.prices.petron.ron91 > 50) {
    const baseAdj = gwData.adjustment || { gasoline_ron91_95: null, diesel_std: null, kerosene: null, lpg_per_kg: null, note: "GasWatch PH community + DOE data" };
    // AI adjData only fills in fields that GasWatch didn't provide — never overrides
    if (adjData) {
      if (adjData.gasoline_ron91_95 && !baseAdj.gasoline_ron91_95) baseAdj.gasoline_ron91_95 = adjData.gasoline_ron91_95;
      if (adjData.diesel_std        && !baseAdj.diesel_std)        baseAdj.diesel_std        = adjData.diesel_std;
      if (adjData.kerosene          && !baseAdj.kerosene)          baseAdj.kerosene          = adjData.kerosene;
      if (adjData.lpg_per_kg        && !baseAdj.lpg_per_kg)        baseAdj.lpg_per_kg        = adjData.lpg_per_kg;
      console.log("[fuel] adjData used to fill nulls:", adjData);
    }
    result = {
      effective_date: today,
      week_label: `Week of ${today}`,
      doe_adjustment: baseAdj,
      prices: gwData.prices,
      advisories: gwData.advisories || [],
      next_week_forecast: forecastData,
      trend_context: "Live GasWatch PH data",
      next_week_signal: forecastData?.signal || null,
      fill_up_advice: null,
      sources: [GASWATCH_URLS[region] || GASWATCH_URLS.metro_manila]
    };
    source = "gaswatch";
    console.log("[fuel] GasWatch OK, ron91:", gwData.prices.petron.ron91);
  }

  // 2. Gemini fallback (if GasWatch fails)
  if (!result && geminiKey) {
    try {
      const raw = await geminiGenerate(geminiKey, buildFuelPrompt(today));
      const json = extractJSON(raw);
      if (!json.error && json.prices?.petron?.ron91 != null) {
        const r91 = Number(json.prices.petron.ron91);
        if (r91 >= 75 && r91 <= 115) {
          result = json;
          source = "gemini";
          console.log("[fuel] Gemini OK, ron91:", r91);
        }
      }
    } catch (e) {
      console.warn("[fuel] Gemini failed:", e.message);
    }
  }

  // 3. Groq fallback
  if (!result) {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      try {
        const raw = await groqSearch(buildFuelPrompt(today));
        const json = extractJSON(raw);
        if (!json.error && json.prices?.petron?.ron91 != null) {
          const r91 = Number(json.prices.petron.ron91);
          if (r91 >= 75 && r91 <= 115) {
            result = json;
            source = "groq";
            console.log("[fuel] Groq fallback OK, ron91:", r91);
          }
        }
      } catch (e) {
        console.warn("[fuel] Groq fallback failed:", e.message);
      }
    }
  }

  // 4. Honest fallback — no fake prices
  if (!result) {
    result = {
      effective_date: today,
      week_label: `Week of ${today}`,
      doe_adjustment: {
        gasoline_ron91_95: null,
        diesel_std: null,
        kerosene: null,
        lpg_per_kg: null,
        note: "Unable to fetch live prices. All data sources are unavailable."
      },
      prices: {
        petron: { ron91: null, ron95: null, ron100: null, diesel_std: null, diesel_prem: null, kerosene: null },
        shell:  { ron91: null, ron95: null, ron97: null, diesel_std: null, diesel_prem: null, kerosene: null },
        unioil: { ron91: null, ron95: null, diesel_std: null }
      },
      trend_context: "Unable to fetch live data. Please try refreshing in a few minutes.",
      next_week_signal: null,
      fill_up_advice: "Unable to fetch live prices. Please click Refresh or check back later.",
      sources: ["unavailable"]
    };
    source = "unavailable";
  }

  // Final guard: never send null advice
  if (!result.fill_up_advice) {
    result.fill_up_advice = "Prices are stable. Fill up based on your tank level and travel needs.";
  }

  result._meta = { source, cached_at: new Date().toISOString() };
  await setCache("fuel", result);
  res.setHeader("Cache-Control", "public, max-age=900");
  return res.status(200).json(result);
}

/* ── NGCP DIRECT SCRAPER ── */
async function fetchNGCPPage() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://www.ngcp.ph/', {
      signal: controller.signal,
      headers: MERALCO_BROWSER_HEADERS
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`NGCP HTTP ${res.status}`);
    const html = await res.text();
    return parseNGCPOutlook(html);
  } catch (e) { clearTimeout(timeout); throw e; }
}

function parseNGCPOutlook(html) {
  if (html.indexOf('table-dailyoutlook') === -1) throw new Error('PSO table not found in NGCP page');

  const extract = id => {
    const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
    return m ? m[1].trim() : null;
  };
  const pn = s => { const n = parseInt((s||'').replace(/[,\s]/g,''), 10); return isNaN(n) ? null : n; };

  const rawDate = extract('cell-ReportDate') || '';
  const asOf    = rawDate.replace(/[()]/g,'').replace(/as of /i,'').trim();
  const luzCap  = pn(extract('cell-LuzonCapacity'));
  const visCap  = pn(extract('cell-VisayasCapacity'));
  const minCap  = pn(extract('cell-MindanaoCapacity'));
  const luzDem  = pn(extract('cell-LuzonPeak'));
  const visDem  = pn(extract('cell-VisayasPeak'));
  const minDem  = pn(extract('cell-MindanaoPeak'));
  const luzMar  = pn(extract('cell-LuzonReserve'));
  const visMar  = pn(extract('cell-VisayasReserve'));
  const minMar  = pn(extract('cell-MindanaoReserve'));

  if (luzMar === null) throw new Error('Luzon margin not parsed');

  let level, color, bg, border, title, subtitle;
  if (luzMar < 0) {
    level='red'; color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)';
    title=`Luzon — Insufficient Supply (${luzMar.toLocaleString()} MW)`;
    subtitle=`Supply deficit. Rotating brownouts possible.`;
  } else if (luzMar < 600) {
    level='yellow'; color='#8a5a00'; bg='#fef3dc'; border='rgba(138,90,0,.2)';
    title=`Luzon — Yellow Alert (+${luzMar.toLocaleString()} MW)`;
    subtitle=`Reserve below threshold. No brownouts yet, but supply is tight.`;
  } else {
    level='normal'; color='#1a7a52'; bg='#e6f5ed'; border='rgba(26,122,82,.2)';
    title=`Luzon — Normal (+${luzMar.toLocaleString()} MW)`;
    subtitle=`Adequate operating reserve. No grid alert.`;
  }

  return {
    level, title, subtitle, color, bg, border, alert_times: [],
    pso: {
      as_of: asOf,
      luzon:    { capacity: luzCap, demand: luzDem, margin: luzMar },
      visayas:  { capacity: visCap, demand: visDem, margin: visMar },
      mindanao: { capacity: minCap, demand: minDem, margin: minMar }
    }
  };
}
/* ── POWER (Direct Meralco scrape + Gemini NGCP → Groq → Unavailable) ── */
async function handlePower(res) {
  const cached = await getCache("power");
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(cached);
  }

  const today = phDate();
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;

  // Run Meralco direct scrape + NGCP direct scrape in parallel
  const [meralcoResult, ngcpDirectResult] = await Promise.allSettled([
    fetchMeralcoPages(),
    fetchNGCPPage()
  ]);

  let meralcoData = meralcoResult.status === 'fulfilled' ? meralcoResult.value : null;
  // Wrap direct PSO result into the same shape as the Gemini response { grid_status }
  let ngcpData = ngcpDirectResult.status === 'fulfilled'
    ? { grid_status: ngcpDirectResult.value }
    : null;

  if (meralcoData) console.log("[power] Meralco direct OK, interruptions:", meralcoData.interruptions.length);
  else {
    console.warn("[power] Meralco direct failed:", meralcoResult.reason?.message, "— trying Firecrawl");
    try {
      const maintBase = 'https://company.meralco.com.ph/news-and-advisories/maintenance-schedule';
      const [alertHtml, mh0, mh1, mh2] = await Promise.all([
        firecrawlScrape('https://company.meralco.com.ph/news-and-advisories/yellow-and-red-alert-locations', 'html'),
        firecrawlScrape(maintBase, 'html'),
        firecrawlScrape(maintBase + '?page=1', 'html'),
        firecrawlScrape(maintBase + '?page=2', 'html'),
      ]);
      const maintHtml = [mh0, mh1, mh2].join('\n');
      meralcoData = {
        interruptions: [
          ...parseMeralcoAlertInterruptions(alertHtml),
          ...parseMeralcoMaintenanceInterruptions(maintHtml)
        ]
      };
      console.log("[power] Meralco Firecrawl OK, interruptions:", meralcoData.interruptions.length);
    } catch(e) { console.warn("[power] Meralco Firecrawl failed:", e.message); }
  }

  if (!ngcpData) {
    console.warn("[power] NGCP direct scrape failed:", ngcpDirectResult.reason?.message, "— trying Firecrawl");
    try {
      const html = await firecrawlScrape('https://www.ngcp.ph/', 'html');
      ngcpData = { grid_status: parseNGCPOutlook(html) };
      console.log("[power] NGCP Firecrawl OK");
    } catch(e) { console.warn("[power] NGCP Firecrawl failed:", e.message, "— trying Gemini"); }

    if (!ngcpData && geminiKey) {
      try {
        const raw = await geminiGenerate(geminiKey, buildNGCPPrompt(today));
        const json = extractJSON(raw);
        if (!json.error && json.grid_status) { ngcpData = json; console.log("[power] NGCP Gemini fallback OK, pso:", !!json.grid_status.pso); }
        else { console.warn("[power] NGCP Gemini bad response:", JSON.stringify(json).slice(0, 200)); }
      } catch (e) { console.warn("[power] NGCP Gemini fallback failed:", e.message); }
    }
  }

  let result = null;
  let source = null;

  // Case 1: have both scraped Meralco data and NGCP status
  if (meralcoData && ngcpData && ngcpData.grid_status) {
    result = {
      grid_status: ngcpData.grid_status,
      interruptions: meralcoData.interruptions,
      last_updated: today,
      sources: ['company.meralco.com.ph (direct)', 'ngcp.ph (direct)']
    };
    source = "direct+gemini";
  }

  // Case 2: Meralco scraped OK but NGCP query failed — try Groq for NGCP
  if (!result && meralcoData) {
    if (groqKey) {
      try {
        const raw = await groqSearch(buildNGCPPrompt(today));
        const json = extractJSON(raw);
        if (!json.error && json.grid_status) {
          result = {
            grid_status: json.grid_status,
            interruptions: meralcoData.interruptions,
            last_updated: today,
            sources: ['company.meralco.com.ph (direct)', 'ngcp.ph (via Groq)']
          };
          source = "direct+groq";
        }
      } catch (e) {
        console.warn("[power] Groq NGCP fallback failed:", e.message);
      }
    }
    // Even if NGCP fails, still return Meralco data with "normal" grid
    if (!result) {
      result = {
        grid_status: {
          level: "normal",
          title: "Luzon Grid — Status Unknown",
          subtitle: "NGCP live status unavailable. Grid status unconfirmed.",
          color: "#6b6a65",
          bg: "#f0efe9",
          border: "rgba(0,0,0,.1)",
          alert_times: []
        },
        interruptions: meralcoData.interruptions,
        last_updated: today,
        sources: ['company.meralco.com.ph (direct)']
      };
      source = "direct";
    }
  }

  // Case 3: Meralco scrape failed — fall back to full Gemini power prompt
  if (!result && geminiKey) {
    try {
      const raw = await geminiGenerate(geminiKey, buildPowerPrompt(today));
      const json = extractJSON(raw);
      if (!json.error && json.grid_status) {
        result = json;
        source = "gemini";
      }
    } catch (e) {
      console.warn("[power] Gemini full prompt failed:", e.message);
    }
  }

  // Case 4: All AI failed — try Groq full prompt
  if (!result && groqKey) {
    try {
      const raw = await groqSearch(buildPowerPrompt(today));
      const json = extractJSON(raw);
      if (!json.error && json.grid_status) {
        result = json;
        source = "groq";
      }
    } catch (e) {
      console.warn("[power] Groq full prompt failed:", e.message);
    }
  }

  if (!result) {
    result = {
      grid_status: {
        level: "normal",
        title: "Luzon Grid — Normal",
        subtitle: "Live data temporarily unavailable. Grid status assumed normal.",
        color: "#1a7a52",
        bg: "#e6f5ed",
        border: "rgba(26,122,82,.2)",
        alert_times: []
      },
      interruptions: [],
      last_updated: today,
      sources: ["unavailable"]
    };
    source = "unavailable";
  }

  result._meta = { source, cached_at: new Date().toISOString() };
  await setCache("power", result);
  res.setHeader("Cache-Control", "public, max-age=900");
  return res.status(200).json(result);
}



/* ── MAYNILAD SCRAPER ── */
async function fetchMayniladAdvisories() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch('https://www.mayniladwater.com.ph/', { signal: ctrl.signal, headers: MERALCO_BROWSER_HEADERS });
    clearTimeout(t);
    if (!r.ok) throw new Error(`Maynilad HTTP ${r.status}`);
    return parseMayniladAdvisories(await r.text());
  } catch(e) { clearTimeout(t); throw e; }
}

function parseMayniladAdvisories(html) {
  const m = html.match(/<ul[^>]+class="[^"]*homepage-advisories[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!m) throw new Error('homepage-advisories not found');
  const items = [];
  for (const liM of m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const spanM = liM[1].match(/<span[^>]*>([^<]+)<\/span>/i);
    const typeLabel = spanM ? spanM[1].trim() : 'Scheduled';
    const text = liM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const parts = text.split(/\s{2,}/);
    const date = parts[0] || '';
    const area = parts.slice(1).join(' ').trim();
    const tl = typeLabel.toLowerCase();
    const type = tl.includes('emergency') ? 'emergency' : tl.includes('rotational') ? 'rotational' : tl.includes('septic') ? 'maintenance' : 'scheduled';
    const cityRaw = area.split(/[;,]|\bat\b/i)[0].trim().replace(/\s+city\s*$/i, '').trim();
    items.push({ utility: 'Maynilad', type, typeLabel, city: cityRaw || 'Metro Manila', area, date });
  }
  return items;
}

/* ── MANILA WATER MARKDOWN PARSER (Firecrawl output) ── */
function parseManilWaterMarkdown(md) {
  const items = [];
  function parseSection(text, type, typeLabel) {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('|') || t.includes('---') || /start\s*date|begin\s*date/i.test(t)) continue;
      const cols = t.split('|').map(c => c.trim()).filter(c => c);
      if (cols.length < 4) continue;
      const [fromRaw, toRaw, city, location, activity, affected] = cols;
      if (!city || city.length > 80 || /city.*municipality/i.test(city)) continue;
      const fromDate = extractMDDate(fromRaw);
      const toDate   = extractMDDate(toRaw);
      const fromTime = extractMDTime(fromRaw);
      const toTime   = extractMDTime(toRaw);
      items.push({
        utility: 'Manila Water', type, typeLabel,
        city: city.replace(/\s*(city|municipality)\s*$/i, '').trim(),
        area: [location, affected].filter(Boolean).map(s => s.trim()).join(' · '),
        from: fromDate, to: toDate,
        time: fromTime && toTime ? `${fromTime} – ${toTime}` : (fromTime || toTime || null),
        reason: (activity || '').trim()
      });
    }
  }
  const maintIdx = md.search(/advisory on maintenance/i);
  const emergIdx = md.search(/advisory on emergency/i);
  if (maintIdx !== -1) parseSection(md.slice(maintIdx, emergIdx > maintIdx ? emergIdx : md.length), 'scheduled', 'Maintenance');
  if (emergIdx !== -1)  parseSection(md.slice(emergIdx), 'emergency', 'Emergency');
  return items;
}

function extractMDDate(s) {
  if (!s) return null;
  const m = s.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[\s.,]+\d{1,2}[,\s]+\d{4}/i);
  if (!m) return null;
  const d = new Date(m[0]);
  return isNaN(d.getTime()) ? m[0] : d.toISOString().split('T')[0];
}

function extractMDTime(s) {
  if (!s) return null;
  const m = s.match(/\d{1,2}:\d{2}\s*[ap]\.?m\.?/i);
  return m ? m[0].replace(/\./g, '').trim() : null;
}

/* ── GASWATCH MARKDOWN PARSER (Firecrawl output) ── */
function parseGasWatchMarkdown(md) {
  function grab(...patterns) {
    for (const pat of patterns) {
      const m = md.match(pat);
      if (m) { const n = parseFloat(m[1]); if (n > 50 && n < 200) return n; }
    }
    return 0;
  }
  const petronUnl = grab(/petron[\s\S]{0,300}?ron\s*91[^₱\d]*[₱]?\s*(\d+\.\d+)/i, /petron[\s\S]{0,300}?unleaded[^₱\d]*[₱]?\s*(\d+\.\d+)/i);
  const petronDsl = grab(/petron[\s\S]{0,300}?diesel[^₱\d]*[₱]?\s*(\d+\.\d+)/i);
  const shellUnl  = grab(/shell[\s\S]{0,300}?ron\s*91[^₱\d]*[₱]?\s*(\d+\.\d+)/i,  /shell[\s\S]{0,300}?unleaded[^₱\d]*[₱]?\s*(\d+\.\d+)/i);
  const shellDsl  = grab(/shell[\s\S]{0,300}?diesel[^₱\d]*[₱]?\s*(\d+\.\d+)/i);
  const unioilUnl = grab(/unioil[\s\S]{0,300}?ron\s*91[^₱\d]*[₱]?\s*(\d+\.\d+)/i, /unioil[\s\S]{0,300}?unleaded[^₱\d]*[₱]?\s*(\d+\.\d+)/i);
  const unioilDsl = grab(/unioil[\s\S]{0,300}?diesel[^₱\d]*[₱]?\s*(\d+\.\d+)/i);
  if (!petronUnl) return null;
  const r = (v, d) => v > 0 ? Math.round((v + d) * 100) / 100 : 0;
  return {
    prices: {
      petron: { ron91: petronUnl, ron95: r(petronUnl, 3.10), ron100: r(petronUnl, 13.15), diesel_std: petronDsl, diesel_prem: r(petronDsl, 4.25), kerosene: 0 },
      shell:  { ron91: shellUnl,  ron95: r(shellUnl,  3.10), ron97:  r(shellUnl,  6.64),  diesel_std: shellDsl,  diesel_prem: r(shellDsl,  4.70), kerosene: 0 },
      unioil: { ron91: unioilUnl, ron95: r(unioilUnl, 3.00), diesel_std: unioilDsl, kerosene: 0 }
    },
    adjustment: { gasoline_ron91_95: null, diesel_std: null, kerosene: null, lpg_per_kg: null, note: 'GasWatch PH (Firecrawl)' },
    foundCount: (petronUnl > 0 ? 1 : 0) + (shellUnl > 0 ? 1 : 0) + (unioilUnl > 0 ? 1 : 0),
    advisories: []
  };
}

/* ── WATER SUPPLY ── */
async function handleWater(res) {
  const cached = await getCache('water');
  if (cached) {
    return res.status(200).json({ ...cached, _meta: { source: 'cache', cached_at: cached._meta?.cached_at || new Date().toISOString() } });
  }

  const today = phDate();
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;

  // 1. Maynilad direct + Firecrawl Manila Water in parallel
  const [mayniladRes, manilaFcRes] = await Promise.allSettled([
    fetchMayniladAdvisories(),
    firecrawlScrape('https://www.manilawater.com/customers/service-advisories')
  ]);

  let interruptions = [];
  const sources = [];

  if (mayniladRes.status === 'fulfilled') {
    interruptions.push(...mayniladRes.value);
    sources.push('mayniladwater.com.ph (direct)');
    console.log('[water] Maynilad direct OK:', mayniladRes.value.length, 'items');
  } else {
    console.warn('[water] Maynilad direct failed:', mayniladRes.reason?.message);
  }

  let manilaWaterFromFC = false;
  if (manilaFcRes.status === 'fulfilled') {
    try {
      const mwItems = parseManilWaterMarkdown(manilaFcRes.value);
      interruptions.push(...mwItems);
      sources.push('manilawater.com (Firecrawl)');
      manilaWaterFromFC = true;
      console.log('[water] Manila Water Firecrawl OK:', mwItems.length, 'items');
    } catch(e) { console.warn('[water] Manila Water FC parse failed:', e.message); }
  } else {
    console.warn('[water] Manila Water Firecrawl failed:', manilaFcRes.reason?.message);
  }

  // 2. AI fallback for Manila Water advisories only (if Firecrawl failed)
  if (!manilaWaterFromFC) {
    let aiRaw = null;
    if (geminiKey) {
      try {
        aiRaw = await geminiGenerate(geminiKey, buildWaterPrompt(today));
        sources.push('gemini (Manila Water)');
      } catch(e) { console.warn('[water] Gemini failed:', e.message, '— trying Groq'); }
    }
    if (!aiRaw && groqKey) {
      try {
        aiRaw = await groqSearch(buildWaterPrompt(today));
        sources.push('groq (Manila Water)');
        console.log('[water] Groq fallback OK');
      } catch(e) { console.warn('[water] Groq fallback failed:', e.message); }
    }
    if (aiRaw) {
      const json = extractJSON(aiRaw);
      if (!json.error && json.interruptions) {
        interruptions.push(...json.interruptions.filter(i => i.utility === 'Manila Water'));
        if (mayniladRes.status !== 'fulfilled')
          interruptions.push(...json.interruptions.filter(i => i.utility === 'Maynilad'));
      } else {
        console.warn('[water] AI bad response:', JSON.stringify(json).slice(0, 150));
      }
    }
  }

  const result = { interruptions, last_updated: today, sources };
  result._meta = { source: sources.join(', ') || 'unavailable', cached_at: new Date().toISOString() };
  await setCache('water', result);
  res.setHeader('Cache-Control', 'public, max-age=900');
  return res.status(200).json(result);
}

/* ── PAGASA FLOOD PAGE SCRAPER ── */
async function fetchPAGASAPage() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch('https://www.pagasa.dost.gov.ph/flood', {
      signal: ctrl.signal, headers: MERALCO_BROWSER_HEADERS
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`PAGASA HTTP ${r.status}`);
    return await r.text();
  } catch(e) { clearTimeout(t); throw e; }
}
async function fetchPAGASADams() {
  return parsePAGASADamTable(await fetchPAGASAPage());
}

function parsePAGASADamTable(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const getText = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const pf = s => { const n = parseFloat(s); return isNaN(n) ? null : n; };

  for (const tableM of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const tbl = tableM[0];
    if (!/angat|pantabangan|magat/i.test(tbl)) continue;
    const dams = [];
    for (const rowM of tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rowM[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => getText(m[1]));
      if (cells.length < 5) continue;
      const name = cells[0];
      if (!name || name.length > 40 || !/[a-zA-Z]/.test(name)) continue;
      if (/reservoir|water.?level|observation|nhwl|dam.?name/i.test(name)) continue;
      if (/^\d{1,2}:\d{2}\s*(am|pm)/i.test(name)) continue;
      const rwl = pf(cells[2]), nhwl = pf(cells[4]);
      if (!rwl || !nhwl) continue;
      const dev24h = pf(cells[3]), devNHWL = pf(cells[5]);
      const dev = devNHWL ?? (rwl - nhwl);
      let status, statusLabel, color, bg, border;
      if (dev >= -5)        { status='high';     statusLabel='Near Full';    color='#1a4fa0'; bg='#e8effe'; border='rgba(26,79,160,.2)'; }
      else if (dev >= -20)  { status='normal';   statusLabel='Normal';       color='#1a7a52'; bg='#e6f5ed'; border='rgba(26,122,82,.2)'; }
      else if (dev >= -40)  { status='low';      statusLabel='Low';          color='#8a5a00'; bg='#fef3dc'; border='rgba(138,90,0,.2)'; }
      else                  { status='critical'; statusLabel='Critical Low'; color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)'; }
      dams.push({ name, obs_time: cells[1]||'', rwl, nhwl, dev_24h: dev24h, dev_nhwl: devNHWL,
        rule_curve: pf(cells[6]), dev_rule: pf(cells[7]), gate: cells[8]||null,
        status, statusLabel, color, bg, border });
    }
    if (dams.length >= 3) return dams;
  }
  throw new Error('No dam table found in PAGASA page');
}

function parsePAGASAFloodWatch(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const getText = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  for (const tableM of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const tbl = tableM[0];
    if (!/MAJOR RIVER BASINS/i.test(tbl)) continue;
    const basins = [], subBasins = [];
    let section = 'basins';
    for (const rowM of tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rowM[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(m => getText(m[1]));
      if (cells.length < 2) continue;
      const [name, status] = cells;
      if (!name) continue;
      if (/DAMS.*SUB.?BASIN|SUB.?BASIN.*STATUS/i.test(name + status)) { section = 'subbasins'; continue; }
      if (/STATUS|MAJOR RIVER|18 MAJOR/i.test(name)) continue;
      if (section === 'basins') basins.push({ name, status });
      else subBasins.push({ name, status });
    }
    if (basins.length > 0) return { basins, subBasins };
  }
  return { basins: [], subBasins: [] };
}

const FFWS_BASE = 'https://pasig-marikina-tullahanffws.pagasa.dost.gov.ph';

async function fetchFFWSData() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const hdrs = { 'Referer': FFWS_BASE + '/', 'User-Agent': MERALCO_BROWSER_HEADERS['User-Agent'] };
    const [wlRes, rfRes] = await Promise.all([
      fetch(FFWS_BASE + '/water/main_list.do',   { signal: ctrl.signal, headers: hdrs }),
      fetch(FFWS_BASE + '/rainfall/main_list.do', { signal: ctrl.signal, headers: hdrs })
    ]);
    clearTimeout(t);
    const pfWL = s => { if (s == null) return null; const n = parseFloat(String(s).replace(/[^0-9.-]/g, '')); return isNaN(n) ? null : n; };
    const wlRaw = wlRes.ok ? await wlRes.json() : [];
    const rfRaw = rfRes.ok ? await rfRes.json() : [];

    const stations = wlRaw.map(s => {
      const wl = pfWL(s.wl), alertwl = pfWL(s.alertwl), alarmwl = pfWL(s.alarmwl), criticalwl = pfWL(s.criticalwl);
      let level = 'normal', levelLabel = 'Normal', color = '#1a7a52', bg = '#e6f5ed', border = 'rgba(26,122,82,.2)';
      if      (wl != null && criticalwl != null && wl >= criticalwl) { level='critical'; levelLabel='Critical'; color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)'; }
      else if (wl != null && alarmwl    != null && wl >= alarmwl)    { level='alarm';    levelLabel='Alarm';    color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)'; }
      else if (wl != null && alertwl    != null && wl >= alertwl)    { level='alert';    levelLabel='Alert';    color='#8a5a00'; bg='#fef3dc'; border='rgba(138,90,0,.2)'; }
      return { name: s.obsnm, wl, alertwl, alarmwl, criticalwl,
        wl1h: pfWL(s.wl1h), wl2h: pfWL(s.wl2h), change: pfWL(s.wlchange),
        time: s.timestr, level, levelLabel, color, bg, border };
    }).filter(s => s.name && s.wl != null);

    const rainfall = rfRaw.map(s => {
      const rfday = pfWL(s.rfday), rf1h = pfWL(s.rf01h), rf3h = pfWL(s.rf03h), rf30m = pfWL(s.rf30m);
      let intensity = 'none', intensityLabel = 'No Rain', color = '#9e9d97', bg = 'var(--surface)', border = 'var(--border)';
      if (rfday != null) {
        if      (rfday >= 65)  { intensity='extreme';  intensityLabel='Extreme';  color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)'; }
        else if (rfday >= 30)  { intensity='heavy';    intensityLabel='Heavy';    color='#8a5a00'; bg='#fef3dc'; border='rgba(138,90,0,.2)'; }
        else if (rfday >= 15)  { intensity='moderate'; intensityLabel='Moderate'; color='#1a4fa0'; bg='#e8effe'; border='rgba(26,79,160,.2)'; }
        else if (rfday >= 2.5) { intensity='light';    intensityLabel='Light';    color='#1a7a52'; bg='#e6f5ed'; border='rgba(26,122,82,.2)'; }
      }
      return { name: s.obsnm, rfday, rf1h, rf3h, rf30m, time: s.timestr, intensity, intensityLabel, color, bg, border };
    }).filter(s => s.name && s.rfday != null);

    console.log(`[waterlevel] FFWS OK: ${stations.length} WL stations, ${rainfall.length} rainfall stations`);
    return { stations, rainfall, obs_time: wlRaw[0]?.timestr || rfRaw[0]?.timestr || null };
  } catch(e) { clearTimeout(t); throw e; }
}

/* ── WATER LEVEL HANDLER ── */
async function handleWaterLevel(res) {
  const cached = await getCache('waterlevel');
  if (cached) {
    return res.status(200).json({ ...cached, _meta: { source: 'cache', cached_at: cached._meta?.cached_at || new Date().toISOString() } });
  }
  const today = phDate();
  let dams = [], floodWatch = null, stations = [], rainfall = [];
  const sources = [];

  // Fetch PAGASA page + FFWS data in parallel
  const [pagasaResult, ffwsResult] = await Promise.allSettled([
    (async () => {
      let html;
      try {
        html = await fetchPAGASAPage();
        sources.push('pagasa.dost.gov.ph');
      } catch(e) {
        console.warn('[waterlevel] PAGASA direct failed:', e.message, '— trying Firecrawl');
        html = await firecrawlScrape('https://www.pagasa.dost.gov.ph/flood', 'html');
        sources.push('pagasa.dost.gov.ph (Firecrawl)');
      }
      return { dams: parsePAGASADamTable(html), floodWatch: parsePAGASAFloodWatch(html) };
    })(),
    fetchFFWSData()
  ]);

  if (pagasaResult.status === 'fulfilled') {
    dams       = pagasaResult.value.dams;
    floodWatch = pagasaResult.value.floodWatch;
    console.log(`[waterlevel] PAGASA OK: ${dams.length} dams, ${floodWatch?.basins?.length||0} basins`);
  } else {
    console.warn('[waterlevel] PAGASA failed:', pagasaResult.reason?.message);
  }

  if (ffwsResult.status === 'fulfilled') {
    stations = ffwsResult.value.stations;
    rainfall = ffwsResult.value.rainfall;
    sources.push('PAGASA FFWS');
  } else {
    console.warn('[waterlevel] FFWS failed:', ffwsResult.reason?.message);
  }

  const result = { dams, flood_watch: floodWatch, stations, rainfall,
    obs_time: dams[0]?.obs_time || null,
    ffws_time: ffwsResult.status === 'fulfilled' ? ffwsResult.value.obs_time : null,
    last_updated: today, sources };
  result._meta = { source: sources.join(', ') || 'unavailable', cached_at: new Date().toISOString() };
  await setCache('waterlevel', result);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json(result);
}

function buildWaterPrompt(today) {
  return `Today is ${today} Philippines. Go to https://www.manilawater.com/customers/service-advisories and read the two tables: "Advisory on Maintenance Activities" and "Advisory on Emergency Works". Each row has: Start datetime, End datetime, Affected City/Municipality, Location of Activity, Activity, Affected Areas. Extract ALL rows from both tables.

Return ONLY compact JSON, no markdown:
{"interruptions":[{"utility":"Manila Water","typeLabel":"Maintenance OR Emergency","type":"scheduled OR emergency","city":"ACTUAL_CITY","area":"ACTUAL_STREET · ACTUAL_BARANGAY","from":"ACTUAL_START_DATE","to":"ACTUAL_END_DATE","time":"ACTUAL_TIME_WINDOW","reason":"ACTUAL_ACTIVITY"}]}

type="emergency" for Emergency Works rows, type="scheduled" for Maintenance rows. If no advisories found return {"interruptions":[]}.`;
}

/* ── GASWATCH PH DATA.JS SCRAPER ── */

// Extract a JS object/array block starting at `startIdx` in `src` using brace counting.
function extractBlock(src, startIdx) {
  const open  = src[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0, i = startIdx;
  while (i < src.length) {
    if (src[i] === open)  depth++;
    if (src[i] === close) { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
    i++;
  }
  return null;
}

// Parse a number from a key:value pattern, e.g.  diesel: 79.90
function grabNum(src, key) {
  const m = src.match(new RegExp(key + '\\s*:\\s*([0-9]+\\.?[0-9]*)'));
  return m ? parseFloat(m[1]) : 0;
}

// Extract the object/array block for a named brand key within a parent block.
function getBrandBlockIn(src, name) {
  const idx = src.toLowerCase().indexOf(name.toLowerCase() + ':');
  if (idx === -1) return null;
  const bs = src.indexOf('{', idx);
  return bs === -1 ? null : extractBlock(src, bs);
}

async function scrapeGasWatch(_region) {
  const DATA_JS_URL = "https://gaswatchph.com/js/data.js";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(DATA_JS_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PricePH/1.0)" }
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error("data.js HTTP " + res.status);
    const js = await res.text();

    /* ── 1. Current week prices from PRICE_HISTORY[0].brands ── */
    // Search for the actual declaration "PRICE_HISTORY = [" to skip any earlier references
    const phDeclMatch = js.match(/PRICE_HISTORY\s*=\s*\[/);
    if (!phDeclMatch) throw new Error("PRICE_HISTORY declaration not found in data.js");
    const arrStart = js.indexOf('[', phDeclMatch.index);
    // First object in the array = current week
    const objStart = js.indexOf('{', arrStart);
    const weekBlock = extractBlock(js, objStart);
    if (!weekBlock) throw new Error("Could not extract current week block");

    // Find brands: { … } inside that week block
    const brandsIdx = weekBlock.indexOf('brands');
    const brandsStart = weekBlock.indexOf('{', brandsIdx);
    const brandsBlock = extractBlock(weekBlock, brandsStart);
    if (!brandsBlock) throw new Error("brands block not found");

    // Per-brand blocks
    function getBrandBlock(name) {
      const idx = brandsBlock.toLowerCase().indexOf(name.toLowerCase() + ':');
      if (idx === -1) return null;
      const bs = brandsBlock.indexOf('{', idx);
      return bs === -1 ? null : extractBlock(brandsBlock, bs);
    }

    const petronB = getBrandBlock('petron');
    const shellB  = getBrandBlock('shell');
    const unioilB = getBrandBlock('unioil');

    const petronDiesel   = petronB ? grabNum(petronB, 'diesel')   : 0;
    const petronUnleaded = petronB ? grabNum(petronB, 'unleaded') : 0;
    const shellDiesel    = shellB  ? grabNum(shellB,  'diesel')   : 0;
    const shellUnleaded  = shellB  ? grabNum(shellB,  'unleaded') : 0;
    const unioilDiesel   = unioilB ? grabNum(unioilB, 'diesel')   : 0;
    const unioilUnleaded = unioilB ? grabNum(unioilB, 'unleaded') : 0;

    if (petronUnleaded < 50 || petronUnleaded > 200) {
      throw new Error("Unrealistic petron unleaded from data.js: " + petronUnleaded);
    }

    /* ── 2. Previous prices from PREVIOUS_PRICES ── */
    const ppDeclMatch = js.match(/PREVIOUS_PRICES\s*=\s*\{/);
    let prevPetronKero = 0, prevShellKero = 0, prevUnioilKero = 0;
    let prevPetronDiesel = 0, prevShellDiesel = 0;
    if (ppDeclMatch) {
      const ppStart = js.indexOf('{', ppDeclMatch.index);
      const ppBlock = extractBlock(js, ppStart);
      if (ppBlock) {
        const ppPetron = getBrandBlockIn(ppBlock, 'petron');
        const ppShell  = getBrandBlockIn(ppBlock, 'shell');
        const ppUnioil = getBrandBlockIn(ppBlock, 'unioil');
        if (ppPetron) {
          prevPetronKero  = grabNum(ppPetron, 'kerosene');
          prevPetronDiesel = grabNum(ppPetron, 'diesel');
        }
        if (ppShell)  {
          prevShellKero   = grabNum(ppShell,  'kerosene');
          prevShellDiesel = grabNum(ppShell,  'diesel');
        }
        if (ppUnioil) prevUnioilKero = grabNum(ppUnioil, 'kerosene');
      }
    }

    /* ── 3. Adjustments from advisory title ──
       Format: "diesel −₱9.57, gasoline +₱0.47, kerosene −₱13.30"
       Unicode minus U+2212 (−) and regular hyphen both used. */
    function parseAdvisoryAdj(label) {
      // Match optional sign/minus then digits
      const m = label.match(/([+\-−])\s*[₱₱]?\s*([0-9]+\.[0-9]+)/);
      if (!m) return null;
      const sign = (m[1] === '+') ? '+' : '-';
      return sign + parseFloat(m[2]).toFixed(2);
    }

    let adjGasoline = null, adjDiesel = null, adjKerosene = null, adjLpg = null;

    // Look for advisory/announcement title text.
    // In data.js: ADVISORIES[0].title = "May 12 big rollback: diesel −₱9.57, gasoline +₱0.47, kerosene −₱13.30"
    const advPatterns = [
      /title\s*:\s*["'`]([^"'`]*(?:diesel|gasoline)[^"'`]*)["'`]/i,
      /advisory[_\s]?title\s*:\s*["'`]([^"'`]+)["'`]/i,
      /["'`]([^"'`]*diesel[^"'`]*gasoline[^"'`]*)["'`]/i,
    ];
    for (const pat of advPatterns) {
      const am = js.match(pat);
      if (!am) continue;
      const title = am[1];
      // Extract each fuel type from the title
      const gasolineM = title.match(/gasoline\s*([+\-−][₱₱]?[0-9]+\.[0-9]+)/i);
      const dieselM   = title.match(/diesel\s*([+\-−][₱₱]?[0-9]+\.[0-9]+)/i);
      const keroseneM = title.match(/kerosene\s*([+\-−][₱₱]?[0-9]+\.[0-9]+)/i);
      const lpgM      = title.match(/lpg\s*([+\-−][₱₱]?[0-9]+\.[0-9]+)/i);
      if (gasolineM) adjGasoline = parseAdvisoryAdj(gasolineM[1]);
      if (dieselM)   adjDiesel   = parseAdvisoryAdj(dieselM[1]);
      if (keroseneM) adjKerosene = parseAdvisoryAdj(keroseneM[1]);
      if (lpgM)      adjLpg      = parseAdvisoryAdj(lpgM[1]);
      if (adjDiesel || adjGasoline) break;
    }

    // Fallback: scan all quoted strings for adjustment patterns
    if (!adjDiesel && !adjGasoline) {
      const allStrings = js.matchAll(/["'`]([^"'`]{20,200})["'`]/g);
      for (const sm of allStrings) {
        const s = sm[1];
        if (!/diesel/i.test(s) || !/gasoline/i.test(s)) continue;
        const gasolineM = s.match(/gasoline\s*([+\-−][₱₱]?[0-9]+\.[0-9]+)/i);
        const dieselM   = s.match(/diesel\s*([+\-−][₱₱]?[0-9]+\.[0-9]+)/i);
        const keroseneM = s.match(/kerosene\s*([+\-−][₱₱]?[0-9]+\.[0-9]+)/i);
        const lpgM      = s.match(/lpg\s*([+\-−][₱₱]?[0-9]+\.[0-9]+)/i);
        if (gasolineM) adjGasoline = parseAdvisoryAdj(gasolineM[1]);
        if (dieselM)   adjDiesel   = parseAdvisoryAdj(dieselM[1]);
        if (keroseneM) adjKerosene = parseAdvisoryAdj(keroseneM[1]);
        if (lpgM)      adjLpg      = parseAdvisoryAdj(lpgM[1]);
        if (adjDiesel || adjGasoline) break;
      }
    }

    /* ── 4. Compute kerosene current price = prev + adjustment ── */
    const keroAdj = adjKerosene ? parseFloat(adjKerosene) : 0;

    const petronKerosene = prevPetronKero > 50
      ? Math.round((prevPetronKero + keroAdj) * 100) / 100
      : 0;
    const shellKerosene  = prevShellKero  > 50
      ? Math.round((prevShellKero  + keroAdj) * 100) / 100
      : 0;
    const unioilKerosene = prevUnioilKero > 50
      ? Math.round((prevUnioilKero + keroAdj) * 100) / 100
      : 0;

    /* ── 5. Build price object ── */
    const prices = {
      petron: {
        ron91:       petronUnleaded,
        ron95:       petronUnleaded > 0 ? Math.round((petronUnleaded + 3.10) * 100) / 100 : 0,
        ron100:      petronUnleaded > 0 ? Math.round((petronUnleaded + 13.15) * 100) / 100 : 0,
        diesel_std:  petronDiesel,
        diesel_prem: petronDiesel  > 0 ? Math.round((petronDiesel  + 4.25) * 100) / 100 : 0,
        kerosene:    petronKerosene
      },
      shell: {
        ron91:       shellUnleaded,
        ron95:       shellUnleaded > 0 ? Math.round((shellUnleaded + 3.10) * 100) / 100 : 0,
        ron97:       shellUnleaded > 0 ? Math.round((shellUnleaded + 6.64) * 100) / 100 : 0,
        diesel_std:  shellDiesel,
        diesel_prem: shellDiesel   > 0 ? Math.round((shellDiesel   + 4.70) * 100) / 100 : 0,
        kerosene:    shellKerosene
      },
      unioil: {
        ron91:      unioilUnleaded,
        ron95:      unioilUnleaded > 0 ? Math.round((unioilUnleaded + 3.00) * 100) / 100 : 0,
        diesel_std: unioilDiesel,
        kerosene:   unioilKerosene
      }
    };

    const adjustment = {
      gasoline_ron91_95: adjGasoline,
      diesel_std:        adjDiesel,
      kerosene:          adjKerosene,
      lpg_per_kg:        adjLpg,
      note: "GasWatch PH community + DOE data"
    };

    const foundCount = (petronUnleaded > 0 ? 1 : 0) + (shellUnleaded > 0 ? 1 : 0) + (unioilUnleaded > 0 ? 1 : 0);

    /* ── 6. Parse ADVISORIES (current + upcoming) ── */
    const advisories = [];
    try {
      const advDeclMatch = js.match(/ADVISORIES\s*=\s*\[/);
      if (advDeclMatch) {
        const advArrStart = js.indexOf('[', advDeclMatch.index);
        const advArrBlock = extractBlock(js, advArrStart);
        if (advArrBlock) {
          let pos = 1;
          while (pos < advArrBlock.length && advisories.length < 6) {
            const ob = advArrBlock.indexOf('{', pos);
            if (ob === -1) break;
            const objBlock = extractBlock(advArrBlock, ob);
            if (!objBlock) break;
            const dateM  = objBlock.match(/date\s*:\s*["'`]([^"'`\n]+)["'`]/);
            const titleM = objBlock.match(/title\s*:\s*["'`]([^"'`\n]+)["'`]/);
            const bodyM  = objBlock.match(/body\s*:\s*["'`]([^"'`]+)["'`]/);
            const typeM  = objBlock.match(/type\s*:\s*["'`]([^"'`\n]+)["'`]/);
            if (dateM && titleM) {
              advisories.push({
                date:  dateM[1],
                title: titleM[1],
                body:  bodyM ? bodyM[1].replace(/\s+/g, ' ').trim() : null,
                type:  typeM ? typeM[1] : 'info'
              });
            }
            pos = ob + objBlock.length;
          }
        }
      }
    } catch (e) {
      console.warn("[scrapeGasWatch] ADVISORIES parse failed:", e.message);
    }

    return { prices, adjustment, foundCount, advisories };

  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

/* ── DOE OIL MONITOR SCRAPER (primary adjustment source) ── */
async function scrapeDOEOilMonitor() {
  const url = "https://legacy.doe.gov.ph/oil-monitor";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
      redirect: "follow"
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();

    // Strip scripts/styles and collapse whitespace for text pattern matching
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ');

    const dateMatch = text.match(/Oil Monitor as of (\d+\s+\w+\s+\d{4})/i);

    // Parses text like "Kerosene: P13.30/liter decrease" or "price decrease of P9.57/liter for diesel"
    function parseAdj(keyword) {
      // Pattern A: "Keyword: P13.30/liter decrease"
      let m = text.match(new RegExp(keyword + '[^.\\d]{0,30}P([\\d.]+)[^.\\d]{0,30}(increase|decrease|rollback|reduction)', 'i'));
      if (m) return (/(decrease|rollback|reduction)/i.test(m[2]) ? '-' : '+') + m[1];
      // Pattern B: "price decrease of P13.30/liter for keyword"
      m = text.match(new RegExp('(increase|decrease|rollback)[^.\\d]{0,40}P([\\d.]+)\\/liter[^.]{0,60}' + keyword, 'i'));
      if (m) return (/(decrease|rollback)/i.test(m[1]) ? '-' : '+') + m[2];
      // Pattern C: "keyword ... decreased/increased ... P13.30"
      m = text.match(new RegExp(keyword + '[^.]{0,120}(increased|decreased|rollback)[^.\\d]{0,15}P([\\d.]+)', 'i'));
      if (m) return (/(decreased|rollback)/i.test(m[1]) ? '-' : '+') + m[2];
      return null;
    }

    const adj = {
      gasoline_ron91_95: parseAdj('gasoline') || parseAdj('unleaded'),
      diesel_std:        parseAdj('diesel'),
      kerosene:          parseAdj('kerosene'),
      lpg_per_kg:        parseAdj('lpg'),
      note: dateMatch ? `DOE Oil Monitor as of ${dateMatch[1]}` : "DOE Oil Monitor (doe.gov.ph)"
    };

    if (!adj.gasoline_ron91_95 && !adj.diesel_std && !adj.kerosene) {
      throw new Error("No adjustment data parsed from DOE page");
    }
    console.log("[doe] adjustment scraped:", adj);
    return adj;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

/* ── DOE ADJUSTMENT AUGMENT ── */
async function fetchDOEAdjustment(today, geminiKey, groqKey) {
  // 1. DOE oil monitor — authoritative source, structured text
  try {
    const doeAdj = await scrapeDOEOilMonitor();
    if (doeAdj && (doeAdj.kerosene || doeAdj.diesel_std)) return doeAdj;
  } catch (e) {
    console.warn("[adj] DOE scraper failed:", e.message);
  }

  // 2. AI fallback — both sources in parallel, merge best non-null values
  const prompt = buildAdjustmentPrompt(today);
  const results = await Promise.allSettled([
    geminiKey ? geminiGenerate(geminiKey, prompt).then(r => extractJSON(r)) : Promise.resolve(null),
    groqKey   ? groqSearch(prompt).then(r => extractJSON(r))               : Promise.resolve(null)
  ]);
  const merged = { gasoline_ron91_95: null, diesel_std: null, kerosene: null, lpg_per_kg: null, note: null };
  let anyFound = false;
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value || r.value.error) continue;
    const adj = r.value.doe_adjustment || r.value;
    if (!adj || typeof adj !== 'object') continue;
    if (adj.gasoline_ron91_95 && !merged.gasoline_ron91_95) merged.gasoline_ron91_95 = String(adj.gasoline_ron91_95);
    if (adj.diesel_std        && !merged.diesel_std)        merged.diesel_std        = String(adj.diesel_std);
    if (adj.kerosene          && !merged.kerosene)          merged.kerosene          = String(adj.kerosene);
    if (adj.lpg_per_kg        && !merged.lpg_per_kg)        merged.lpg_per_kg        = String(adj.lpg_per_kg);
    if (adj.note              && !merged.note)              merged.note              = adj.note;
    anyFound = true;
  }
  console.log("[adj] AI merged:", merged);
  return anyFound ? merged : null;
}

/* ── PROMPT BUILDERS ── */
function buildAdjustmentPrompt(today) {
  return `Today is ${today} Philippines. Search GMA Network, Rappler, BusinessMirror, or doe.gov.ph for this week's DOE oil price adjustment. You MUST find the kerosene adjustment separately — it is different from diesel. Return ONLY compact JSON, no markdown, no text outside the JSON.
{"doe_adjustment":{"gasoline_ron91_95":null,"diesel_std":null,"kerosene":null,"lpg_per_kg":null,"note":null}}
Rules: values are signed strings ("-13.30" = rollback ₱13.30/L, "+0.20" = increase ₱0.20/L). Do NOT reuse the diesel value for kerosene — look up kerosene specifically. Use null only if not found after searching.`;
}

function buildFuelPrompt(today) {
  return `Today is ${today}. Search gaswatchph.com and doe.gov.ph for: (1) current PH pump prices for Petron, Shell, and Unioil, and (2) this week's DOE-announced price adjustment (rollback or increase per liter). Current realistic ranges: RON91 ₱75-90, RON95 ₱78-93, diesel ₱70-90. The doe_adjustment fields must be signed strings like "+0.20" or "-9.57" — use null only if truly unavailable. Return ONLY compact JSON, no markdown, no explanation.
{"effective_date":"${today}","week_label":"Week of ${today}","doe_adjustment":{"gasoline_ron91_95":null,"diesel_std":null,"kerosene":null,"lpg_per_kg":null,"note":null},"prices":{"petron":{"ron91":null,"ron95":null,"ron100":null,"diesel_std":null,"diesel_prem":null,"kerosene":null},"shell":{"ron91":null,"ron95":null,"ron97":null,"diesel_std":null,"diesel_prem":null,"kerosene":null},"unioil":{"ron91":null,"ron95":null,"diesel_std":null}},"trend_context":null,"next_week_signal":null,"fill_up_advice":null,"sources":[]}`;
}

function buildForecastPrompt(today) {
  return `Today is ${today} Philippines. Search Philippine news (Rappler, GMA News, BusinessMirror, Inquirer, ABS-CBN, or doe.gov.ph) for the NEXT weekly DOE fuel price adjustment — the one taking effect NEXT Tuesday, not this week's. DOE typically pre-announces it on Thursday or Friday. Return ONLY compact JSON:
{"next_week_forecast":{"gasoline":null,"diesel":null,"kerosene":null,"lpg":null,"signal":"unknown","confidence":"unknown","note":null}}
Rules: gasoline/diesel/kerosene/lpg = signed strings like "-2.00" or "+1.50" per liter; signal = "increase", "rollback", "mixed", or "stable"; confidence = "confirmed" (DOE official), "expected" (analyst forecast), or "unknown"; note = 1-2 sentence summary of what to expect. Return null values if no next-week forecast is available yet.`;
}

async function fetchNextWeekForecast(today, geminiKey, groqKey) {
  const prompt = buildForecastPrompt(today);
  if (geminiKey) {
    try {
      const raw = await geminiGenerate(geminiKey, prompt);
      const json = extractJSON(raw);
      if (!json.error && json.next_week_forecast) {
        const f = json.next_week_forecast;
        if (f.gasoline || f.diesel || f.kerosene || f.note) {
          console.log("[forecast] Gemini OK");
          return f;
        }
      }
    } catch (e) {
      console.warn("[forecast] Gemini failed:", e.message, "— trying Groq");
    }
  }
  if (groqKey) {
    try {
      const raw = await groqSearch(prompt);
      const json = extractJSON(raw);
      if (!json.error && json.next_week_forecast) {
        const f = json.next_week_forecast;
        if (f.gasoline || f.diesel || f.kerosene || f.note) {
          console.log("[forecast] Groq OK");
          return f;
        }
        console.log("[forecast] Groq: no forecast data yet (DOE not announced)");
      }
    } catch (e) {
      console.warn("[forecast] Groq failed:", e.message);
    }
  }
  return null;
}

/* ── MERALCO DIRECT SCRAPER ── */
const MERALCO_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
};

async function fetchMeralcoPages() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const maintBase = 'https://company.meralco.com.ph/news-and-advisories/maintenance-schedule';
    const [alertRes, m0, m1, m2, m3, m4] = await Promise.all([
      fetch('https://company.meralco.com.ph/news-and-advisories/yellow-and-red-alert-locations',
        { signal: controller.signal, headers: MERALCO_BROWSER_HEADERS }),
      fetch(maintBase,            { signal: controller.signal, headers: MERALCO_BROWSER_HEADERS }),
      fetch(maintBase + '?page=1', { signal: controller.signal, headers: MERALCO_BROWSER_HEADERS }),
      fetch(maintBase + '?page=2', { signal: controller.signal, headers: MERALCO_BROWSER_HEADERS }),
      fetch(maintBase + '?page=3', { signal: controller.signal, headers: MERALCO_BROWSER_HEADERS }),
      fetch(maintBase + '?page=4', { signal: controller.signal, headers: MERALCO_BROWSER_HEADERS }),
    ]);
    clearTimeout(timeout);
    if (!alertRes.ok) throw new Error(`Alert page HTTP ${alertRes.status}`);
    if (!m0.ok) throw new Error(`Maint page HTTP ${m0.status}`);
    const [alertHtml, mh0, mh1, mh2, mh3, mh4] = await Promise.all([
      alertRes.text(),
      m0.text(),
      m1.ok ? m1.text() : Promise.resolve(''),
      m2.ok ? m2.text() : Promise.resolve(''),
      m3.ok ? m3.text() : Promise.resolve(''),
      m4.ok ? m4.text() : Promise.resolve(''),
    ]);
    const maintHtml = [mh0, mh1, mh2, mh3, mh4].join('\n');
    const alertParseable = alertHtml.includes('mld-report-wrapper') || alertHtml.includes('faq-item') || alertHtml.includes('yellow') || alertHtml.includes('red alert');
    const maintParseable = maintHtml.includes('views-col') || maintHtml.includes('field-content') || maintHtml.includes('maintenance');
    if (!alertParseable && !maintParseable) {
      throw new Error('Meralco page structure unrecognised — falling back to AI');
    }
    return {
      interruptions: [
        ...parseMeralcoAlertInterruptions(alertHtml),
        ...parseMeralcoMaintenanceInterruptions(maintHtml)
      ]
    };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function parseMeralcoAlertInterruptions(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

  // Determine alert level — search the article body section, not nav/title text.
  // Look for "Red Alert Locations" or "Yellow Alert Locations" h3 heading specifically.
  const articleIdx = html.indexOf('node-field');
  const checkText  = articleIdx !== -1 ? html.substring(articleIdx, articleIdx + 80000) : html.substring(0, 80000);

  // If system condition is explicitly Normal, no active alert regardless of page heading
  if (/system\s+condition[:\s]+normal/i.test(checkText)) return [];

  // Prioritise specific heading pattern to avoid false match from page title "Red & Yellow Alert"
  const isRed    = /red\s+alert\s+locations/i.test(checkText);
  const isYellow = !isRed && /yellow\s+alert\s+locations/i.test(checkText);
  if (!isRed && !isYellow) return [];

  const alertLabel = isRed
    ? 'Red Alert — Manual Load Dropping (MLD)'
    : 'Yellow Alert — Possible Load Reduction';

  // Date (e.g. "MAY 15, 2026")
  const dateM = html.match(/\b((?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\w*\s+\d{1,2},\s+\d{4})/i);
  const date  = dateM ? dateM[1] : '';

  // Find the mld-report-wrapper section
  const wStart = html.indexOf('class="mld-report-wrapper"');
  if (wStart === -1) {
    return [{ city: 'Metro Manila Area', barangay: 'See Meralco advisory', street: null,
              date, time: 'Multiple windows', reason: alertLabel, type: 'emergency' }];
  }
  const wSection = html.substring(wStart, wStart + 150000);

  // Split by <h1> to get one section per time slot.
  // Structure: <h1>time</h1><div class="faq-accordion">
  //   <div class="faq-item"><div class="faq-header"><h2>PROVINCE</h2></div>
  //     <div class="faq-body"><h3>CITY</h3><p class="barangay-item">bgy</p>...
  const sections = wSection.split(/<h1[^>]*>/i).slice(1);

  // Group by "PROVINCE::CITY" — collect all time windows + all barangays per city
  const cityMap = new Map();

  for (const section of sections.slice(0, 10)) {
    const slotM = section.match(/^([\s\S]*?)<\/h1>/i);
    if (!slotM) continue;
    const timeSlot = slotM[1].replace(/<[^>]+>/g, '').trim();
    if (!/between/i.test(timeSlot)) continue;

    const itemBlocks = section.split(/<div[^>]*class="[^"]*faq-item[^"]*"[^>]*>/i).slice(1);

    for (const block of itemBlocks) {
      const provM = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      if (!provM) continue;
      const province = provM[1].replace(/<[^>]+>/g, '').trim();
      if (!province) continue;

      // Locate faq-body, then split by <h3> to get city→barangay groups
      const bodyIdx = block.indexOf('faq-body');
      const bodySection = bodyIdx !== -1 ? block.substring(bodyIdx) : block;
      const cityParts = bodySection.split(/<h3[^>]*>/i).slice(1);

      for (const part of cityParts) {
        const cityM = part.match(/^([\s\S]*?)<\/h3>/i);
        if (!cityM) continue;
        const city = cityM[1].replace(/<[^>]+>/g, '').trim();
        if (!city || city.length > 60) continue;

        const key = province + '::' + city;
        if (!cityMap.has(key)) cityMap.set(key, { province, city, barangays: new Set(), windows: [] });
        const entry = cityMap.get(key);
        if (!entry.windows.includes(timeSlot)) entry.windows.push(timeSlot);

        for (const m of part.matchAll(/<p[^>]*class="[^"]*barangay-item[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)) {
          const bay = m[1].replace(/<[^>]+>/g, '').replace(/^\d+\.\s*/, '').trim();
          if (bay && bay.length < 80) entry.barangays.add(bay);
        }
      }
    }
  }

  if (cityMap.size === 0) {
    return [{ city: 'Metro Manila Area', province: null, barangay: 'See Meralco advisory',
              windows: [], date, time: 'Multiple windows', reason: alertLabel, type: 'emergency' }];
  }

  return [...cityMap.values()].map(function(entry) {
    return {
      city: entry.city,
      province: entry.province,
      barangay: [...entry.barangays].join(', ') || 'See Meralco advisory',
      windows: entry.windows,
      date,
      time: entry.windows.length + ' window' + (entry.windows.length !== 1 ? 's' : ''),
      reason: alertLabel,
      type: 'emergency'
    };
  });
}

function parseMeralcoMaintenanceInterruptions(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

  // Find all title positions first, then extract the block between each consecutive pair
  const titleRx = /<h3[^>]*class="[^"]*field-content[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi;
  const titleMatches = [...html.matchAll(titleRx)];
  const interruptions = [];

  for (let i = 0; i < Math.min(titleMatches.length, 15); i++) {
    const m        = titleMatches[i];
    const blockEnd = i + 1 < titleMatches.length ? titleMatches[i + 1].index : html.length;
    const block    = html.substring(m.index, blockEnd);

    const full    = m[1].trim();
    const parts   = full.match(/^(.+?,\s*\d{4})\s*-\s*(.+)$/);
    const date    = parts ? parts[1].trim() : full;
    const locFull = parts ? parts[2].trim() : full;

    // City from location field (search within this block only)
    const cityM = block.match(/views-field-field-service-maintenance-loc[\s\S]{0,1000}?class="field-content"[^>]*>\s*([^<\n]{1,80}?)\s*<\/div>/i);
    const city  = (cityM ? cityM[1].trim() : null) || locFull.split('(')[0].trim();

    // Time window (search within this block only)
    const timeM    = block.match(/views-field-body[\s\S]{0,2000}?<strong>(BETWEEN[\s\S]*?)<\/strong>/i);
    const timeRaw  = timeM ? timeM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
    const timeSlot = timeRaw ? timeRaw.replace(/\s*[–\-]\s*PORTIONS?.*/i, '').trim().substring(0, 100) : 'See schedule';
    const circuitM = timeRaw ? timeRaw.match(/PORTIONS?\s+OF\s+(CIRCUIT\s+\S+)/i) : null;
    const circuit  = circuitM ? circuitM[1].trim() : null;

    const bgyM     = locFull.match(/\(([^)]+)\)/);
    const barangay = bgyM ? bgyM[1] : locFull;

    interruptions.push({
      city, barangay, street: null, date, time: timeSlot,
      reason: 'Scheduled maintenance' + (circuit ? ` · ${circuit}` : ''),
      type: 'scheduled'
    });
  }
  return interruptions;
}

function buildNGCPPrompt(today) {
  return `Today is ${today} Philippines. Go to https://www.ngcp.ph/ and read the Power Situation Outlook table (id="table-dailyoutlook"). Extract the exact MW values for Luzon, Visayas, and Mindanao: Available Generating Capacity, System Peak Demand, and Operating Margin. Also get the "as of" timestamp shown in the table.

Derive the Luzon alert level from Operating Margin: if margin < 0 = red alert (insufficient supply), if margin < 600 = yellow alert (tight reserve), else = normal.

Return ONLY compact JSON, no markdown:
{"grid_status":{"level":"normal","title":"Luzon Grid — Normal (+NNN MW)","subtitle":"Adequate operating reserve.","color":"#1a7a52","bg":"#e6f5ed","border":"rgba(26,122,82,.2)","alert_times":[],"pso":{"as_of":"6:00 PM, Friday, May 15, 2026","luzon":{"capacity":12131,"demand":12802,"margin":-671},"visayas":{"capacity":2390,"demand":2502,"margin":-112},"mindanao":{"capacity":3281,"demand":2505,"margin":776}}}}

Color rules — red: color="#b83232",bg="#fdeaea",border="rgba(184,50,50,.2)" · yellow: color="#8a5a00",bg="#fef3dc",border="rgba(138,90,0,.2)" · normal: color="#1a7a52",bg="#e6f5ed",border="rgba(26,122,82,.2)".
Use the actual current MW numbers from the NGCP page. If operating margin is negative, the title must say "Insufficient Supply (−NNN MW)". If yellow, title is "Yellow Alert (+NNN MW)".`;
}

function buildPowerPrompt(today) {
  return `Today is ${today} Philippines. Search for these TWO things and return real current data:

1. NGCP Luzon grid alert status — search ngcp.ph, NGCP Facebook page, or Philippine news for today's Luzon grid level: Normal, Yellow Alert (insufficient reserve, no brownout yet), or Red Alert (rotating brownouts active). If Yellow/Red Alert, include the alert time windows.

2. Meralco power interruptions — search "site:company.meralco.com.ph yellow red alert" AND "site:company.meralco.com.ph maintenance schedule" OR search Meralco NCR brownout schedule for today and the next 3 days. List affected cities and barangays for both:
   a) Emergency brownouts (yellow/red alert areas) — type "emergency"
   b) Scheduled maintenance interruptions — type "scheduled"

Return ONLY compact JSON, no markdown, no explanation:
{"grid_status":{"level":"normal","title":"Luzon Grid — Normal","subtitle":"No active grid alert as of ${today}","color":"#1a7a52","bg":"#e6f5ed","border":"rgba(26,122,82,.2)","alert_times":[]},"interruptions":[{"city":null,"barangay":null,"street":null,"date":null,"time":null,"reason":null,"type":"scheduled"}],"last_updated":"${today}","sources":[]}

Color rules — yellow alert: color="#8a5a00",bg="#fef3dc",border="rgba(138,90,0,.2)" · red alert: color="#b83232",bg="#fdeaea",border="rgba(184,50,50,.2)" · normal: color="#1a7a52",bg="#e6f5ed",border="rgba(26,122,82,.2)".
Use real specific dates and times (not "Recent" or "Afternoon"). If no interruptions are found, return an empty array. Include NCR cities and Pampanga if data is available.`;
}

/* ── GEMINI ── */
async function geminiGenerate(apiKey, prompt) {
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 3000, temperature: 0.1 }
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}

/* ── GROQ ── */
async function groqSearch(prompt) {
  let r = await groqPost("/chat/completions", {
    model: "compound-beta",
    max_tokens: 1200,
    messages: [{ role: "user", content: prompt }]
  });
  if (r.ok) return r.data.choices?.[0]?.message?.content || "{}";

  r = await groqPost("/chat/completions", {
    model: "llama-3.3-70b-versatile",
    max_tokens: 1200,
    messages: [{ role: "user", content: prompt }]
  });
  if (r.ok) return r.data.choices?.[0]?.message?.content || "{}";

  throw new Error(`Groq unreachable: ${r.status}`);
}

async function groqPost(path, payload) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await fetch(`${GROQ_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : { raw: await res.text() };
  return { ok: res.ok, status: res.status, data };
}

/* ── UTILITIES ── */
function extractJSON(raw) {
  if (!raw || typeof raw !== "string") return { error: "Empty response", raw: String(raw).slice(0, 100) };
  let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return { error: "No JSON object found", raw: s.slice(0, 300) };
  const str = s.slice(start, end + 1);
  try { return JSON.parse(str); } catch (_) {}
  try { return JSON.parse(str.replace(/,(\s*[}\]])/g, "$1").replace(/'/g, '"')); } catch (e) {
    return { error: "JSON parse failed: " + e.message, raw: str.slice(0, 400) };
  }
}

function phDate() {
  return new Date().toLocaleDateString("en-PH", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "Asia/Manila"
  });
}
