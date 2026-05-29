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

DOE_PAGE = (
    "https://doe.gov.ph/articles/group/liquid-fuels"
    "?maincat=Retail+Pump+Prices&subcategory=NCR+Pump+Prices&display_type=Card"
)
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; priceph-scraper/1.0)"}

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
    resp = requests.get(DOE_PAGE, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    links = re.findall(
        r'https://prod-cms\.doe\.gov\.ph/documents/d/[^\s"\'<>]+', resp.text
    )
    if not links:
        raise RuntimeError("No NCR PDF links found on DOE page")

    def url_date(url):
        m = re.search(r"ncr-price-monitoring-(\d{8})-pdf", url)
        if m:
            try:
                return datetime.strptime(m.group(1), "%m%d%Y")
            except ValueError:
                pass
        return datetime.min

    return max(links, key=url_date)


def safe_float(val):
    if val is None:
        return None
    s = str(val).strip().replace(",", "").replace("−", "-")
    try:
        v = float(s)
        return v if 50 < v < 250 else None
    except ValueError:
        return None


def extract_prices(pdf_path):
    prices = {}
    current_city = None

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            table = page.extract_table()
            if not table:
                continue

            header_found = False
            for row in table:
                if not row:
                    continue

                # Locate the header row
                if not header_found:
                    flat = " ".join(str(c) for c in row if c).upper()
                    if "AREA" in flat and "PRODUCT" in flat:
                        header_found = True
                    continue

                # Track current city (col 0)
                if row[0] and str(row[0]).strip():
                    raw = str(row[0]).strip()
                    current_city = CITY_NORM.get(raw, raw)

                if not current_city:
                    continue

                # Product (col 1)
                product = str(row[1]).strip().upper() if row[1] else ""
                fuel_key = FUEL_MAP.get(product)
                if not fuel_key:
                    continue

                # Collect all numeric values in the row (cols 2 onward)
                nums = [safe_float(c) for c in row[2:]]
                valid = [v for v in nums if v is not None]
                if not valid:
                    continue

                # Last non-None numeric = COMMON PRICE
                # Second-to-last = OVERALL RANGE hi
                # Third-to-last  = OVERALL RANGE lo
                # (works because COMMON PRICE is always rightmost numeric column)
                rev = list(reversed([safe_float(c) for c in row]))
                common = next((v for v in rev if v is not None), None)
                range_hi = next((v for v in rev[1:] if v is not None), None)
                range_lo = next((v for v in rev[2:] if v is not None), None)

                # Find brand with the lowest price (cheapest)
                cheapest_brand = None
                brand_cols = [
                    (2,  3,  "Petron"),
                    (4,  5,  "Shell"),
                    (6,  7,  "Caltex"),
                    (8,  9,  "Phoenix"),
                    (10, 11, "Total"),
                    (12, 13, "Flying V"),
                    (14, 15, "Unioil"),
                    (16, 17, "Seaoil"),
                    (18, 19, "PTT"),
                    (20, 21, "Independent"),
                ]
                best = None
                for lo_i, hi_i, brand in brand_cols:
                    v = safe_float(row[lo_i]) if lo_i < len(row) else None
                    if v is not None and (best is None or v < best):
                        best = v
                        cheapest_brand = brand

                entry = {}
                if range_lo is not None: entry["lo"]       = round(range_lo, 2)
                if range_hi is not None: entry["hi"]       = round(range_hi, 2)
                if common   is not None: entry["avg"]      = round(common, 2)
                if cheapest_brand:       entry["cheapest"] = cheapest_brand

                if entry:
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
