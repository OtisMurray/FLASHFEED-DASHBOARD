import csv
import io
import re
import requests
from pathlib import Path

URLS = [
    "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
    "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
]

OUT = Path("config/social_tickers_all_us.txt")

BAD_TYPES = [
    "Warrant",
    "Unit",
    "Right",
    "Preferred",
    "Depositary",
    "Note",
    "ETF",
    "ETN",
    "Fund",
]

def clean_symbol(sym):
    sym = sym.strip().upper()
    # StockTwits uses dot symbols less consistently; skip complex classes for now.
    if "$" in sym or "^" in sym or "/" in sym:
        return ""
    if len(sym) > 6:
        return ""
    if not re.match(r"^[A-Z][A-Z0-9.]*$", sym):
        return ""
    return sym

def bad_name(name):
    low = name.lower()
    return any(x.lower() in low for x in BAD_TYPES)

def parse_pipe_file(text):
    lines = [
        line for line in text.splitlines()
        if line.strip() and not line.startswith("File Creation Time")
    ]

    reader = csv.DictReader(io.StringIO("\n".join(lines)), delimiter="|")
    out = []

    for row in reader:
        sym = clean_symbol(row.get("Symbol") or row.get("ACT Symbol") or "")
        name = row.get("Security Name") or row.get("Security Name") or ""

        if not sym:
            continue
        if row.get("Test Issue", "").upper() == "Y":
            continue
        if bad_name(name):
            continue

        out.append(sym)

    return out

def main():
    symbols = []

    for url in URLS:
        print("Fetching", url)
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        symbols.extend(parse_pipe_file(r.text))

    # Preserve order, dedupe.
    seen = set()
    final = []
    for sym in symbols:
        if sym not in seen:
            seen.add(sym)
            final.append(sym)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(final) + "\n")

    print("Wrote", len(final), "symbols to", OUT)

if __name__ == "__main__":
    main()
