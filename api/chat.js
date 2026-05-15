// api/chat.js — GasWatch PH Scraper + Gemini Fallback + Groq Chat Only
// Env vars: GEMINI_API_KEY, GROQ_API_KEY

const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.0-flash";

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

/* ── FUEL (GasWatch PH → Gemini → Groq → Unavailable) ── */
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

  // 1. GasWatch PH Scraper (primary)
  try {
    const gwData = await scrapeGasWatch(region);
    if (gwData && gwData.prices && gwData.prices.petron && gwData.prices.petron.ron91 > 50) {
      result = {
        effective_date: today,
        week_label: `Week of ${today}`,
        doe_adjustment: gwData.adjustment || {
          gasoline_ron91_95: null,
          diesel_std: null,
          kerosene: null,
          lpg_per_kg: null,
          note: "Prices from GasWatch PH community + DOE data"
        },
        fuel_adjustments: gwData.fuelAdjustments || null,
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
      fuel_adjustments: {
        ron91: null, ron95: null, ron100: null, ron97: null,
        diesel_std: null, diesel_prem: null, kerosene: null
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
  setCache("fuel", result);
  res.setHeader("Cache-Control", "public, max-age=900");
  return res.status(200).json(result);
}

/* ── POWER (Gemini → Groq → Unavailable) ── */
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
      sources: ["unavailable"]
    };
    source = "unavailable";
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
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

    // ── Extract DOE weekly adjustment from page text ──
    let doeGasoline = null;
    let doeDiesel = null;
    let doeKerosene = null;
    let doeNote = "GasWatch PH community + DOE data";
    let trendText = "Live GasWatch PH data";

    // Normalize HTML for pattern matching
    const flatHtml = html.replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');

    // Pattern 1: "Week of Diesel −₱5.00–10.48/LGasoline −₱0.84–1.08/LKerosene −₱13.30/L"
    const weekPattern = /Week\s+of\s*Diesel\s*([−+\-]?₱?[\d.–\-]+(?:\s*[-–]\s*₱?[\d.]+)?\/?L?)\s*Gasoline\s*([−+\-]?₱?[\d.–\-]+(?:\s*[-–]\s*₱?[\d.]+)?\/?L?)\s*Kerosene\s*([−+\-]?₱?[\d.–\-]+\/?L?)/i;
    const weekMatch = flatHtml.match(weekPattern);
    if (weekMatch) {
      doeDiesel = cleanAdj(weekMatch[1]);
      doeGasoline = cleanAdj(weekMatch[2]);
      doeKerosene = cleanAdj(weekMatch[3]);
      trendText = `Week of — Diesel ${doeDiesel}, Gasoline ${doeGasoline}, Kerosene ${doeKerosene}`;
    }

    // Pattern 2: "diesel −₱9.57, gasoline +₱0.47, kerosene −₱13.30" (from price history / embedded text)
    if (!doeGasoline || !doeDiesel) {
      const adjPattern = /DOE(?:[-\s]confirmed)?\s+adjustment\s+was\s+(?:.*?)?diesel\s*([−+\-]?₱?[\d.]+)\s*,?\s*(?:.*?)?gasoline\s*([−+\-]?₱?[\d.]+)\s*,?\s*(?:.*?)?kerosene\s*([−+\-]?₱?[\d.]+)/i;
      const adjMatch = flatHtml.match(adjPattern);
      if (adjMatch) {
        if (!doeDiesel) doeDiesel = cleanAdj(adjMatch[1]);
        if (!doeGasoline) doeGasoline = cleanAdj(adjMatch[2]);
        if (!doeKerosene) doeKerosene = cleanAdj(adjMatch[3]);
      }
    }

    // Pattern 3: Loose per-fuel labels anywhere in page (e.g. near tables or hero sections)
    if (!doeGasoline) {
      const gasPat = /Gasoline\s*([−+\-]?₱?[\d.]+(?:\s*[-–]\s*₱?[\d.]+)?\/?L?)/i;
      const gasM = html.match(gasPat);
      if (gasM) doeGasoline = cleanAdj(gasM[1]);
    }
    if (!doeDiesel) {
      const diePat = /Diesel\s*([−+\-]?₱?[\d.]+(?:\s*[-–]\s*₱?[\d.]+)?\/?L?)/i;
      const dieM = html.match(diePat);
      if (dieM) doeDiesel = cleanAdj(dieM[1]);
    }
    if (!doeKerosene) {
      const keroPat = /Kerosene\s*([−+\-]?₱?[\d.]+\/?L?)/i;
      const keroM = html.match(keroPat);
      if (keroM) doeKerosene = cleanAdj(keroM[1]);
    }

    // Pattern 4: " hike amounts " or " rollback " text near week label
    const hikeRollback = html.match(/(gasoline|diesel|kerosene)\s*(?:hike|rollback|increase|decrease|adjustment)\s*(?:of\s*)?([−+\-]?₱?[\d.]+)/gi);
    if (hikeRollback && hikeRollback.length > 0) {
      hikeRollback.forEach(line => {
        const m = line.match(/(gasoline|diesel|kerosene)\s*(?:hike|rollback|increase|decrease|adjustment)\s*(?:of\s*)?([−+\-]?₱?[\d.]+)/i);
        if (m) {
          const val = cleanAdj(m[2]);
          if (m[1].toLowerCase() === 'gasoline' && !doeGasoline) doeGasoline = val;
          if (m[1].toLowerCase() === 'diesel' && !doeDiesel) doeDiesel = val;
          if (m[1].toLowerCase() === 'kerosene' && !doeKerosene) doeKerosene = val;
        }
      });
    }

    // Build per-fuel adjustment labels for UI (replaces "Loading...")
    const fuelAdjustments = {
      ron91: doeGasoline || null,
      ron95: doeGasoline || null,
      ron100: doeGasoline || null,
      ron97: doeGasoline || null,
      diesel_std: doeDiesel || null,
      diesel_prem: doeDiesel || null,
      kerosene: doeKerosene || null
    };

    // ── Price table scraping ──
    // Pattern: <tr><td>Brand</td><td>Diesel</td><td>Unleaded</td></tr>
    const tableRegex = /<tr[^>]*>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gi;

    let match;
    let foundCount = 0;

    while ((match = tableRegex.exec(html)) !== null) {
      const rawBrand = match[1].replace(/<[^>]+>/g, '').trim().toLowerCase();
      const col2 = match[2].replace(/<[^>]+>/g, '').replace(/[₱,]/g, '').trim();
      const col3 = match[3].replace(/<[^>]+>/g, '').replace(/[₱,]/g, '').trim();

      const val2 = parseFloat(col2) || 0;
      const val3 = parseFloat(col3) || 0;

      let diesel, unleaded;
      if (val2 > 0 && val3 > 0) {
        diesel = val2 < val3 ? val2 : val3;
        unleaded = val2 < val3 ? val3 : val2;
      } else {
        continue;
      }

      if (rawBrand.includes('petron') && diesel > 50) {
        prices.petron.diesel_std = diesel;
        prices.petron.ron91 = unleaded;
        prices.petron.ron95 = unleaded + 3.10;
        prices.petron.ron100 = unleaded + 13.15;
        prices.petron.diesel_prem = diesel + 4.25;
        prices.petron.kerosene = diesel - 0.75;
        foundCount++;
      }
      else if (rawBrand.includes('shell') && diesel > 50) {
        prices.shell.diesel_std = diesel;
        prices.shell.ron91 = unleaded;
        prices.shell.ron95 = unleaded + 3.10;
        prices.shell.ron97 = unleaded + 6.64;
        prices.shell.diesel_prem = diesel + 4.70;
        prices.shell.kerosene = diesel - 1.79;
        foundCount++;
      }
      else if (rawBrand.includes('unioil') && diesel > 50) {
        prices.unioil.diesel_std = diesel;
        prices.unioil.ron91 = unleaded;
        prices.unioil.ron95 = unleaded + 3.00;
        foundCount++;
      }
    }

    // Fallback: direct text extraction
    if (foundCount < 2) {
      const petronBlock = html.match(/Petron[\s\S]{0,300}?(\d{2,3}\.\d{2})[\s\S]{0,50}?(\d{2,3}\.\d{2})/i);
      const shellBlock = html.match(/Shell[\s\S]{0,300}?(\d{2,3}\.\d{2})[\s\S]{0,50}?(\d{2,3}\.\d{2})/i);
      const unioilBlock = html.match(/Unioil[\s\S]{0,300}?(\d{2,3}\.\d{2})[\s\S]{0,50}?(\d{2,3}\.\d{2})/i);

      if (petronBlock) {
        const vals = [parseFloat(petronBlock[1]), parseFloat(petronBlock[2])].sort((a,b) => a-b);
        prices.petron.diesel_std = vals[0];
        prices.petron.ron91 = vals[1];
        prices.petron.ron95 = vals[1] + 3.10;
        prices.petron.ron100 = vals[1] + 13.15;
        prices.petron.diesel_prem = vals[0] + 4.25;
        prices.petron.kerosene = vals[0] - 0.75;
      }
      if (shellBlock) {
        const vals = [parseFloat(shellBlock[1]), parseFloat(shellBlock[2])].sort((a,b) => a-b);
        prices.shell.diesel_std = vals[0];
        prices.shell.ron91 = vals[1];
        prices.shell.ron95 = vals[1] + 3.10;
        prices.shell.ron97 = vals[1] + 6.64;
        prices.shell.diesel_prem = vals[0] + 4.70;
        prices.shell.kerosene = vals[0] - 1.79;
      }
      if (unioilBlock) {
        const vals = [parseFloat(unioilBlock[1]), parseFloat(unioilBlock[2])].sort((a,b) => a-b);
        prices.unioil.diesel_std = vals[0];
        prices.unioil.ron91 = vals[1];
        prices.unioil.ron95 = vals[1] + 3.00;
      }
    }

    const adjustment = {
      gasoline_ron91_95: doeGasoline,
      diesel_std: doeDiesel,
      kerosene: doeKerosene,
      lpg_per_kg: null,
      note: doeNote
    };

    if (prices.petron.ron91 < 50 || prices.petron.ron91 > 150) {
      throw new Error("GasWatch scraper returned unrealistic prices");
    }

    return { prices, adjustment, fuelAdjustments, trend: trendText, foundCount };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

/* helper: clean adjustment string */
function cleanAdj(raw) {
  if (!raw) return null;
  let s = raw.trim()
    .replace(/[\u2013\u2014]/g, '-')   // en/em dash to hyphen
    .replace(/[\u2212]/g, '-')         // minus sign to hyphen
    .replace(/\s+/g, ' ')
    .trim();
  // Ensure ₱ prefix if missing but has digits
  if (/[\d]/.test(s) && !s.includes('₱')) s = '₱' + s;
  return s;
}

/* ── PROMPT BUILDERS ── */
function buildFuelPrompt(today) {
  return `Today is ${today}. Search gaswatchph.com for current PH pump prices (Petron/Shell/Unioil) AND the latest DOE weekly adjustment (e.g. "diesel -₱5.00/L", "gasoline +₱1.00/L", "kerosene -₱2.00/L"). Return ONLY compact JSON, no markdown, no explanation. RON91 realistic ₱80-95, diesel ₱75-90. Use null if unavailable.
{"effective_date":"${today}","week_label":"Week of ${today}","doe_adjustment":{"gasoline_ron91_95":null,"diesel_std":null,"kerosene":null,"lpg_per_kg":null,"note":null},"fuel_adjustments":{"ron91":null,"ron95":null,"ron100":null,"ron97":null,"diesel_std":null,"diesel_prem":null,"kerosene":null},"prices":{"petron":{"ron91":null,"ron95":null,"ron100":null,"diesel_std":null,"diesel_prem":null,"kerosene":null},"shell":{"ron91":null,"ron95":null,"ron97":null,"diesel_std":null,"diesel_prem":null,"kerosene":null},"unioil":{"ron91":null,"ron95":null,"diesel_std":null}},"trend_context":null,"next_week_signal":null,"fill_up_advice":null,"sources":[]}`;
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
