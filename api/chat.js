// api/chat.js — Hybrid: DOE Scraper (primary) + Gemini (fallback) + Groq (chat only)
// Env vars: GEMINI_API_KEY, GROQ_API_KEY

const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.0-flash";

// DOE price monitoring URLs
const DOE_URLS = {
  metro_manila: "https://doe.gov.ph/price-monitoring-charts?q=retail-pump-prices-metro-manila",
  north_luzon: "https://doe.gov.ph/articles/3261451--north-luzon-pump-prices-draft?title=List%20of%20North%20Luzon%20Pump%20Prices",
  south_luzon: "https://doe.gov.ph/price-monitoring-charts?q=retail-pump-prices-south-luzon",
  visayas: "https://doe.gov.ph/price-monitoring-charts?q=retail-pump-prices-visayas",
  mindanao: "https://doe.gov.ph/price-monitoring-charts?q=retail-pump-prices-mindanao"
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

/* ── FUEL (DOE Scraper → Gemini → Groq → Static) ── */
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

  // 1. DOE Scraper (primary — official government source)
  try {
    const doeData = await scrapeDOEPrices(region);
    if (doeData && doeData.prices && doeData.prices.petron && doeData.prices.petron.ron91 > 50) {
      result = {
        effective_date: today,
        week_label: `Week of ${today}`,
        doe_adjustment: doeData.adjustment || {
          gasoline_ron91_95: "0.00",
          diesel_std: "0.00",
          kerosene: "0.00",
          lpg_per_kg: "0.00",
          note: "Prices from DOE official monitoring"
        },
        prices: doeData.prices,
        trend_context: doeData.trend || "Live DOE data",
        next_week_signal: null,
        fill_up_advice: null,
        sources: [DOE_URLS[region] || DOE_URLS.metro_manila]
      };
      source = "doe";
      console.log("[fuel] DOE scraper OK, ron91:", doeData.prices.petron.ron91);
    }
  } catch (e) {
    console.warn("[fuel] DOE scraper failed:", e.message);
  }

  // 2. Gemini fallback (if DOE fails)
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

  // 4. Static emergency fallback (updated to fuelprice.ph May 12-18, 2026)
  if (!result) {
    result = {
      effective_date: today,
      week_label: `Week of ${today}`,
      doe_adjustment: {
        gasoline_ron91_95: "+0.47",
        diesel_std: "-9.57",
        kerosene: "-13.30",
        lpg_per_kg: "-13.42",
        note: "Week of May 12: gasoline +₱0.47/L, diesel rolled back ₱9.57/L, kerosene rolled back ₱13.30/L"
      },
      prices: {
        petron: { ron91: 94.37, ron95: 98.37, ron100: 108.00, diesel_std: 83.22, diesel_prem: 86.32, kerosene: 107.33 },
        shell:  { ron91: 97.00, ron95: 101.00, ron97: 104.00, diesel_std: 85.50, diesel_prem: 88.50, kerosene: 110.00 },
        unioil: { ron91: 94.00, ron95: 97.00, diesel_std: 83.00 }
      },
      trend_context: "Prices from fuelprice.ph Week of May 12-18, 2026.",
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

/* ── DOE SCRAPER ── */
async function scrapeDOEPrices(region) {
  const url = DOE_URLS[region] || DOE_URLS.metro_manila;
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

    // Extract prices from DOE table structure
    const prices = {
      petron: { ron91: 0, ron95: 0, ron100: 0, diesel_std: 0, diesel_prem: 0, kerosene: 0 },
      shell:  { ron91: 0, ron95: 0, ron97: 0, diesel_std: 0, diesel_prem: 0, kerosene: 0 },
      unioil: { ron91: 0, ron95: 0, diesel_std: 0 }
    };

    // Try multiple extraction patterns for DOE's various page formats
    const patterns = [
      // Pattern 1: Table rows with brand names
      { re: /Petron[\s\S]{0,300}?RON\s*91[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'petron', fuel: 'ron91' },
      { re: /Petron[\s\S]{0,300}?RON\s*95[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'petron', fuel: 'ron95' },
      { re: /Petron[\s\S]{0,300}?Diesel[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'petron', fuel: 'diesel_std' },
      { re: /Petron[\s\S]{0,300}?Kerosene[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'petron', fuel: 'kerosene' },
      { re: /Shell[\s\S]{0,300}?RON\s*91[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'shell', fuel: 'ron91' },
      { re: /Shell[\s\S]{0,300}?RON\s*95[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'shell', fuel: 'ron95' },
      { re: /Shell[\s\S]{0,300}?Diesel[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'shell', fuel: 'diesel_std' },
      { re: /Shell[\s\S]{0,300}?Kerosene[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'shell', fuel: 'kerosene' },
      { re: /Unioil[\s\S]{0,300}?RON\s*91[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'unioil', fuel: 'ron91' },
      { re: /Unioil[\s\S]{0,300}?RON\s*95[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'unioil', fuel: 'ron95' },
      { re: /Unioil[\s\S]{0,300}?Diesel[\s\S]{0,100}?[₱P]\s?(\d{2,3}\.\d{2})/i, brand: 'unioil', fuel: 'diesel_std' },
    ];

    let foundCount = 0;
    for (const p of patterns) {
      const m = html.match(p.re);
      if (m && prices[p.brand] && prices[p.brand][p.fuel] !== undefined) {
        prices[p.brand][p.fuel] = parseFloat(m[1]);
        foundCount++;
      }
    }

    // Pattern 2: Generic table extraction (DOE often uses tables)
    if (foundCount < 3) {
      // Try to find all prices in the page and assign by proximity to brand names
      const allPrices = html.match(/[₱P]\s?(\d{2,3}\.\d{2})/g) || [];
      const priceNums = allPrices.map(p => parseFloat(p.replace(/[₱P]\s?/, '')));
      
      // If we have enough prices, try to map them by position
      if (priceNums.length >= 6) {
        // Sort and assign: lowest are usually diesel/kerosene, highest are premium
        priceNums.sort((a, b) => a - b);
        // This is heuristic — better to rely on Pattern 1
      }
    }

    // Extract adjustment info from page text
    const adjMatch = html.match(/(?:gasoline|diesel|kerosene)[\s\S]{0,50}?([+-]?\d+\.\d+)[\s\S]{0,20}?per\s?liter/i);
    const adjustment = {
      gasoline_ron91_95: "0.00",
      diesel_std: "0.00",
      kerosene: "0.00",
      lpg_per_kg: "0.00",
      note: "DOE official monitoring data"
    };

    // Validate: DOE prices should be in realistic range
    if (prices.petron.ron91 < 50 || prices.petron.ron91 > 150) {
      throw new Error("DOE scraper returned unrealistic prices");
    }

    return { prices, adjustment, foundCount };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

/* ── PROMPT BUILDERS ── */
function buildFuelPrompt(today) {
  return `Today is ${today}. Search fuelprice.ph and gaswatchph.com for current PH pump prices (Petron/Shell/Unioil NCR) and latest DOE weekly adjustment. Return ONLY compact JSON, no markdown, no explanation. RON91 realistic ₱80-95, diesel ₱75-90. Use null if unavailable.
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
