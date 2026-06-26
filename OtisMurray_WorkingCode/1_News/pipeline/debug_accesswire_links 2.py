import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import re

PAGES = [
    "https://www.accessnewswire.com/newsroom",
    "https://newsroom.accesswire.com/",
]

HEADERS = {
    "User-Agent": "FeedFlashStockDashboard/0.1 contact: otisemurray@icloud.com"
}

BAD = [
    "blog topics",
    "public relations",
    "investor relations",
    "conference",
    "software",
    "privacy",
    "terms",
    "contact",
    "login",
    "subscribe",
    "industry",
    "industries",
]

def clean(x):
    return re.sub(r"\s+", " ", x or "").strip()

for page in PAGES:
    print("\n==============================")
    print("PAGE:", page)

    r = requests.get(page, headers=HEADERS, timeout=30)
    print("status:", r.status_code, "len:", len(r.text))

    soup = BeautifulSoup(r.text, "html.parser")

    rows = []
    for a in soup.find_all("a", href=True):
        title = clean(a.get_text(" ", strip=True))
        url = urljoin(page, a["href"]).split("#")[0].split("?")[0]

        if len(title) < 25:
            continue

        low = title.lower()
        if any(b in low for b in BAD):
            continue

        # Do not allow the page itself/category pages as article rows.
        parsed = urlparse(url)
        path = parsed.path.rstrip("/").lower()

        if path in ["", "/newsroom"]:
            continue

        rows.append((title, url))

    seen = set()
    unique = []
    for title, url in rows:
        key = (title, url)
        if key not in seen:
            seen.add(key)
            unique.append((title, url))

    print("candidate count:", len(unique))
    for title, url in unique[:50]:
        print("-", title)
        print(" ", url)
