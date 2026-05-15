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

    // Find the brand price table
    // GasWatch PH uses: <tr><td>Brand</td><td>Diesel</td><td>Unleaded</td></tr>
    const tableRegex = /<tr[^>]*>\s*<<td[^>]*>(.*?)<<\/td>\s*<<td[^>]*>(.*?)<<\/td>\s*<<td[^>]*>(.*?)<<\/td>\s*<<\/tr>/gi;
    
    let match;
    let foundCount = 0;

    while ((match = tableRegex.exec(html)) !== null) {
      const rawBrand = match[1].replace(/<<[^>]+>/g, '').trim().toLowerCase();
      const col2 = match[2].replace(/<<[^>]+>/g, '').replace(/[₱,]/g, '').trim();
      const col3 = match[3].replace(/<<[^>]+>/g, '').replace(/[₱,]/g, '').trim();

      // Determine which column is diesel vs unleaded by value
      // Diesel is typically cheaper than unleaded
      const val2 = parseFloat(col2) || 0;
      const val3 = parseFloat(col3) || 0;
      
      let diesel, unleaded;
      if (val2 > 0 && val3 > 0) {
        // Both present — diesel is usually lower
        if (val2 < val3) {
          diesel = val2; unleaded = val3;
        } else {
          diesel = val3; unleaded = val2;
        }
      } else if (val2 > 0) {
        diesel = val2; unleaded = 0;
      } else if (val3 > 0) {
        diesel = val3; unleaded = 0;
      } else {
        continue; // no valid prices
      }

      // Map to brands
      if (rawBrand.includes('petron') && diesel > 50) {
        prices.petron.diesel_std = diesel;
        prices.petron.ron91 = unleaded;
        prices.petron.ron95 = unleaded + 3.10;  // typical Petron spread
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
      else if (rawBrand.includes('flying v') && diesel > 50) {
        // Track cheapest for reference
        console.log("[gaswatch] Flying V — Diesel:", diesel, "Unleaded:", unleaded);
      }
    }

    // Fallback: if table parsing failed, try direct text extraction
    if (foundCount < 2) {
      console.warn("[gaswatch] Table parsing failed, trying direct extraction");
      
      // Look for "Petron" followed by prices within 300 chars
      const petronBlock = html.match(/Petron[\s\S]{0,300}?(\d{2,3}\.\d{2})[\s\S]{0,50}?(\d{2,3}\.\d{2})/i);
      const shellBlock = html.match(/Shell[\s\S]{0,300}?(\d{2,3}\.\d{2})[\s\S]{0,50}?(\d{2,3}\.\d{2})/i);
      const unioilBlock = html.match(/Unioil[\s\S]{0,300}?(\d{2,3}\.\d{2})[\s\S]{0,50}?(\d{2,3}\.\d{2})/i);

      if (petronBlock) {
        const vals = [parseFloat(petronBlock[1]), parseFloat(petronBlock[2])].sort((a,b) => a-b);
        prices.petron.diesel_std = vals[0];
        prices.petron.ron91 = vals[1];
        prices.petron.ron95 = vals[1] + 3.10;
      }
      if (shellBlock) {
        const vals = [parseFloat(shellBlock[1]), parseFloat(shellBlock[2])].sort((a,b) => a-b);
        prices.shell.diesel_std = vals[0];
        prices.shell.ron91 = vals[1];
        prices.shell.ron95 = vals[1] + 3.10;
      }
      if (unioilBlock) {
        const vals = [parseFloat(unioilBlock[1]), parseFloat(unioilBlock[2])].sort((a,b) => a-b);
        prices.unioil.diesel_std = vals[0];
        prices.unioil.ron91 = vals[1];
        prices.unioil.ron95 = vals[1] + 3.00;
      }
    }

    // Extract adjustment from page text
    const adjMatch = html.match(/(?:gasoline|diesel|kerosene)[\s\S]{0,100}?([+-]?\d+\.\d+)[\s\S]{0,20}?\/L/i);
    const adjustment = {
      gasoline_ron91_95: "0.00",
      diesel_std: "0.00",
      kerosene: "0.00",
      lpg_per_kg: "0.00",
      note: "GasWatch PH community + DOE data"
    };

    // Validate
    if (prices.petron.ron91 < 50 || prices.petron.ron91 > 150) {
      throw new Error("GasWatch scraper returned unrealistic prices: ron91=" + prices.petron.ron91);
    }

    console.log("[gaswatch] Extracted:", {
      petron: { r91: prices.petron.ron91, dsl: prices.petron.diesel_std },
      shell: { r91: prices.shell.ron91, dsl: prices.shell.diesel_std },
      unioil: { r91: prices.unioil.ron91, dsl: prices.unioil.diesel_std }
    });

    return { prices, adjustment, foundCount };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}
