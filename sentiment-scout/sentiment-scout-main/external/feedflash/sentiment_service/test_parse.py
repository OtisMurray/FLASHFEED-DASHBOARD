import csv
import re

TICKER_COMPANY = {}
COMPANY_TO_TICKER = {}
SHORT_NAME_TO_TICKER = {}
SHORT_NAME_MCAP = {}

BLACKLIST_SHORT_NAMES = {'target', 'block', 'square', 'visa', 'best', 'alliance', 'resources', 'energy', 'partners', 'capital', 'financial', 'first', 'national', 'american', 'united', 'southwest', 'southern', 'northern', 'eastern', 'western', 'central', 'group', 'holdings', 'technologies', 'solutions', 'systems', 'enterprises', 'industries', 'sciences', 'biosciences', 'brands'}

with open('../social_pipeline/finviz.csv', newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        ticker = (row.get('Ticker') or row.get('ticker') or '').strip().upper()
        company = (row.get('Company') or row.get('company') or '').strip()
        mcap_str = row.get('Market Cap') or '0'
        try:
            mcap = float(mcap_str)
        except:
            mcap = 0.0

        if ticker and company:
            TICKER_COMPANY[ticker] = company
            norm_c = company.lower().strip().rstrip('.')
            COMPANY_TO_TICKER[norm_c] = ticker
            
            words = company.split()
            suffixes = {'inc', 'inc.', 'corp', 'corp.', 'ltd', 'ltd.', 'plc', 'holdings', 'company', 'co', 'co.', 'group', 'sa', 's.a.', 'n.v.', 'lp', 'l.p.', 'bancorp'}
            while words and words[-1].lower() in suffixes:
                words.pop()
            
            if words:
                short_name = " ".join(words).lower()
                if len(short_name) > 3 and short_name not in BLACKLIST_SHORT_NAMES:
                    if short_name not in SHORT_NAME_TO_TICKER or mcap > SHORT_NAME_MCAP.get(short_name, -1):
                        SHORT_NAME_TO_TICKER[short_name] = ticker
                        SHORT_NAME_MCAP[short_name] = mcap

print("Mapped Companies:", len(COMPANY_TO_TICKER))
print("Mapped Short Names:", len(SHORT_NAME_TO_TICKER))
print("Apple short:", SHORT_NAME_TO_TICKER.get("apple"))
print("Tesla short:", SHORT_NAME_TO_TICKER.get("tesla"))
print("Nvidia short:", SHORT_NAME_TO_TICKER.get("nvidia"))
print("Advanced Micro Devices short:", SHORT_NAME_TO_TICKER.get("advanced micro devices"))

title = "Nvidia sees massive growth as AI explodes but Apple struggles"
cap_words = re.findall(r'[A-Z][A-Za-z0-9&\-]+', title)
print("Cap words:", cap_words)
found_tickers = []
for n in [4, 3, 2, 1]:
    for i in range(len(cap_words) - n + 1):
        ngram = " ".join(cap_words[i:i+n]).lower()
        if ngram in SHORT_NAME_TO_TICKER:
            found_tickers.append(SHORT_NAME_TO_TICKER[ngram])
            
print("Found Tickers:", found_tickers)

