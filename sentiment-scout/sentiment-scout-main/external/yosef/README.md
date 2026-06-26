# IST495 Live Market Intelligence Dashboard

## Overview
This project is a real-time stock sentiment and market intelligence system that integrates:

- Stocktwits social sentiment data (scraped in real-time)
- Finviz screener data (user-provided)
- MongoDB database for storage
- Streamlit dashboard for visualization

The system allows users to analyze stock tickers based on:
- Sentiment trends (bullish vs bearish)
- Message density over time
- Rumor detection (buy-in vs leave signals)
- Price movement alongside social activity

---

## Features

- Real-time ticker tracking from Stocktwits
- One active rumor per ticker (buy-in / leave classification)
- Interactive Streamlit dashboard
- Historical and custom time window analysis
- Rolling window controls directly on graphs
- Price + sentiment + message volume overlay
- Finviz integration for dynamic ticker selection

---

## Project Structure

```
app/                # Streamlit dashboard
src/                # Core backend logic
  ├── scraper/      # Stocktwits scraping
  ├── mongo/        # MongoDB utilities
  ├── finviz/       # Finviz fetching logic
data/               # CSV inputs (Finviz exports)
reports/            # Generated reports and plots
archive/            # Old / unused files
requirements.txt
README.md
```

---

## Installation

### 1. Clone the repository
```bash
git clone https://github.com/yz002/ist495-dashboard.git
cd ist495-dashboard
```

### 2. Install dependencies
```bash
pip install -r requirements.txt
```

### 3. Install MongoDB

Download MongoDB Community Edition:
https://www.mongodb.com/try/download/community

Start MongoDB locally:

```bash
mongod
```

Default connection:
```
mongodb://localhost:27017/
```

---

## Running the Project

### Step 1 — Get Finviz tickers
```bash
python src/finviz/finviz_elite_fetch.py
```

OR place a CSV in:
```
data/finviz_daily/
```

---

### Step 2 — Start the scraper
```bash
python src/scraper/scrape_finviz_tickers_curl_mongo.py --finviz_csv data/finviz_daily/YOUR_FILE.csv
```

---

### Step 3 — Run the dashboard
```bash
python -m streamlit run app/streamlit_app/app.py
```

Then open:
```
http://localhost:8501
```

---

## Author
Yosef Zankawi  
Penn State University — Data Science
