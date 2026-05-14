// api/chat.js — Vercel Serverless Function
// Handles: chat, fuel, power, debug
//
// Required env var: GROQ_API_KEY

const GROQ_BASE = "https://api.groq.com/openai/v1";
const SEARCH_MODEL_PRIMARY  = "compound-beta";
const SEARCH_MODEL_FALLBACK = "llama-3.3-70b-versatile";
const CHAT_MODEL            = "llama-3.3-70b-versatile";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("[chat.js] GROQ_API_KEY missing");
    return res.status(500).json({
      error: "GROQ_API_KEY is not set. Go to Vercel → Project → Settings → Environment Variables."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== "object") {
    body = {};
  }

  const { action = "chat", system, messages } = body;
  console.log(`[chat.js] action="${action}"`);

  try {
    if (action === "debug") {
      return await handleDebug(apiKey, res);
    }
    if (action === "fuel") {
      return await handleFuel(apiKey, res);
    }
    if (action === "power") {
      return await handlePower(apiKey, res);
    }
    return await handleChat(apiKey, system, messages, res);
  } catch (err) {
    console.error("[chat.js] Unhandled error:", err);
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}

/* ───────────────────────── DEBUG ───────────────────────── */
async function handleDebug(apiKey, res) {
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

/* ───────────────────────── CHAT ───────────────────────── */
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
  return res.status(200).json({ content: [{ text }] });
}

/* ───────────────────────── FUEL ───────────────────────── */
async function handleFuel(apiKey, res) {
  const today = phDate();

  const prompt =
`Today is ${today} (Philippine time).

Your task: Search the web for current Philippine fuel prices and return them as JSON.

Step 1 — Search these specific sources and use ONLY data from May 11-15, 2026:
• fuelprice.ph
• gaswatchph.com
• DOE Oil Monitor

Step 2 — Find:
1. The latest DOE weekly adjustment amounts for gasoline, diesel, kerosene, and LPG.
2. The ACTUAL CURRENT PUMP PRICES at Petron, Shell, and Unioil in Metro Manila NCR.
   - Do NOT use DOE SRP baseline prices.
   - Do NOT use prices from news articles dated before May 11, 2026.

Step 3 — Sanity check: As of May 2026, real Philippine pump prices are roughly ₱80-₱95/L for RON 91 and ₱75-₱90/L for diesel. If your search returns prices outside ₱60-₱120, mark them as null.

Step 4 — Respond with ONLY a JSON object. No markdown fences. No explanation text outside the JSON. Start with { and end with }.

Use this exact structure. Replace every null with the real value. If unavailable after searching, use null.

{
  "effective_date": "May 15, 2026",
  "week_label": "Week of May 12-18, 2026",
  "doe_adjustment": {
    "gasoline_ron91_95": null,
    "diesel_std": null,
    "kerosene": null,
    "lpg_per_kg": null,
    "note": null
  },
  "prices": {
    "petron": {
      "ron91": null,
      "ron95": null,
      "ron100": null,
      "diesel_std": null,
      "diesel_prem": null,
      "kerosene": null
    },
    "shell": {
      "ron91": null,
      "ron95": null,
      "ron97": null,
      "diesel_std": null,
      "diesel_prem": null,
      "kerosene": null
    },
    "unioil": {
      "ron91": null,
      "ron95": null,
      "diesel_std": null
    }
  },
  "trend_context": null,
  "next_week_signal": null,
  "fill_up_advice": null,
  "sources": []
}`;

  const raw = await searchCompletion(apiKey, prompt);
  const json = extractJSON(raw);

  if (json.error) {
    console.error("[chat.js] Fuel parse error:", json.error, "| raw:", (json.raw || "").slice(0, 200));
    return res.status(500).json({
      error: "Fuel data parse error: " + json.error,
      debug_raw: (json.raw || "").slice(0, 300)
    });
  }

  const r91 = json.prices?.petron?.ron91;
  if (r91 !== undefined && r91 !== null) {
    if (r91 < 75 || r91 > 115) {
      console.error(`[chat.js] Fuel sanity FAIL: petron ron91=${r91} out of range.`);
      return res.status(500).json({
        error: `Sanity check failed: Petron RON 91 = ₱${r91} is outside ₱75–₱115.`,
        debug_raw: JSON.stringify(json).slice(0, 500)
      });
    }
    console.log("[chat.js] Fuel OK:", json.effective_date, "petron ron91: ₱" + r91);
  }

  return res.status(200).json(json);
}

/* ───────────────────────── POWER ───────────────────────── */
async function handlePower(apiKey, res) {
  const today = phDate();

  const prompt =
`Today is ${today} (Philippine time).

Search the web for:
1. Current NGCP Luzon grid alert status (Red / Yellow / normal)
2. Most recent Meralco scheduled power interruptions in Metro Manila
3. Any Meralco emergency outages from the past 48 hours in NCR and Pampanga

Respond with ONLY a JSON object. No markdown. Start with { end with }.

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
  "sources": []
}

grid_status.level must be: "red", "yellow", or "normal".
interruption type must be: "scheduled", "emergency", or "clear".
For red alert: color="#b83232", bg="#fdeaea", border="rgba(184,50,50,.2)"
For yellow alert: color="#8a5a00", bg="#fef3dc", border="rgba(138,90,0,.15)"
Include up to 25 entries. Pampanga cities as separate entries.`;

  const raw = await searchCompletion(apiKey, prompt);
  const json = extractJSON(raw);

  if (json.error) {
    console.error("[chat.js] Power parse error:", json.error, "| raw:", (json.raw || "").slice(0, 200));
    return res.status(500).json({
      error: "Power data parse error: " + json.error,
      debug_raw: (json.raw || "").slice(0, 300)
    });
  }

  console.log("[chat.js] Power OK, grid level:", json.grid_status?.level, "count:", json.interruptions?.length);
  return res.status(200).json(json);
}

/* ───────────────────────── GROQ HELPERS ───────────────────────── */
async function searchCompletion(apiKey, userPrompt) {
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
    `Check GROQ_API_KEY. Error: ${JSON.stringify(r2.data?.error || r2.data).slice(0, 200)}`
  );
}

async function groqPost(path, apiKey, payload, method = "POST") {
  try {
    const opts = {
      method,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    };
    if (payload && method !== "GET") {
      opts.body = JSON.stringify(payload);
    }

    const response = await fetch(`${GROQ_BASE}${path}`, opts);

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : { raw: await response.text() };

    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    console.error("[chat.js] fetch error:", err.message);
    return {
      ok: false,
      status: 503,
      data: { error: { message: "Network error: " + err.message } }
    };
  }
}

function extractJSON(raw) {
  if (!raw || typeof raw !== "string") {
    return { error: "Empty/null response", raw: String(raw || "").slice(0, 100) };
  }

  let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");

  if (start === -1 || end <= start) {
    return { error: "No JSON object found in response", raw: s.slice(0, 300) };
  }

  let jsonStr = s.slice(start, end + 1);

  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    // continue to fix
  }

  const fixed = jsonStr
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(/'/g, '"');

  try {
    return JSON.parse(fixed);
  } catch (e) {
    return { error: "JSON parse failed: " + e.message, raw: jsonStr.slice(0, 400) };
  }
}

function phDate() {
  return new Date().toLocaleDateString("en-PH", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila"
  });
}
