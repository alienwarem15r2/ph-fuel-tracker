#!/usr/bin/env python3
"""
Extract DOE NCR retail pump price table from the weekly PDF.
Writes doe_prices.json for scraper.js to consume.
"""
import pdfplumber
import requests
import json
import re
import sys
from datetime import datetime

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/pdf,*/*",
}

FUEL_MAP = {
    "RON 100":     "ron100",
    "RON 97":      "ron97",
    "RON 95":      "r95",
    "RON 91":      "r91",
    "DIESEL":      "dsl",
    "DIESEL PLUS": "dsl_plus",
    "KEROSENE":    "kero",
}

# DOE city names → our normalized names
CITY_NORM = {
    "Caloocan City": "Caloocan",
    "Manila City":   "Manila",
    "Pasig City":    "Pasig",
    "Taguig City":   "Taguig",
    "Makati City":   "Makati",
    "Marikina City": "Marikina",
    "Malabon City":  "Malabon",
    "Navotas City":  "Navotas",
    "Valenzuela City": "Valenzuela",
    "Pasay City":    "Pasay",
    "Muntinlupa City": "Muntinlupa",
    "Las Piñas City":  "Las Pinas",
    "Las Pinas City":  "Las Pinas",
    "Parañaque City":  "Paranaque",
    "Paranaque City":  "Paranaque",
    "San Juan City":   "San Juan",
    "Mandaluyong City": "Mandaluyong",
    "Pateros":          "Pateros",
    "Quezon City":      "Quezon City",
    "Antipolo City":    "Antipolo",
}


def find_latest_pdf_url():
    """
    Construct the PDF URL directly from the date — avoids scraping doe.gov.ph
    which blocks cloud/CI IPs with 403. The PDF server (prod-cms.doe.gov.ph)
    is more permissive. DOE releases the NCR report every Monday.
    Try the last 5 Mondays until one responds 200.
    """
    today = datetime.utcnow() + timedelta(hours=8)  # Philippine time
    # Walk back to the most recent Monday (weekday 0)
    days_back = today.weekday()  # 0=Mon already, 1=Tue→1 day back, etc.
    for extra_weeks in range(5):
        monday = today - timedelta(days=days_back + extra_weeks * 7)
        date_str = monday.strftime("%m%d%Y")
        url = f"https://prod-cms.doe.gov.ph/documents/d/guest/ncr-price-monitoring-{date_str}-pdf"
        try:
            r = requests.head(url, headers=HEADERS, timeout=10, allow_redirects=True)
            if r.status_code == 200:
                print(f"[DOE] Found PDF for {monday.strftime('%Y-%m-%d')}: {url}")
                return url
            print(f"[DOE] {monday.strftime('%Y-%m-%d')} → HTTP {r.status_code}, trying earlier…")
        except Exception as e:
            print(f"[DOE] {monday.strftime('%Y-%m-%d')} → {e}, trying earlier…")
    raise RuntimeError("No accessible DOE PDF found in the last 5 Mondays")


def safe_float(val):
    if val is None:
        return None
    s = str(val).strip().replace(",", "").replace("−", "-")
    # Treat #N/A and other non-numeric markers as missing
    if s in ("", "#N/A", "#n/a", "N/A", "N.A.", "-", "—", "#VALUE!"):
        return None
    try:
        v = float(s)
        return v if 50 < v < 250 else None
    except ValueError:
        return None


def extract_prices(pdf_path):
    prices = {}
    current_city = None
    header_found = False   # persists across pages
    range_lo_col = None    # detected from header row
    range_hi_col = None
    common_col   = None

    BRAND_COLS = [
        (2,  "Petron"),
        (4,  "Shell"),
        (6,  "Caltex"),
        (8,  "Phoenix"),
        (10, "Total"),
        (12, "Flying V"),
        (14, "Unioil"),
        (16, "Seaoil"),
        (18, "PTT"),
        (20, "Independent"),
    ]

    with pdfplumber.open(pdf_path) as pdf:
        print(f"[DOE] PDF has {len(pdf.pages)} page(s)")
        for page_num, page in enumerate(pdf.pages):
            table = page.extract_table()
            if not table:
                print(f"[DOE] Page {page_num+1}: no table found")
                continue
            ncols = len(table[0]) if table else 0
            print(f"[DOE] Page {page_num+1}: {len(table)} rows × {ncols} cols")

            for row in table:
                if not row:
                    continue

                # Detect header row (first occurrence or repeated on page 2)
                flat = " ".join(str(c) for c in row if c).upper()
                if "AREA" in flat and "PRODUCT" in flat:
                    if not header_found:
                        # First header — detect OVERALL RANGE and COMMON PRICE columns
                        for i, cell in enumerate(row):
                            cs = str(cell).upper() if cell else ""
                            if "OVERALL" in cs and range_lo_col is None:
                                range_lo_col = i
                                range_hi_col = i + 1
                            if "COMMON" in cs:
                                common_col = i
                        # Fallback: last 3 columns
                        if range_lo_col is None:
                            n = len(row)
                            range_lo_col, range_hi_col, common_col = n-3, n-2, n-1
                        print(f"[DOE] Columns: range_lo={range_lo_col} range_hi={range_hi_col} common={common_col}")
                        header_found = True
                    continue  # skip header row (including repeated ones on page 2)

                if not header_found:
                    continue

                # Track current city from col 0
                if row[0] and str(row[0]).strip():
                    raw = str(row[0]).strip()
                    current_city = CITY_NORM.get(raw, raw)

                if not current_city:
                    continue

                # Product from col 1
                product = str(row[1]).strip().upper() if row[1] else ""
                fuel_key = FUEL_MAP.get(product)
                if not fuel_key:
                    continue

                n = len(row)

                # OVERALL RANGE and COMMON PRICE using detected column indices
                range_lo = safe_float(row[range_lo_col]) if range_lo_col < n else None
                range_hi = safe_float(row[range_hi_col]) if range_hi_col < n else None
                common   = safe_float(row[common_col])   if common_col   < n else None

                if range_lo is None and range_hi is None:
                    continue  # no usable range data for this row

                # Cheapest brand = lowest lo price across brand columns
                best, cheapest_brand = None, None
                for col_i, brand in BRAND_COLS:
                    v = safe_float(row[col_i]) if col_i < n else None
                    if v is not None and (best is None or v < best):
                        best, cheapest_brand = v, brand

                entry = {}
                if range_lo is not None: entry["lo"]       = round(range_lo, 2)
                if range_hi is not None: entry["hi"]       = round(range_hi, 2)
                if common   is not None: entry["avg"]      = round(common,   2)
                if cheapest_brand:       entry["cheapest"] = cheapest_brand

                if current_city not in prices:
                    prices[current_city] = {}
                prices[current_city][fuel_key] = entry

    return prices


def main():
    out = "doe_prices.json"
    try:
        print("[DOE] Finding latest NCR PDF…")
        pdf_url = find_latest_pdf_url()
        print(f"[DOE] Downloading: {pdf_url}")

        resp = requests.get(pdf_url, headers=HEADERS, timeout=30)
        resp.raise_for_status()

        pdf_path = "/tmp/doe_ncr.pdf"
        with open(pdf_path, "wb") as f:
            f.write(resp.content)

        print("[DOE] Extracting table…")
        prices = extract_prices(pdf_path)

        if not prices:
            print("[DOE] ERROR: no prices extracted — PDF structure may have changed")
            sys.exit(1)

        print(f"[DOE] {len(prices)} cities extracted: {', '.join(sorted(prices))}")

        with open(out, "w") as f:
            json.dump(prices, f, indent=2)
        print(f"[DOE] Written to {out}")

    except Exception as exc:
        print(f"[DOE] FAILED: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
