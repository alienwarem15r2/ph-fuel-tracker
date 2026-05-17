// scripts/scraper.js — GitHub Actions background scraper
// Runs every 15 min via GH Actions cron, writes fresh data to Vercel KV.
// Needs env: KV_REST_API_URL, KV_REST_API_TOKEN, GROQ_API_KEY (optional, for forecast)

import puppeteer from 'puppeteer';

// ── KV ──────────────────────────────────────────────────────────────────────
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_PFX   = 'priceph:';
const TTL      = 7200; // 2 hours — GitHub Actions cron can be delayed up to ~1 hour

async function kvSet(key, value) {
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', KV_PFX + key, JSON.stringify(value), 'EX', TTL]])
  });
  if (!res.ok) throw new Error(`KV set failed: ${res.status}`);
}

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${KV_PFX}${key}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    signal: AbortSignal.timeout(3000)
  });
  const { result } = await res.json();
  return result ? JSON.parse(result) : null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
};

function phDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

async function fetchHtml(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: BROWSER_HEADERS });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch(e) { clearTimeout(t); throw e; }
}

function extractJSON(raw) {
  try {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) return JSON.parse(raw.slice(s, e + 1));
  } catch {}
  return { error: 'parse failed' };
}

// ── NGCP Parser ───────────────────────────────────────────────────────────────
function parseNGCPOutlook(html) {
  if (html.indexOf('table-dailyoutlook') === -1) throw new Error('PSO table not found');
  const extract = id => { const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`)); return m ? m[1].trim() : null; };
  const pn = s => { const n = parseInt((s||'').replace(/[,\s]/g,''), 10); return isNaN(n) ? null : n; };
  const rawDate = extract('cell-ReportDate') || '';
  const asOf    = rawDate.replace(/[()]/g,'').replace(/as of /i,'').trim();
  const luzCap = pn(extract('cell-LuzonCapacity'));
  const visCap = pn(extract('cell-VisayasCapacity'));
  const minCap = pn(extract('cell-MindanaoCapacity'));
  const luzDem = pn(extract('cell-LuzonPeak'));
  const visDem = pn(extract('cell-VisayasPeak'));
  const minDem = pn(extract('cell-MindanaoPeak'));
  const luzMar = pn(extract('cell-LuzonReserve'));
  const visMar = pn(extract('cell-VisayasReserve'));
  const minMar = pn(extract('cell-MindanaoReserve'));
  if (luzMar === null) throw new Error('Luzon margin not parsed');
  let level, color, bg, border, title, subtitle;
  if (luzMar < 0) {
    level='red'; color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)';
    title=`Luzon — Insufficient Supply (${luzMar.toLocaleString()} MW)`;
    subtitle='Supply deficit. Rotating brownouts possible.';
  } else if (luzMar < 600) {
    level='yellow'; color='#8a5a00'; bg='#fef3dc'; border='rgba(138,90,0,.2)';
    title=`Luzon — Yellow Alert (+${luzMar.toLocaleString()} MW)`;
    subtitle='Reserve below threshold. No brownouts yet, but supply is tight.';
  } else {
    level='normal'; color='#1a7a52'; bg='#e6f5ed'; border='rgba(26,122,82,.2)';
    title=`Luzon — Normal (+${luzMar.toLocaleString()} MW)`;
    subtitle='Adequate operating reserve. No grid alert.';
  }
  return { level, title, subtitle, color, bg, border, alert_times: [],
    pso: { as_of: asOf,
      luzon:    { capacity: luzCap, demand: luzDem, margin: luzMar },
      visayas:  { capacity: visCap, demand: visDem, margin: visMar },
      mindanao: { capacity: minCap, demand: minDem, margin: minMar }
    }
  };
}

// ── Meralco Parsers ───────────────────────────────────────────────────────────
function parseMeralcoAlertInterruptions(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const articleIdx = html.indexOf('node-field');
  const checkText  = articleIdx !== -1 ? html.substring(articleIdx, articleIdx + 80000) : html.substring(0, 80000);
  if (/system\s+condition[:\s]+normal/i.test(checkText)) return [];
  const isRed    = /red\s+alert\s+locations/i.test(checkText);
  const isYellow = !isRed && /yellow\s+alert\s+locations/i.test(checkText);
  if (!isRed && !isYellow) return [];
  const alertLabel = isRed ? 'Red Alert — Manual Load Dropping (MLD)' : 'Yellow Alert — Possible Load Reduction';
  const dateM = html.match(/\b((?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\w*\s+\d{1,2},\s+\d{4})/i);
  const date  = dateM ? dateM[1] : '';
  const wStart = html.indexOf('class="mld-report-wrapper"');
  if (wStart === -1) return [{ city: 'Metro Manila Area', barangay: 'See Meralco advisory', street: null, date, time: 'Multiple windows', reason: alertLabel, type: 'emergency' }];
  const wSection = html.substring(wStart, wStart + 150000);
  const sections = wSection.split(/<h1[^>]*>/i).slice(1);
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
  if (cityMap.size === 0) return [{ city: 'Metro Manila Area', province: null, barangay: 'See Meralco advisory', windows: [], date, time: 'Multiple windows', reason: alertLabel, type: 'emergency' }];
  return [...cityMap.values()].map(entry => ({
    city: entry.city, province: entry.province,
    barangay: [...entry.barangays].join(', ') || 'See Meralco advisory',
    windows: entry.windows, date,
    time: entry.windows.length + ' window' + (entry.windows.length !== 1 ? 's' : ''),
    reason: alertLabel, type: 'emergency'
  }));
}

function parseMeralcoMaintenanceInterruptions(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const titleRx = /<h3[^>]*class="[^"]*field-content[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi;
  const titleMatches = [...html.matchAll(titleRx)];
  const interruptions = [];
  for (let i = 0; i < Math.min(titleMatches.length, 15); i++) {
    const m = titleMatches[i];
    const blockEnd = i + 1 < titleMatches.length ? titleMatches[i + 1].index : html.length;
    const block = html.substring(m.index, blockEnd);
    const full = m[1].trim();
    const parts = full.match(/^(.+?,\s*\d{4})\s*-\s*(.+)$/);
    const date = parts ? parts[1].trim() : full;
    const locFull = parts ? parts[2].trim() : full;
    const cityM = block.match(/views-field-field-service-maintenance-loc[\s\S]{0,1000}?class="field-content"[^>]*>\s*([^<\n]{1,80}?)\s*<\/div>/i);
    const city = (cityM ? cityM[1].trim() : null) || locFull.split('(')[0].trim();
    const timeM = block.match(/views-field-body[\s\S]{0,2000}?<strong>(BETWEEN[\s\S]*?)<\/strong>/i);
    const timeRaw = timeM ? timeM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
    const timeSlot = timeRaw ? timeRaw.replace(/\s*[–\-]\s*PORTIONS?.*/i, '').trim().substring(0, 100) : 'See schedule';
    const circuitM = timeRaw ? timeRaw.match(/PORTIONS?\s+OF\s+(CIRCUIT\s+\S+)/i) : null;
    const circuit = circuitM ? circuitM[1].trim() : null;
    const bgyM = locFull.match(/\(([^)]+)\)/);
    const barangay = bgyM ? bgyM[1] : locFull;
    interruptions.push({ city, barangay, street: null, date, time: timeSlot, reason: 'Scheduled maintenance' + (circuit ? ` · ${circuit}` : ''), type: 'scheduled' });
  }
  return interruptions;
}

async function fetchMeralcoPages() {
  const maintBase = 'https://company.meralco.com.ph/news-and-advisories/maintenance-schedule';
  const [alertRes, m0, m1, m2, m3, m4] = await Promise.all([
    fetch('https://company.meralco.com.ph/news-and-advisories/yellow-and-red-alert-locations', { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }),
    fetch(maintBase,             { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }),
    fetch(maintBase + '?page=1', { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }),
    fetch(maintBase + '?page=2', { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }),
    fetch(maintBase + '?page=3', { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }),
    fetch(maintBase + '?page=4', { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }),
  ]);
  if (!alertRes.ok) throw new Error(`Meralco alert HTTP ${alertRes.status}`);
  const alertHtml = await alertRes.text();
  const pages = await Promise.all([m0, m1, m2, m3, m4].map(r => r.ok ? r.text() : Promise.resolve('')));
  const maintHtml = pages.join('\n');
  return { interruptions: [...parseMeralcoAlertInterruptions(alertHtml), ...parseMeralcoMaintenanceInterruptions(maintHtml)] };
}

// ── Maynilad Parser ───────────────────────────────────────────────────────────
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

// ── Manila Water HTML Parser (for Puppeteer output) ───────────────────────────
function parseManilWaterHTML(html) {
  const getText = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const parseDate = s => { if (!s) return null; const m = s.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[\s.,]+\d{1,2}[,\s]+\d{4}/i); if (!m) return null; const d = new Date(m[0]); return isNaN(d.getTime()) ? m[0] : d.toISOString().split('T')[0]; };
  const parseTime = s => { if (!s) return null; const m = s.match(/\d{1,2}:\d{2}\s*[ap]\.?m\.?/i); return m ? m[0].replace(/\./g, '').trim() : null; };
  const items = [];
  function parseSection(sectionHtml, type, typeLabel) {
    for (const rowM of sectionHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rowM[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => getText(m[1]));
      if (cells.length < 4) continue;
      const [fromRaw, toRaw, city, location, activity, affected] = cells;
      if (!city || city.length > 80 || /city.*municipality/i.test(city)) continue;
      items.push({
        utility: 'Manila Water', type, typeLabel,
        city: city.replace(/\s*(city|municipality)\s*$/i, '').trim(),
        area: [location, affected].filter(Boolean).join(' · '),
        from: parseDate(fromRaw), to: parseDate(toRaw),
        time: (() => { const ft = parseTime(fromRaw), tt = parseTime(toRaw); return ft && tt ? `${ft} – ${tt}` : ft || tt || null; })(),
        reason: (activity || '').trim()
      });
    }
  }
  const maintIdx = html.search(/advisory on maintenance/i);
  const emergIdx = html.search(/advisory on emergency/i);
  if (maintIdx !== -1) parseSection(html.slice(maintIdx, emergIdx > maintIdx ? emergIdx : html.length), 'scheduled', 'Maintenance');
  if (emergIdx !== -1) parseSection(html.slice(emergIdx), 'emergency', 'Emergency');
  return items;
}

async function scrapeManilWaterPuppeteer(browser) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await page.goto('https://www.manilawater.com/customers/service-advisories', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table', { timeout: 15000 }).catch(() => {});
    const html = await page.content();
    return parseManilWaterHTML(html);
  } finally {
    await page.close();
  }
}

// ── GasWatch Scraper ──────────────────────────────────────────────────────────
function extractBlock(src, startIdx) {
  const open = src[startIdx], close = open === '{' ? '}' : ']';
  let depth = 0, i = startIdx;
  while (i < src.length) {
    if (src[i] === open) depth++;
    if (src[i] === close) { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
    i++;
  }
  return null;
}
function grabNum(src, key) { const m = src.match(new RegExp(key + '\\s*:\\s*([0-9]+\\.?[0-9]*)')); return m ? parseFloat(m[1]) : 0; }
function getBrandBlockIn(src, name) { const idx = src.toLowerCase().indexOf(name.toLowerCase() + ':'); if (idx === -1) return null; const bs = src.indexOf('{', idx); return bs === -1 ? null : extractBlock(src, bs); }

async function scrapeGasWatch() {
  const js = await fetchHtml('https://gaswatchph.com/js/data.js');
  const phDeclMatch = js.match(/PRICE_HISTORY\s*=\s*\[/);
  if (!phDeclMatch) throw new Error('PRICE_HISTORY not found');
  const arrStart = js.indexOf('[', phDeclMatch.index);
  const weekBlock = extractBlock(js, js.indexOf('{', arrStart));
  if (!weekBlock) throw new Error('week block not found');
  const brandsStart = weekBlock.indexOf('{', weekBlock.indexOf('brands'));
  const brandsBlock = extractBlock(weekBlock, brandsStart);
  if (!brandsBlock) throw new Error('brands block not found');
  const getBB = name => { const idx = brandsBlock.toLowerCase().indexOf(name.toLowerCase() + ':'); if (idx === -1) return null; const bs = brandsBlock.indexOf('{', idx); return bs === -1 ? null : extractBlock(brandsBlock, bs); };
  const petronB = getBB('petron'), shellB = getBB('shell'), unioilB = getBB('unioil');
  const petronUnleaded = petronB ? grabNum(petronB, 'unleaded') : 0;
  const petronDiesel   = petronB ? grabNum(petronB, 'diesel')   : 0;
  const shellUnleaded  = shellB  ? grabNum(shellB,  'unleaded') : 0;
  const shellDiesel    = shellB  ? grabNum(shellB,  'diesel')   : 0;
  const unioilUnleaded = unioilB ? grabNum(unioilB, 'unleaded') : 0;
  const unioilDiesel   = unioilB ? grabNum(unioilB, 'diesel')   : 0;
  if (petronUnleaded < 50 || petronUnleaded > 200) throw new Error('Unrealistic petron price: ' + petronUnleaded);

  // Previous prices for kerosene computation
  let prevPetronKero = 0, prevShellKero = 0, prevUnioilKero = 0;
  const ppMatch = js.match(/PREVIOUS_PRICES\s*=\s*\{/);
  if (ppMatch) {
    const ppBlock = extractBlock(js, js.indexOf('{', ppMatch.index));
    if (ppBlock) {
      const ppPetron = getBrandBlockIn(ppBlock, 'petron');
      const ppShell  = getBrandBlockIn(ppBlock, 'shell');
      const ppUnioil = getBrandBlockIn(ppBlock, 'unioil');
      if (ppPetron) prevPetronKero = grabNum(ppPetron, 'kerosene');
      if (ppShell)  prevShellKero  = grabNum(ppShell,  'kerosene');
      if (ppUnioil) prevUnioilKero = grabNum(ppUnioil, 'kerosene');
    }
  }

  // Adjustment from advisory title
  function parseAdj(label) { const m = label.match(/([+\-−])\s*[₱]?\s*([0-9]+\.[0-9]+)/); if (!m) return null; return (m[1] === '+' ? '+' : '-') + parseFloat(m[2]).toFixed(2); }
  let adjGasoline = null, adjDiesel = null, adjKerosene = null, adjLpg = null;
  const advPatterns = [/title\s*:\s*["'`]([^"'`]*(?:diesel|gasoline)[^"'`]*)["'`]/i, /["'`]([^"'`]*diesel[^"'`]*gasoline[^"'`]*)["'`]/i];
  for (const pat of advPatterns) {
    const am = js.match(pat);
    if (!am) continue;
    const t = am[1];
    const gm = t.match(/gasoline\s*([+\-−][₱]?[0-9]+\.[0-9]+)/i);
    const dm = t.match(/diesel\s*([+\-−][₱]?[0-9]+\.[0-9]+)/i);
    const km = t.match(/kerosene\s*([+\-−][₱]?[0-9]+\.[0-9]+)/i);
    const lm = t.match(/lpg\s*([+\-−][₱]?[0-9]+\.[0-9]+)/i);
    if (gm) adjGasoline = parseAdj(gm[1]);
    if (dm) adjDiesel   = parseAdj(dm[1]);
    if (km) adjKerosene = parseAdj(km[1]);
    if (lm) adjLpg      = parseAdj(lm[1]);
    if (adjDiesel || adjGasoline) break;
  }

  const keroAdj = adjKerosene ? parseFloat(adjKerosene) : 0;
  const r = (v, d) => v > 0 ? Math.round((v + d) * 100) / 100 : 0;
  const kero = (prev, adj) => prev > 50 ? Math.round((prev + adj) * 100) / 100 : 0;

  // Advisories
  const advisories = [];
  try {
    const advMatch = js.match(/ADVISORIES\s*=\s*\[/);
    if (advMatch) {
      const advBlock = extractBlock(js, js.indexOf('[', advMatch.index));
      if (advBlock) {
        let pos = 1;
        while (pos < advBlock.length && advisories.length < 6) {
          const ob = advBlock.indexOf('{', pos);
          if (ob === -1) break;
          const objBlock = extractBlock(advBlock, ob);
          if (!objBlock) break;
          const dateM  = objBlock.match(/date\s*:\s*["'`]([^"'`\n]+)["'`]/);
          const titleM = objBlock.match(/title\s*:\s*["'`]([^"'`\n]+)["'`]/);
          const bodyM  = objBlock.match(/body\s*:\s*["'`]([^"'`]+)["'`]/);
          const typeM  = objBlock.match(/type\s*:\s*["'`]([^"'`\n]+)["'`]/);
          if (dateM && titleM) advisories.push({ date: dateM[1], title: titleM[1], body: bodyM ? bodyM[1].replace(/\s+/g, ' ').trim() : null, type: typeM ? typeM[1] : 'info' });
          pos = ob + objBlock.length;
        }
      }
    }
  } catch(e) { console.warn('[gaswatch] advisories parse failed:', e.message); }

  return {
    prices: {
      petron: { ron91: petronUnleaded, ron95: r(petronUnleaded, 3.10), ron100: r(petronUnleaded, 13.15), diesel_std: petronDiesel, diesel_prem: r(petronDiesel, 4.25), kerosene: kero(prevPetronKero, keroAdj) },
      shell:  { ron91: shellUnleaded,  ron95: r(shellUnleaded, 3.10),  ron97:  r(shellUnleaded, 6.64),   diesel_std: shellDiesel,  diesel_prem: r(shellDiesel, 4.70),  kerosene: kero(prevShellKero, keroAdj) },
      unioil: { ron91: unioilUnleaded, ron95: r(unioilUnleaded, 3.00), diesel_std: unioilDiesel, kerosene: kero(prevUnioilKero, keroAdj) }
    },
    adjustment: { gasoline_ron91_95: adjGasoline, diesel_std: adjDiesel, kerosene: adjKerosene, lpg_per_kg: adjLpg, note: 'GasWatch PH community + DOE data' },
    advisories
  };
}

// ── DOE Scraper ───────────────────────────────────────────────────────────────
async function scrapeDOEOilMonitor() {
  const html = await fetchHtml('https://legacy.doe.gov.ph/oil-monitor', 8000);
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const dateMatch = text.match(/Oil Monitor as of (\d+\s+\w+\s+\d{4})/i);
  function parseAdj(keyword) {
    let m = text.match(new RegExp(keyword + '[^.\\d]{0,30}P([\\d.]+)[^.\\d]{0,30}(increase|decrease|rollback|reduction)', 'i'));
    if (m) return (/(decrease|rollback|reduction)/i.test(m[2]) ? '-' : '+') + m[1];
    m = text.match(new RegExp('(increase|decrease|rollback)[^.\\d]{0,40}P([\\d.]+)\\/liter[^.]{0,60}' + keyword, 'i'));
    if (m) return (/(decrease|rollback)/i.test(m[1]) ? '-' : '+') + m[2];
    m = text.match(new RegExp(keyword + '[^.]{0,120}(increased|decreased|rollback)[^.\\d]{0,15}P([\\d.]+)', 'i'));
    if (m) return (/(decreased|rollback)/i.test(m[1]) ? '-' : '+') + m[2];
    return null;
  }
  const adj = {
    gasoline_ron91_95: parseAdj('gasoline') || parseAdj('unleaded'),
    diesel_std: parseAdj('diesel'),
    kerosene: parseAdj('kerosene'),
    lpg_per_kg: parseAdj('lpg'),
    note: dateMatch ? `DOE Oil Monitor as of ${dateMatch[1]}` : 'DOE Oil Monitor'
  };
  if (!adj.gasoline_ron91_95 && !adj.diesel_std && !adj.kerosene) throw new Error('No adj data from DOE');
  return adj;
}

// ── PAGASA Parsers ────────────────────────────────────────────────────────────
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
      if      (dev >= -5)  { status='high';     statusLabel='Near Full';    color='#1a4fa0'; bg='#e8effe'; border='rgba(26,79,160,.2)'; }
      else if (dev >= -20) { status='normal';   statusLabel='Normal';       color='#1a7a52'; bg='#e6f5ed'; border='rgba(26,122,82,.2)'; }
      else if (dev >= -40) { status='low';      statusLabel='Low';          color='#8a5a00'; bg='#fef3dc'; border='rgba(138,90,0,.2)'; }
      else                 { status='critical'; statusLabel='Critical Low'; color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)'; }
      dams.push({ name, obs_time: cells[1]||'', rwl, nhwl, dev_24h: dev24h, dev_nhwl: devNHWL, rule_curve: pf(cells[6]), dev_rule: pf(cells[7]), gate: cells[8]||null, status, statusLabel, color, bg, border });
    }
    if (dams.length >= 3) return dams;
  }
  throw new Error('No dam table found');
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

// ── FFWS Scraper ──────────────────────────────────────────────────────────────
const FFWS_BASE = 'https://pasig-marikina-tullahanffws.pagasa.dost.gov.ph';

async function fetchFFWSData() {
  const hdrs = { Referer: FFWS_BASE + '/', 'User-Agent': BROWSER_HEADERS['User-Agent'] };
  const [wlRes, rfRes] = await Promise.all([
    fetch(FFWS_BASE + '/water/main_list.do',    { headers: hdrs, signal: AbortSignal.timeout(10000) }),
    fetch(FFWS_BASE + '/rainfall/main_list.do', { headers: hdrs, signal: AbortSignal.timeout(10000) })
  ]);
  const pfN = s => { if (s == null) return null; const n = parseFloat(String(s).replace(/[^0-9.-]/g, '')); return isNaN(n) ? null : n; };
  const wlRaw = wlRes.ok ? await wlRes.json() : [];
  const rfRaw = rfRes.ok ? await rfRes.json() : [];

  const stations = wlRaw.map(s => {
    const wl = pfN(s.wl), alertwl = pfN(s.alertwl), alarmwl = pfN(s.alarmwl), criticalwl = pfN(s.criticalwl);
    let level = 'normal', levelLabel = 'Normal', color = '#1a7a52', bg = '#e6f5ed', border = 'rgba(26,122,82,.2)';
    if      (wl != null && criticalwl != null && wl >= criticalwl) { level='critical'; levelLabel='Critical'; color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)'; }
    else if (wl != null && alarmwl    != null && wl >= alarmwl)    { level='alarm';    levelLabel='Alarm';    color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)'; }
    else if (wl != null && alertwl    != null && wl >= alertwl)    { level='alert';    levelLabel='Alert';    color='#8a5a00'; bg='#fef3dc'; border='rgba(138,90,0,.2)'; }
    return { name: s.obsnm, wl, alertwl, alarmwl, criticalwl, wl1h: pfN(s.wl1h), wl2h: pfN(s.wl2h), change: pfN(s.wlchange), time: s.timestr, level, levelLabel, color, bg, border };
  }).filter(s => s.name && s.wl != null);

  const rainfall = rfRaw.map(s => {
    const rfday = pfN(s.rfday), rf1h = pfN(s.rf01h), rf3h = pfN(s.rf03h), rf30m = pfN(s.rf30m);
    let intensity = 'none', intensityLabel = 'No Rain', color = '#9e9d97', bg = 'var(--surface)', border = 'var(--border)';
    if (rfday != null) {
      if      (rfday >= 65)  { intensity='extreme';  intensityLabel='Extreme';  color='#b83232'; bg='#fdeaea'; border='rgba(184,50,50,.2)'; }
      else if (rfday >= 30)  { intensity='heavy';    intensityLabel='Heavy';    color='#8a5a00'; bg='#fef3dc'; border='rgba(138,90,0,.2)'; }
      else if (rfday >= 15)  { intensity='moderate'; intensityLabel='Moderate'; color='#1a4fa0'; bg='#e8effe'; border='rgba(26,79,160,.2)'; }
      else if (rfday >= 2.5) { intensity='light';    intensityLabel='Light';    color='#1a7a52'; bg='#e6f5ed'; border='rgba(26,122,82,.2)'; }
    }
    return { name: s.obsnm, rfday, rf1h, rf3h, rf30m, time: s.timestr, intensity, intensityLabel, color, bg, border };
  }).filter(s => s.name && s.rfday != null);

  return { stations, rainfall, obs_time: wlRaw[0]?.timestr || rfRaw[0]?.timestr || null };
}

// ── Groq (for fuel forecast) ──────────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_API_KEY;

async function groqSearch(prompt) {
  if (!GROQ_KEY) throw new Error('No GROQ_API_KEY');
  const body = JSON.stringify({ model: 'compound-beta', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
  const hdrs = { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' };
  let r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: hdrs, body, signal: AbortSignal.timeout(30000) });
  if (r.ok) return (await r.json()).choices?.[0]?.message?.content || '{}';
  // fallback model
  r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: hdrs, body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(30000) });
  if (r.ok) return (await r.json()).choices?.[0]?.message?.content || '{}';
  throw new Error(`Groq error: ${r.status}`);
}

function buildForecastPrompt(today) {
  return `Today is ${today} Philippines. Search for next week's Philippine fuel price adjustment forecast: will gasoline, diesel, kerosene prices increase or rollback? Include DOE signals, analyst forecasts, and OPEC/Dubai crude oil trends. Return ONLY compact JSON, no markdown:\n{"next_week_forecast":{"gasoline":null,"diesel":null,"kerosene":null,"lpg":null,"signal":"increase|rollback|mixed|stable","confidence":"confirmed|expected|unknown","note":"1-2 sentence summary"}}\nValues are signed strings like "+2.00" or "-9.57". Use null if unknown.`;
}

// ── Main Scrapers ─────────────────────────────────────────────────────────────
async function scrapePower() {
  const today = phDate();
  const [ngcpResult, meralcoResult] = await Promise.allSettled([
    fetchHtml('https://www.ngcp.ph/').then(parseNGCPOutlook),
    fetchMeralcoPages()
  ]);

  const ngcpData    = ngcpResult.status === 'fulfilled' ? { grid_status: ngcpResult.value } : null;
  const meralcoData = meralcoResult.status === 'fulfilled' ? meralcoResult.value : null;

  if (ngcpResult.status === 'rejected')  console.warn('[power] NGCP failed:', ngcpResult.reason?.message);
  if (meralcoResult.status === 'rejected') console.warn('[power] Meralco failed:', meralcoResult.reason?.message);

  // Persist last-known-good NGCP
  if (ngcpData?.grid_status) await kvSet('ngcp_last_good', ngcpData.grid_status).catch(() => {});

  let grid_status = ngcpData?.grid_status;
  if (!grid_status) {
    grid_status = await kvGet('ngcp_last_good').catch(() => null) || {
      level: 'normal', title: 'Luzon Grid — Status Unknown',
      subtitle: 'NGCP live status temporarily unavailable.',
      color: '#6b6a65', bg: '#f0efe9', border: 'rgba(0,0,0,.1)', alert_times: []
    };
  }

  const result = {
    grid_status,
    interruptions: meralcoData?.interruptions || [],
    last_updated: today,
    sources: [ngcpResult.status === 'fulfilled' ? 'ngcp.ph (direct)' : 'ngcp.ph (cached)', 'company.meralco.com.ph (direct)'].filter(Boolean),
    _meta: { source: 'cron', cached_at: new Date().toISOString() }
  };
  console.log(`[power] NGCP: ${grid_status.level}, Meralco interruptions: ${result.interruptions.length}`);
  return result;
}

async function scrapeFuel() {
  const today = phDate();
  const [gwResult, doeResult, forecastResult] = await Promise.allSettled([
    scrapeGasWatch(),
    scrapeDOEOilMonitor(),
    GROQ_KEY ? groqSearch(buildForecastPrompt(today)).then(raw => { const j = extractJSON(raw); return j.next_week_forecast || null; }).catch(() => null) : Promise.resolve(null)
  ]);

  const gwData       = gwResult.status === 'fulfilled' ? gwResult.value : null;
  const doeAdj       = doeResult.status === 'fulfilled' ? doeResult.value : null;
  const forecastData = forecastResult.status === 'fulfilled' ? forecastResult.value : null;

  if (!gwData) { console.warn('[fuel] GasWatch failed:', gwResult.reason?.message); }
  if (!doeAdj) console.warn('[fuel] DOE failed:', doeResult.reason?.message);

  if (!gwData) throw new Error('GasWatch unavailable — skipping fuel KV write');

  const adj = gwData.adjustment;
  if (doeAdj) {
    if (doeAdj.gasoline_ron91_95 && !adj.gasoline_ron91_95) adj.gasoline_ron91_95 = doeAdj.gasoline_ron91_95;
    if (doeAdj.diesel_std        && !adj.diesel_std)        adj.diesel_std        = doeAdj.diesel_std;
    if (doeAdj.kerosene          && !adj.kerosene)          adj.kerosene          = doeAdj.kerosene;
    if (doeAdj.lpg_per_kg        && !adj.lpg_per_kg)        adj.lpg_per_kg        = doeAdj.lpg_per_kg;
  }

  const result = {
    effective_date: today,
    week_label: `Week of ${today}`,
    doe_adjustment: adj,
    prices: gwData.prices,
    advisories: gwData.advisories || [],
    next_week_forecast: forecastData,
    trend_context: 'Live GasWatch PH data',
    next_week_signal: forecastData?.signal || null,
    fill_up_advice: 'Prices are stable. Fill up based on your tank level and travel needs.',
    sources: ['gaswatchph.com (direct)', 'legacy.doe.gov.ph (direct)'],
    _meta: { source: 'cron', cached_at: new Date().toISOString() }
  };
  console.log(`[fuel] RON91: ${gwData.prices.petron.ron91}, diesel: ${gwData.prices.petron.diesel_std}`);
  return result;
}

async function scrapeWater(browser) {
  const today = phDate();
  const [mayniladResult, manilaResult] = await Promise.allSettled([
    fetchHtml('https://www.mayniladwater.com.ph/').then(parseMayniladAdvisories),
    scrapeManilWaterPuppeteer(browser)
  ]);

  const interruptions = [];
  const sources = [];

  if (mayniladResult.status === 'fulfilled') {
    interruptions.push(...mayniladResult.value);
    sources.push('mayniladwater.com.ph (direct)');
    console.log(`[water] Maynilad: ${mayniladResult.value.length} items`);
  } else {
    console.warn('[water] Maynilad failed:', mayniladResult.reason?.message);
  }

  if (manilaResult.status === 'fulfilled') {
    interruptions.push(...manilaResult.value);
    sources.push('manilawater.com (Puppeteer)');
    console.log(`[water] Manila Water: ${manilaResult.value.length} items`);
  } else {
    console.warn('[water] Manila Water failed:', manilaResult.reason?.message);
  }

  return { interruptions, last_updated: today, sources, _meta: { source: 'cron', cached_at: new Date().toISOString() } };
}

async function scrapeWaterLevel() {
  const today = phDate();
  const [pagasaResult, ffwsResult] = await Promise.allSettled([
    fetchHtml('https://www.pagasa.dost.gov.ph/flood').then(html => ({ dams: parsePAGASADamTable(html), floodWatch: parsePAGASAFloodWatch(html) })),
    fetchFFWSData()
  ]);

  const dams       = pagasaResult.status === 'fulfilled' ? pagasaResult.value.dams : [];
  const floodWatch = pagasaResult.status === 'fulfilled' ? pagasaResult.value.floodWatch : null;
  const stations   = ffwsResult.status === 'fulfilled' ? ffwsResult.value.stations : [];
  const rainfall   = ffwsResult.status === 'fulfilled' ? ffwsResult.value.rainfall : [];
  const sources    = [];

  if (pagasaResult.status === 'fulfilled') { sources.push('pagasa.dost.gov.ph'); console.log(`[waterlevel] PAGASA: ${dams.length} dams, ${floodWatch?.basins?.length||0} basins`); }
  else console.warn('[waterlevel] PAGASA failed:', pagasaResult.reason?.message);

  if (ffwsResult.status === 'fulfilled') { sources.push('PAGASA FFWS'); console.log(`[waterlevel] FFWS: ${stations.length} stations, ${rainfall.length} rainfall`); }
  else console.warn('[waterlevel] FFWS failed:', ffwsResult.reason?.message);

  return { dams, flood_watch: floodWatch, stations, rainfall,
    obs_time: dams[0]?.obs_time || null,
    ffws_time: ffwsResult.status === 'fulfilled' ? ffwsResult.value.obs_time : null,
    last_updated: today, sources,
    _meta: { source: 'cron', cached_at: new Date().toISOString() }
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!KV_URL || !KV_TOKEN) { console.error('KV env vars missing'); process.exit(1); }

  console.log(`[scraper] Starting — ${new Date().toISOString()} (PH: ${phDate()})`);

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true });

  try {
    const [powerR, fuelR, waterR, waterLevelR] = await Promise.allSettled([
      scrapePower().then(d => kvSet('power', d)).then(() => console.log('[scraper] power ✓')),
      scrapeFuel().then(d => kvSet('fuel', d)).then(() => console.log('[scraper] fuel ✓')),
      scrapeWater(browser).then(d => kvSet('water', d)).then(() => console.log('[scraper] water ✓')),
      scrapeWaterLevel().then(d => kvSet('waterlevel', d)).then(() => console.log('[scraper] waterlevel ✓'))
    ]);

    for (const [name, r] of [['power', powerR], ['fuel', fuelR], ['water', waterR], ['waterlevel', waterLevelR]]) {
      if (r.status === 'rejected') console.error(`[scraper] ${name} FAILED:`, r.reason?.message);
    }

    const failed = [powerR, fuelR, waterR, waterLevelR].filter(r => r.status === 'rejected').length;
    console.log(`[scraper] Done — ${4 - failed}/4 succeeded`);
    if (failed === 4) process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[scraper] Fatal:', e); process.exit(1); });
