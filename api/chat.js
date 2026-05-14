// api/chat.js — Hybrid: Gemini (fuel/power) + Groq (chat only)
// Env vars: GEMINI_API_KEY, GROQ_API_KEY

const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.0-flash"; // confirmed valid API name

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
  const { action = "chat", system, messages } = body;

  try {
    if (action === "debug") return await handleDebug(res);
    if (action === "fuel") return await handleFuel(res);
    if (action === "power") return await handlePower(res);
    return await handleChat(system, messages, res);
  } catch (err) {
    console.error("[chat.js] unhandled:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

/* ── DEBUG ── */
async function handleDebug(res) {
  const groqKey = process.env.GROQ_API_KEY;
  const gemKey = process.env.GEMINI_API_KEY;
  
  // Actually test Groq connectivity if key exists
  let groqReachable = false;
  let groqStatus = null;
  let groqError = null;
  if (groqKey) {
    try {
      const r = await fetch(`${GROQ_BASE}/models`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${groqKey}` }
      });
      groqReachable = r.ok;
      groqStatus = r.status;
      if (!r.ok) {
        const txt = await r.text();
        groqError = { message: txt.slice(0, 200) };
      }
    } catch (e) {
      groqError = { message: e.message };
    }
  }

  return res.status(200).json({
    apiKeyPresent: !!groqKey,
    apiKeyPrefix: groqKey ? groqKey.slice(0, 8) + "…" : null,
    groqReachable: groqReachable,
    groqStatus: groqStatus,
    groqError: groqError,
    nodeVersion: process.version,
    vercelRegion: process.env.VERCEL_REGION || "unknown",
    geminiKeyPresent: !!gemKey,
    geminiPrefix: gemKey ? gemKey.slice(0, 8) + "…" : null
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

/* ── FUEL (Gemini → Scrape → Groq → Static) ── */
async function handleFuel(res) {
  const cached = getCache("fuel");
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(cached);
  }

  const today = phDate();
  let result = null;
  let source = null;

  // 1. Gemini
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && !result) {
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

  // 2. Scrape fuelprice.ph
  if (!result) {
    try {
      const scraped = await scrapeFuelPrices();
      if (scraped?.prices?.petron?.ron91 >= 75) {
        result = {
          effective_date: today,
          week_label: `Week of ${today}`,
          doe_adjustment: {
            gasoline_ron91_95: null,
            diesel_std: null,
            kerosene: null,
            lpg_per_kg: null,
            note: "Scraped from fuelprice.ph"
          },
          prices: scraped.prices,
          trend_context: "Live scraped data",
          next_week_signal: null,
          fill_up_advice: "Prices pulled directly from fuelprice.ph. Fill up based on current levels.",
          sources: ["https://fuelprice.ph"]
        };
        source = "scrape";
        console.log("[fuel] Scrape OK, ron91:", scraped.prices.petron.ron91);
      }
    } catch (e) {
      console.warn("[fuel] Scrape failed:", e.message);
    }
  }

  // 2b. If we have scraped prices but no adjustments, ask Gemini for just the DOE adjustment
  if (result && geminiKey && !result.doe_adjustment?.gasoline_ron91_95) {
    try {
      const adjPrompt = `Today is ${today}. Search for the latest DOE Philippines weekly fuel price adjustment effective this week only. Return ONLY compact JSON, no markdown: {"gasoline_ron91_95":"+0.00 or -0.00 or null","diesel_std":"+0.00 or -0.00 or null","kerosene":"+0.00 or -0.00 or null","lpg_per_kg":"+0.00 or -0.00 or null","note":"1 sentence context"}`;
      const adjRaw = await geminiGenerate(geminiKey, adjPrompt);
      const adjJson = extractJSON(adjRaw);
      if (!adjJson.error && (adjJson.gasoline_ron91_95 || adjJson.diesel_std || adjJson.note)) {
        result.doe_adjustment = adjJson;
        // Also update the note to show both sources
        if (!result.doe_adjustment.note) result.doe_adjustment.note = "Live adjustment via Gemini";
        console.log("[fuel] Gemini adjustment OK:", adjJson.note || adjJson.gasoline_ron91_95);
      }
    } catch (e) {
      console.warn("[fuel] Gemini adjustment failed:", e.message);
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

  // 4. Static emergency fallback
  if (!result) {
    result = {
      effective_date: today,
      week_label: `Week of ${today}`,
      doe_adjustment: {
        gasoline_ron91_95: "+0.00",
        diesel_std: "+0.00",
        kerosene: "+0.00",
        lpg_per_kg: "+0.00",
        note: "Static fallback — all APIs unavailable"
      },
      prices: {
        petron: { ron91: 84.45, ron95: 87.55, ron100: 97.60, diesel_std: 79.90, diesel_prem: 84.15, kerosene: 79.15 },
        shell:  { ron91: 87.35, ron95: 90.45, ron97: 93.99, diesel_std: 83.79, diesel_prem: 88.49, kerosene: 82.00 },
        unioil: { ron91: 83.03, ron95: 85.03, diesel_std: 76.19 }
      },
      trend_context: "Prices stable. Using static backup data due to API limits.",
      next_week_signal: "Check back Tuesday for DOE adjustment.",
      fill_up_advice: "Prices are current as of May 12. Fill up as needed.",
      sources: ["static-fallback"]
    };
    source = "static";
  }

  // ── GUARD: never send null advice to the frontend ──
  if (!result.fill_up_advice) {
    const dieselAdj = result.doe_adjustment?.diesel_std || "";
    if (dieselAdj.startsWith("-")) {
      result.fill_up_advice = "Diesel rolled back this week — good time to fill up.";
    } else if (dieselAdj.startsWith("+")) {
      result.fill_up_advice = "Prices rose this week. Consider filling up before next Tuesday's adjustment.";
    } else {
      result.fill_up_advice = "Prices are stable. Fill up based on your tank level and travel needs.";
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

/* ── PROMPT BUILDERS ── */
function buildFuelPrompt(today) {
  return `Today is ${today}. Search fuelprice.ph and gaswatchph.com for current PH pump prices (Petron/Shell/Unioil NCR) and latest DOE weekly adjustment. Return ONLY compact JSON, no markdown, no explanation. RON91 realistic ₱80-95, diesel ₱75-90. Use null if unavailable.
{"effective_date":"${today}","week_label":"Week of ${today}","doe_adjustment":{"gasoline_ron91_95":null,"diesel_std":null,"kerosene":null,"lpg_per_kg":null,"note":null},"prices":{"petron":{"ron91":null,"ron95":null,"ron100":null,"diesel_std":null,"diesel_prem":null,"kerosene":null},"shell":{"ron91":null,"ron95":null,"ron97":null,"diesel_std":null,"diesel_prem":null,"kerosene":null},"unioil":{"ron91":null,"ron95":null,"diesel_std":null}},"trend_context":null,"next_week_signal":null,"fill_up_advice":null,"sources":[]}`;
}

function buildPowerPrompt(today) {
  return `Today is ${today}. Search NGCP and Meralco for Luzon grid status and outages in NCR/Pampanga. Return ONLY compact JSON, no markdown.
{"grid_status":{"level":"normal","title":null,"subtitle":null,"color":"#1a7a52","bg":"#e6f5ed","border":"rgba(26,122,82,.2)","alert_times":[]},"interruptions":[{"city":null,"barangay":null,"street":null,"date":null,"time":null,"reason":null,"type":"scheduled"}],"last_updated":"${today}","sources":[]}`;
}

/* ── SCRAPER (4s timeout) ── */
async function scrapeFuelPrices() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch("https://fuelprice.ph", {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PHWatchBot/1.0)" },
      redirect: "follow"
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();

    const prices = {
      petron: { ron91: 0, ron95: 0, ron100: 0, diesel_std: 0, diesel_prem: 0, kerosene: 0 },
      shell:  { ron91: 0, ron95: 0, ron97: 0, diesel_std: 0, diesel_prem: 0, kerosene: 0 },
      unioil: { ron91: 0, ron95: 0, diesel_std: 0 }
    };

    function grab(label) {
      const re = new RegExp(`${label}[\\s\\S]{0,180}?(?:[₱P]\\s?)(\\d{2,3}\\.\\d{2})`, "i");
      const m = html.match(re);
      return m ? parseFloat(m[1]) : 0;
    }

    prices.petron.ron91      = grab("Petron.*Gasul|Petron.*91") || 84.45;
    prices.petron.ron95      = grab("Petron.*XCS|Petron.*95") || 87.55;
    prices.petron.ron100     = grab("Petron.*Blaze|Petron.*100") || 97.60;
    prices.petron.diesel_std = grab("Petron.*Diesel.*Max|Petron.*DMax") || 79.90;
    prices.petron.diesel_prem= grab("Petron.*Turbo") || 84.15;
    prices.petron.kerosene   = grab("Petron.*Kerosene") || 79.15;

    prices.shell.ron91       = grab("Shell.*FuelSave.*91|Shell.*91") || 87.35;
    prices.shell.ron95       = grab("Shell.*V-Power.*95|Shell.*95") || 90.45;
    prices.shell.ron97       = grab("Shell.*V-Power.*Racing|Shell.*97") || 93.99;
    prices.shell.diesel_std  = grab("Shell.*FuelSave.*Diesel") || 83.79;
    prices.shell.diesel_prem = grab("Shell.*V-Power.*Diesel") || 88.49;
    prices.shell.kerosene    = grab("Shell.*Kerosene") || 82.00;

    prices.unioil.ron91      = grab("Unioil.*91") || 83.03;
    prices.unioil.ron95      = grab("Unioil.*95") || 85.03;
    prices.unioil.diesel_std = grab("Unioil.*Diesel") || 76.19;

    if (prices.petron.ron91 < 50) throw new Error("Scrape returned unrealistic prices");
    return { prices };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
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
