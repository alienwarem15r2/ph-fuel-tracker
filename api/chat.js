// api/chat.js — Hybrid: GasWatch PH Scraper (primary) + Gemini (fallback) + Groq (chat only)
// Env vars: GEMINI_API_KEY, GROQ_API_KEY

const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.0-flash";

// GasWatch PH URLs
const GASWATCH_URLS = {
  metro_manila: "https://gaswatchph.com/",
  cavite: "https://gaswatchph.com/cavite",
  rizal: "https://gaswatchph.com/rizal",
  laguna: "https://gaswatchph.com/laguna",
  pampanga: "https://gaswatchph.com/pampanga"
};

// ── 15-min server cache ──
const CACHE_TTL = 15 * 60 * 1000;
const apiCache = { fuel: { data: null, ts: 0 }, power: { data: null, ts: 0 } };

function getCache(key) {
  const e = apiCache[key];
  if (e && e.data && (Date.now() - e.ts) < CACHE_TTL) {
    console.log(`[cache] hit: ${key}`);
    return e.data;
  }
  return null;
}
function setCache(key, data) {
  apiCache[key] = { data, ts: Date.now() };
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
  return res.status(200).json({
    apiKeyPresent: !!groq,
    apiKeyPrefix: groq ? groq.slice(0, 8) + "…" : null,
    groqReachable: null,
    groqStatus: null,
    groqError: null,
    geminiKeyPresent: !!gem,
    geminiPrefix: gem ? gem.slice(0, 8) + "…" : null,
    nodeVersion: process.version,
    vercelRegion: process.env.VERCEL_REGION || "unknown",
    cache_fuel_age: apiCache.fuel.data ? Math.round((Date.now() - apiCache.fuel.ts) / 1000) + "s" : "empty",
    cache_power_age: apiCache.power.data ? Math.round((Date.now() - apiCache.power.ts) / 1000) + "s" : "empty"
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

/* ── FUEL (GasWatch PH → Gemini → Groq → Static) ── */
async function handleFuel(res, region) {
  const cached = getCache("fuel");
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(cached);
  }

  const today = phDate();
  let result = null;
  let source = null;
  const geminiKey = process.env.GEMINI_API_KEY;

  // 1. GasWatch PH Scraper (primary — community + DOE combined)
  try {
    const gwData = await scrapeGasWatch(region);
    if (gwData && gwData.prices && gwData.prices.petron && gwData.prices.petron.ron91 > 50) {
      result = {
        effective_date: today,
        week_label: `Week of ${today}`,
        doe_adjustment: gwData.adjustment || {
          gasoline_ron91_95: "0.00",
          diesel_std: "0.00",
          kerosene: "0.00",
          lpg_per_kg: "0.00",
          note: "Prices from GasWatch PH community + DOE data"
        },
        prices: gwData.prices,
        trend_context: gwData.trend || "Live GasWatch PH data",
        next_week_signal: null,
        fill_up_advice: null,
        sources: [GASWATCH_URLS[region] || GASWATCH_URLS.metro_manila]
      };
      source = "gaswatch";
      console.log("[fuel] GasWatch OK, ron91:", gwData.prices.petron.ron91);
    }
  } catch (e) {
    console.warn("[fuel] GasWatch scraper failed:", e.message);
  }

  // 2. Gemini fallback
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

  // 4. Static emergency fallback (GasWatch PH May 13-19, 2026)
  if (!result) {
    result = {
      effective_date: today,
      week_label: `Week of ${today}`,
      doe_adjustment: {
        gasoline_ron91_95: "+0.47",
        diesel_std: "-9.57",
        kerosene: "-13.30",
        lpg_per_kg: "-13.42",
        note: "Week of May 13: gasoline +₱0.47/L, diesel rolled back ₱9.57/L, kerosene rolled back ₱13.30/L"
      },
      prices: {
        petron: { ron91: 84.45, ron95: 87.55, ron100: 97.60, diesel_std: 79.90, diesel_prem: 84.15, kerosene: 79.15 },
        shell:  { ron91: 91.08, ron95: 94.18, ron97: 97.72, diesel_std: 83.79, diesel_prem: 88.49, kerosene: 82.00 },
        unioil: { ron91: 86.66, ron95: 89.66, diesel_std: 86.83 }
      },
      trend_context: "Prices from GasWatch PH Week of May 13-19, 2026.",
      next_week_signal: "Check back Tuesday for DOE adjustment.",
      fill_up_advice: "Diesel and kerosene rolled back significantly this week — good time to fill up.",
      sources: ["static-fallback"]
    };
    source = "static";
  }

  // Final guard: never send null advice
  if (!result.fill_up_advice) {
    const dieselAdj = result.doe_adjustment?.diesel_std || "0";
    if (String(dieselAdj).startsWith("-")) {
      result.fill_up_advice = "Diesel rolled back this week — good time to fill up.";
    } else if (String(dieselAdj).startsWith("+")) {
      result.fill_up_advice = "Prices rose this week. Consider filling up before next Tuesday's adjustment.";
    } else {
      result.fill_up_advice = "Prices are stable this week. Fill up based on your tank level and travel needs.";
    }
  }

  result._meta = { source, cached_at: new Date().toISOString() };
  setCache("fuel", result);
  res.setHeader("Cache-Control", "public, max-age=900");
  return res.status(200).json(result);
}

/* ── POWER (Gemini → Groq → Static) ── */
async function handlePower(res) {
  const cached = getCache("power");
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(cached);
  }

  const today = phDate();
  let result = null;
  let source = null;

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && !result) {
    try {
      const raw = await geminiGenerate(geminiKey, buildPowerPrompt(today));
      const json = extractJSON(raw);
      if (!json.error && json.grid_status) {
        result = json;
        source = "gemini";
      }
    } catch (e) {
      console.warn("[power] Gemini failed:", e.message);
    }
  }

  if (!result) {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      try {
        const raw = await groqSearch(buildPowerPrompt(today));
        const json = extractJSON(raw);
        if (!json.error && json.grid_status) {
          result = json;
          source = "groq";
        }
      } catch (e) {
        console.warn("[power] Groq fallback failed:", e.message);
      }
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
      sources: ["static-fallback"]
    };
    source = "static";
  }

  result._meta = { source, cached_at: new Date().toISOString() };
  setCache("power", result);
  res.setHeader("Cache-Control", "public, max-age=900");
  return res.status(200).json(result);
}

/* ── GASWATCH PH SCRAPER ── */
async function scrapeGasWatch(region) {
  const url = GASWATCH_URLS[region] || GASWATCH_URLS.metro_manila;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive"
      },
      redirect: "follow"
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();

    // Extract from GasWatch PH table structure
    const prices = {
      petron: { ron91: 0, ron95: 0, ron100: 0, diesel_std: 0, diesel_prem: 0, kerosene: 0 },
      shell:  { ron91: 0, ron95: 0, ron97: 0, diesel_std: 0, diesel_prem: 0, kerosene: 0 },
      unioil: { ron91: 0, ron95: 0, diesel_std: 0 }
    };

    // Pattern 1: Table rows with brand names (GasWatch PH format)
    // Brand | Diesel | Unleaded
    const tablePattern = /<tr[^>]*>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<\/tr>/gi;
    let match;
    let foundBrands = 0;

    while ((match = tablePattern.exec(html)) !== null) {
      const brand = match[1].replace(/<[^>]+>/g, '').trim().toLowerCase();
      const diesel = parseFloat(match[2].replace(/<[^>]+>/g, '').replace(/[₱,]/g, '').trim()) || 0;
      const unleaded = parseFloat(match[3].replace(/<[^>]+>/g, '').replace(/[₱,]/g, '').trim()) || 0;

      if (brand.includes('petron') && diesel > 50) {
        prices.petron.diesel_std = diesel;
        prices.petron.ron91 = unleaded;
        // Estimate ron95 as +3.00 from ron91 (typical spread)
        prices.petron.ron95 = unleaded + 3.00;
        prices.petron.ron100 = unleaded + 13.00;
        prices.petron.diesel_prem = diesel + 4.25;
        prices.petron.kerosene = diesel - 0.75; // kerosene typically near diesel
        foundBrands++;
      }
      if (brand.includes('shell') && diesel > 50) {
        prices.shell.diesel_std = diesel;
        prices.shell.ron91 = unleaded;
        prices.shell.ron95 = unleaded + 3.00;
        prices.shell.ron97 = unleaded + 6.50;
        prices.shell.diesel_prem = diesel + 4.70;
        prices.shell.kerosene = diesel - 1.79;
        foundBrands++;
      }
      if (brand.includes('unioil') && diesel > 50) {
        prices.unioil.diesel_std = diesel;
        prices.unioil.ron91 = unleaded;
        prices.unioil.ron95 = unleaded + 3.00;
        foundBrands++;
      }
    }

    // Pattern 2: If table parsing failed, try specific brand patterns
    if (foundBrands < 2) {
      const petronDiesel = html.match(/Petron[\s\S]{0,200}?(?:Diesel[\s\S]{0,50}?)?[₱P]\s?(\d{2,3}\.\d{2})/i);
      const petronUnleaded = html.match(/Petron[\s\S]{0,200}?(?:Unleaded[\s\S]{0,50}?)?[₱P]\s?(\d{2,3}\.\d{2})/i);
      const shellDiesel = html.match(/Shell[\s\S]{0,200}?(?:Diesel[\s\S]{0,50}?)?[₱P]\s?(\d{2,3}\.\d{2})/i);
      const shellUnleaded = html.match(/Shell[\s\S]{0,200}?(?:Unleaded[\s\S]{0,50}?)?[₱P]\s?(\d{2,3}\.\d{2})/i);
      const unioilDiesel = html.match(/Unioil[\s\S]{0,200}?(?:Diesel[\s\S]{0,50}?)?[₱P]\s?(\d{2,3}\.\d{2})/i);
      const unioilUnleaded = html.match(/Unioil[\s\S]{0,200}?(?:Unleaded[\s\S]{0,50}?)?[₱P]\s?(\d{2,3}\.\d{2})/i);

      if (petronDiesel) prices.petron.diesel_std = parseFloat(petronDiesel[1]);
      if (petronUnleaded) prices.petron.ron91 = parseFloat(petronUnleaded[1]);
      if (shellDiesel) prices.shell.diesel_std = parseFloat(shellDiesel[1]);
      if (shellUnleaded) prices.shell.ron91 = parseFloat(shellUnleaded[1]);
      if (unioilDiesel) prices.unioil.diesel_std = parseFloat(unioilDiesel[1]);
      if (unioilUnleaded) prices.unioil.ron91 = parseFloat(unioilUnleaded[1]);
    }

    // Extract adjustment from page text
    const adjMatch = html.match(/Week of[\s\S]{0,100}?(?:Gasoline|Diesel|Kerosene)[\s\S]{0,50}?([+-]?\d+\.\d+)[\s\S]{0,20}?\/L/i);
    const adjustment = {
      gasoline_ron91_95: "0.00",
      diesel_std: "0.00",
      kerosene: "0.00",
      lpg_per_kg: "0.00",
      note: "GasWatch PH community + DOE data"
    };

    // Extract trend note
    const trendMatch = html.match(/Metro Manila averages are[\s\S]{0,200}?based on/i);
    const trend = trendMatch ? trendMatch[0] : "Live GasWatch PH data";

    // Validate
    if (prices.petron.ron91 < 50 || prices.petron.ron91 > 150) {
      throw new Error("GasWatch scraper returned unrealistic prices");
    }

    return { prices, adjustment, trend, foundBrands };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

/* ── PROMPT BUILDERS ── */
function buildFuelPrompt(today) {
  return `Today is ${today}. Search gaswatchph.com for current PH pump prices (Petron/Shell/Unioil) and latest DOE weekly adjustment. Return ONLY compact JSON, no markdown, no explanation. RON91 realistic ₱80-95, diesel ₱75-90. Use null if unavailable.
{"effective_date":"${today}","week_label":"Week of ${today}","doe_adjustment":{"gasoline_ron91_95":null,"diesel_std":null,"kerosene":null,"lpg_per_kg":null,"note":null},"prices":{"petron":{"ron91":null,"ron95":null,"ron100":null,"diesel_std":null,"diesel_prem":null,"kerosene":null},"shell":{"ron91":null,"ron95":null,"ron97":null,"diesel_std":null,"diesel_prem":null,"kerosene":null},"unioil":{"ron91":null,"ron95":null,"diesel_std":null}},"trend_context":null,"next_week_signal":null,"fill_up_advice":null,"sources":[]}`;
}

function buildPowerPrompt(today) {
  return `Today is ${today}. Search NGCP and Meralco for Luzon grid status and outages in NCR/Pampanga. Return ONLY compact JSON, no markdown.
{"grid_status":{"level":"normal","title":null,"subtitle":null,"color":"#1a7a52","bg":"#e6f5ed","border":"rgba(26,122,82,.2)","alert_times":[]},"interruptions":[{"city":null,"barangay":null,"street":null,"date":null,"time":null,"reason":null,"type":"scheduled"}],"last_updated":"${today}","sources":[]}`;
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
      generationConfig: { maxOutputTokens: 2000, temperature: 0.1 }
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
