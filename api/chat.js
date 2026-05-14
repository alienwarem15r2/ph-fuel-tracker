// api/chat.js — Vercel Serverless Function
// Handles three POST actions:
//   { action: "chat",  system, messages }  → Groq AI chat
//   { action: "fuel" }                     → live DOE fuel prices via web search
//   { action: "power" }                    → live Meralco/NGCP interruptions via web search
//   { action: "debug" }                    → returns env/config info (remove in production)
//
// Required env var in Vercel: GROQ_API_KEY

const GROQ_BASE = "https://api.groq.com/openai/v1";

// compound-beta = Groq's model with native web search built in
// Falls back to llama-3.3-70b-versatile if compound-beta is unavailable
const SEARCH_MODEL_PRIMARY  = "compound-beta";
const SEARCH_MODEL_FALLBACK = "llama-3.3-70b-versatile";
const CHAT_MODEL            = "llama-3.3-70b-versatile";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // API key check
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("[chat.js] GROQ_API_KEY env var is missing");
    return res.status(500).json({
      error: "GROQ_API_KEY is not set in Vercel environment variables. " +
             "Go to Vercel → your project → Settings → Environment Variables → add GROQ_API_KEY."
    });
  }

  // Body parsing — Vercel doesn't always auto-parse JSON
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};

  const { action = "chat", system, messages } = body;
  console.log(`[chat.js] action="${action}"`);

  try {
    if (action === "debug")  return await handleDebug(apiKey, res);
    if (action === "fuel")   return await handleFuel(apiKey, res);
    if (action === "power")  return await handlePower(apiKey, res);
    return await handleChat(apiKey, system, messages, res);
  } catch (err) {
    console.error("[chat.js] Unhandled error:", err);
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}

// ─────────────────────────────────────────────────────────────
// DEBUG — helps diagnose deployment issues
// Hit: POST /api/chat  body: { "action": "debug" }
// ─────────────────────────────────────────────────────────────
async function handleDebug(apiKey, res) {
  // Quick test call to Groq to verify the key works
  const testResult = await groqPost("/models", apiKey, null, "GET");
  return res.status(200).json({
    ok: true,
    apiKeyPresent: true,
    apiKeyPrefix: apiKey.slice(0, 8) + "…",
    nodeVersion: process.version,
    groqReachable: testResult.ok,
    groqStatus: testResult.status,
    groqError: testResult.ok ? null : testResult.data
  });
}

// ─────────────────────────────────────────────────────────────
// CHAT
// ─────────────────────────────────────────────────────────────
async function handleChat(apiKey, system, messages, res) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  const payload = {
    model: CHAT_MODEL,
    max_tokens: 800,
    messages: [
      { role: "system", content: system || "You are a helpful assistant." },
      ...messages.slice(-10)
    ]
  };

  const r = await groqPost("/chat/completions", apiKey, payload);
  if (!r.ok) {
    console.error("[chat.js] Chat error:", r.status, JSON.stringify(r.data));
    return res.status(r.status).json({ error: r.data?.error || r.data });
  }

  const text = r.data.choices?.[0]?.message?.content || "";
  return res.status(200).json({ content: [{ text }] }); // Anthropic-compatible shape
}

// ─────────────────────────────────────────────────────────────
// FUEL — latest DOE advisory + pump prices via web search
// ─────────────────────────────────────────────────────────────
async function handleFuel(apiKey, res) {
  const today = phDate();

  const prompt =
`Today is ${today} (Philippine time).

Search query: site:fuelprice.ph Petron Shell Unioil for:
1. The most recent DOE (Department of Energy Philippines) weekly petroleum price monitoring report — find the LATEST effective date and adjustment amounts
2. The ACTUAL CURRENT PUMP PRICES (not DOE SRP baselines) at Petron, Shell, and Unioil stations in Metro Manila NCR as of today

IMPORTANT PRICE SANITY CHECK: For Philippine pump prices, use the most recent data you can find.

Respond with ONLY a JSON object. No markdown fences. No explanation. Start with { and end with }.

{
 "Visit and read fuelprice.ph and gaswatchph.com for the current week's official pump prices. Do not use old news articles or press releases. Return the exact prices shown on those sites for May 12, 2026."
  },
  "prices": {
  "petron": { "ron91": "SEARCH_RESULT", "ron95": "SEARCH_RESULT", ... },
  "shell": { "ron91": "SEARCH_RESULT", "ron95": "SEARCH_RESULT", ... },
  "unioil":  { "ron91": "SEARCH_RESULT", "ron95": "SEARCH_RESULT", ... }
}
  },
  "trend_context": "1-2 sentences on recent price trend",
  "next_week_signal": "Brief note on what to expect next Tuesday",
  "fill_up_advice": "Practical 1-2 sentence advice for Filipino motorists",
  "sources": ["url1", "url2"]
}`;

  const raw = await searchCompletion(apiKey, prompt);
  const json = extractJSON(raw);

  if (json.error) {
    console.error("[chat.js] Fuel parse error:", json.error, "| raw:", (json.raw || "").slice(0, 200));
    return res.status(500).json({ error: "Fuel data parse error: " + json.error, debug_raw: (json.raw || "").slice(0, 300) });
  }

  // ── Sanity check: reject obviously wrong prices ──
  // Philippine pump prices 2025-2026 are roughly ₱60-₱95/L for regular grades.
  // If the model hallucinated prices outside this window, reject rather than serve bad data.
  const r91 = json.prices?.petron?.ron91;
  if (r91 !== undefined) {
    if (r91 < 55 || r91 > 130) {
      console.error(`[chat.js] Fuel sanity FAIL: petron ron91=${r91} is out of realistic range ₱55-₱130. Rejecting.`);
      return res.status(500).json({
        error: `Sanity check failed: Petron RON 91 = ₱${r91} is outside the realistic range ₱55–₱130. ` +
               "The model may have returned outdated or hallucinated data. Raw data returned to client as debug_raw.",
        debug_raw: JSON.stringify(json).slice(0, 500)
      });
    }
    console.log("[chat.js] Fuel OK:", json.effective_date, "petron ron91: ₱" + r91);
  }

  return res.status(200).json(json);
}

// ─────────────────────────────────────────────────────────────
// POWER — latest Meralco/NGCP interruptions via web search
// ─────────────────────────────────────────────────────────────
async function handlePower(apiKey, res) {
  const today = phDate();

  const prompt =
`Today is ${today} (Philippine time).

Search the web for:
1. Current NGCP Luzon grid alert status (Red Alert / Yellow Alert / normal)
2. Most recent Meralco scheduled power interruptions in Metro Manila
3. Any Meralco emergency outages from the past 48 hours in NCR and Pampanga

Respond with ONLY a JSON object. No markdown fences. No explanation. Start with { end with }.

Use this exact structure:
{
  "grid_status": {
    "level": "normal",
    "title": "Luzon Grid — Normal Conditions",
    "subtitle": "Adequate reserve. No alerts.",
    "color": "#1a7a52",
    "bg": "#e6f5ed",
    "border": "rgba(26,122,82,.2)",
    "alert_times": []
  },
  "interruptions": [
    {
      "city": "Quezon City",
      "barangay": "Batasan Hills, Fairview",
      "street": "Multiple streets",
      "date": "May 20",
      "time": "8:00 AM - 5:00 PM",
      "reason": "Maintenance of high-voltage facilities",
      "type": "scheduled"
    }
  ],
  "last_updated": "${today}",
  "sources": ["url1"]
}

grid_status.level must be: "red", "yellow", or "normal".
interruption type must be: "scheduled", "emergency", or "clear".
For red alert: color="#b83232", bg="#fdeaea", border="rgba(184,50,50,.2)"
For yellow alert: color="#8a5a00", bg="#fef3dc", border="rgba(138,90,0,.15)"
Include up to 25 entries. Pampanga cities (San Fernando, Angeles, Mabalacat, Clark) as separate entries.`;

  const raw = await searchCompletion(apiKey, prompt);
  const json = extractJSON(raw);

  if (json.error) {
    console.error("[chat.js] Power parse error:", json.error, "| raw:", (json.raw || "").slice(0, 200));
    return res.status(500).json({ error: "Power data parse error: " + json.error, debug_raw: (json.raw || "").slice(0, 300) });
  }

  console.log("[chat.js] Power OK, grid level:", json.grid_status?.level, "interruptions:", json.interruptions?.length);
  return res.status(200).json(json);
}

// ─────────────────────────────────────────────────────────────
// GROQ HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Try compound-beta (native web search) first.
 * If it fails, fall back to llama-3.3-70b-versatile.
 * If that also fails, try llama without tools (uses training knowledge).
 */
async function searchCompletion(apiKey, userPrompt) {
  // ── Attempt 1: compound-beta with native web search ──
  const r1 = await groqPost("/chat/completions", apiKey, {
    model: SEARCH_MODEL_PRIMARY,
    max_tokens: 2000,
    messages: [{ role: "user", content: userPrompt }]
  });

  if (r1.ok) {
    const text = r1.data.choices?.[0]?.message?.content || "{}";
    console.log("[chat.js] compound-beta OK, chars:", text.length);
    return text;
  }

  console.warn("[chat.js] compound-beta failed:", r1.status, JSON.stringify(r1.data).slice(0, 200));

  // ── Attempt 2: llama-3.3-70b with web_search tool ──
  const r2 = await groqPost("/chat/completions", apiKey, {
    model: SEARCH_MODEL_FALLBACK,
    max_tokens: 2000,
    messages: [{ role: "user", content: userPrompt }]
  });

  if (r2.ok) {
    const text = r2.data.choices?.[0]?.message?.content || "{}";
    console.log("[chat.js] llama fallback OK, chars:", text.length);
    return text;
  }

  console.warn("[chat.js] llama fallback failed:", r2.status, JSON.stringify(r2.data).slice(0, 200));

  throw new Error(
    `Groq API unreachable. compound-beta: ${r1.status}, llama fallback: ${r2.status}. ` +
    `Check your GROQ_API_KEY and that your Groq account has access to these models. ` +
    `Error: ${JSON.stringify(r2.data?.error || r2.data).slice(0, 200)}`
  );
}

/** Thin fetch wrapper — returns { ok, status, data } */
async function groqPost(path, apiKey, payload, method = "POST") {
  try {
    const opts = {
      method,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    };
    if (payload && method !== "GET") opts.body = JSON.stringify(payload);

    const response = await fetch(`${GROQ_BASE}${path}`, opts);

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : { raw: await response.text() };

    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    console.error("[chat.js] fetch error:", err.message);
    return { ok: false, status: 503, data: { error: { message: "Network error: " + err.message } } };
  }
}

/** Extract first complete JSON object from a string */
function extractJSON(raw) {
  if (!raw || typeof raw !== "string") {
    return { error: "Empty/null response", raw: String(raw || "").slice(0, 100) };
  }

  // Strip markdown fences
  let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");

  if (start === -1 || end <= start) {
    return { error: "No JSON object found in response", raw: s.slice(0, 300) };
  }

  let jsonStr = s.slice(start, end + 1);

  // Try parsing as-is
  try { return JSON.parse(jsonStr); } catch (_) {}

  // Fix common LLM mistakes: trailing commas
  const fixed = jsonStr
    .replace(/,(\s*[}\]])/g, "$1")  // remove trailing commas before } or ]
    .replace(/'/g, '"');             // replace single quotes with double quotes

  try { return JSON.parse(fixed); } catch (e) {
    return { error: "JSON parse failed: " + e.message, raw: jsonStr.slice(0, 400) };
  }
}

/** Philippine date string */
function phDate() {
  return new Date().toLocaleDateString("en-PH", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "Asia/Manila"
  });
}
