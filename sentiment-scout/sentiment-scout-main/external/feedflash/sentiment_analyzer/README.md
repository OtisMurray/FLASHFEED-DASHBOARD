# Integrated Financial Sentiment Analyzer & Dashboard

A professional-grade, full-stack financial analysis system that transforms raw news headlines into actionable trading signals. It leverages an ensemble of NLP models (FinBERT, VADER, Custom ML) and a robust **Gatekeeper (Binary Classifier)** to filter out market noise—ensuring you only see high-confidence opportunities.

![Status](https://img.shields.io/badge/Status-Active-success)
![Python](https://img.shields.io/badge/Python-3.12%2B-blue)
![Streamlit](https://img.shields.io/badge/Streamlit-Dashboard-FF4B4B)
![LightGBM](https://img.shields.io/badge/AI-LightGBM-orange)
![License](https://img.shields.io/badge/License-MIT-green)

---

## 🚀 Project Overview

Most sentiment analyzers fail because they treat every news article as important. This system is different. It implements a strict **Signal vs. Noise** philosophy:

1. **Ingests** thousands of headlines from the web (24/7)
2. **Scores** them using financial-specific NLP models (FinBERT)
3. **Validates** sentiment against historical price action
4. **Filters** headlines using a trained **Gatekeeper AI** that rejects ~90% of fluff
5. **Visualizes** only **high-confidence signals** on a real-time dashboard

---

## ⭐ Key Features

* **Smart Ticker Filtering**
  Pre-scans the market to target only tickers with active news coverage, optimizing resources.

* **Ensemble NLP Engine**
  Combines **FinBERT** (financial LLM), **VADER**, and a **custom dictionary** for nuanced sentiment scoring.

* **The Gatekeeper AI**
  A LightGBM binary classifier trained on historical data to predict whether news will *actually* move price.
  Achieves **~68% precision** on high-confidence signals.

* **Robust Data Handling**
  Includes a custom **Weekend Patch** that maps weekend news to Friday’s close, preventing data gaps during inference.

* **Anti-Overfitting Logic**
  The model is explicitly trained *without* cheat features (e.g., VIX, day of week), forcing it to learn from news content rather than calendar artifacts.

* **Interactive Dashboard**
  Streamlit interface to explore top picks, visualize sentiment vs. Bollinger Bands, and audit AI confidence.

---

## 🔄 System Architecture & Workflow

The pipeline is modular. Each phase builds upon the last, with all data stored in a central MySQL database.

---

## 📂 Core Pipeline (Phases)

### Phase 0 — Preparation

**Script:** `ticker_filter.py`

* **Role:** Optimization & Targeting
* **Tech:** `requests`, `BeautifulSoup`
* **Function:** Scans the market (via Finviz or similar) to generate an optimized list of active tickers (`tickers_with_news.json`). Prevents the scraper from wasting time on inactive stocks.

---

### Phase 1 — Data Ingestion

**Script:** `phase1_headline_scraper.py`

* **Role:** Data Ingestor
* **Tech:** `concurrent.futures`, `requests`
* **Function:** Monitors the filtered list of tickers, scrapes headlines, and handles duplicates and rate limits.

---

### Phase 2 — Sentiment Analysis

**Script:** `phase2_sentiment_analysis.py`

* **Role:** NLP Engine
* **Tech:** `multiprocessing`, `transformers`, `nltk`
* **Function:** Processes text via the `IntegratedProcessor` to generate
  `sentiment_combined ∈ [-1, 1]`

---

### Phase 3 — Market Context & Weekend Patch

**Script:** `phase3_price_integration.py`

* **Role:** Context Provider
* **Tech:** `yfinance`, `pandas_ta`
* **Function:**
  * Fetches OHLCV data
  * Computes RSI, MACD, Bollinger Bands
  * Applies **Weekend Patch** (maps weekend news to last market close)

---

### Phase 4 — AI Models

#### Gatekeeper Classifier

**Script:** `phase4_classifier_mysql.py`

* **Role:** Binary Signal vs. Noise classifier
* **Tech:** LightGBM, Optuna
* **Target:** Price move > 1.5%
* **Safety:** Explicitly excludes macro/calendar features

#### Live Inference Worker

**Script:** `phase4_backfill_predictions.py`

* **Role:** Real-time grading engine
* **Tech:** `joblib`, `sklearn`
* **Output:** `ml_confidence ∈ [0.00, 1.00]`

#### Price Magnitude Regressor (Optional)

**Script:** `phase4_regressor_mysql.py`

* **Role:** Estimates expected move size (e.g., +2.3%)

---

### Phase 5 — Dashboard

**Script:** `phase5_dashboard.py`

* **Tech:** Streamlit, Plotly
* **Views:**
  * 🔮 Watchlist (Green Signals)
  * 📈 Technical Charts
  * 🗂 Data Explorer

---

## 🧠 NLP Engine Internals

* **`integrated_processor.py`**: Orchestrates weighted voting across FinBERT, VADER, and custom dictionary.
* **`sentiment_scorer.py`**: Specialized wrapper for Hugging Face **ProsusAI/finbert** and VADER.

---

## 🛠️ Utilities & Data Management

* **`unified_price_scripts.py`**: Cached, rate-safe price retrieval.
* **`db_mysql.py`**: Central database handler (schema + connections).

---

## 🛠️ Installation & Setup

### Prerequisites

* Python **3.12+**
* MySQL Server (local or remote)
* CUDA-enabled GPU *(recommended, optional)*

---

### 1. Clone the Repository

```bash
git clone [https://github.com/kvesu/sentiment_analyzer.git](https://github.com/kvesu/sentiment_analyzer.git)
cd sentiment_analyzer

```

---

### 2. Install Dependencies

```bash
pip install -r requirements.txt

```

> If using an NVIDIA GPU, install PyTorch with CUDA support separately for best performance.

---

### 3. Configure Database

Create a `.env` file or update `db_mysql.py`:

```ini
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=sentiment_db
MYSQL_PORT=3306

```

---

## 🚦 Usage Guide

Run the pipeline **in order**.

### Step 0 — Prepare Tickers

```bash
python ticker_filter.py

```

### Step 1 — Scrape Headlines

```bash
python phase1_headline_scraper.py

```

### Step 2 — Sentiment Analysis

```bash
python phase2_sentiment_analysis.py

```

### Step 3 — Market Data Sync

```bash
python phase3_price_integration.py

```

### Step 4 — Phase 4: AI Training & Inference (The Brain)
Run these three scripts in order to train the models and generate live signals.

**1. Train the Gatekeeper (Classifier)**
*Learns to distinguish Signal from Noise.*
```bash
python phase4_classifier_mysql.py eod

```

> *Look for **precision > 60%** in the logs.*

**2. Train the Price Predictor (Regressor) [Optional]**
*Learns to predict the magnitude of the move (e.g., +3.5%).*

```bash
python phase4_regressor_mysql.py eod

```

**3. Run Live Inference (The Worker)**
*Applies the trained models to new data. Run this continuously.*

```bash
python phase4_backfill_predictions.py

```

```

```

> Look for **precision > 60%** in the logs.

### Step 5 — Live Inference (Critical)

```bash
python phase4_backfill_predictions.py

```

Run continuously or via cron.

### Step 6 — Launch Dashboard

```bash
streamlit run phase5_dashboard.py

```

---

## 📊 Interpreting the Dashboard

This system uses a **binary Signal vs. Noise** framework.

### Confidence Score (`ml_confidence`)

* 🟢 **Green — Signal (> 0.60)**
High likelihood of price impact. **Actionable.**
* ⚪ **Grey — Noise (< 0.60)**
Likely fluff or irrelevant. **Ignore.**

### The Sunday Effect

On weekends, similar confidence scores may appear due to frozen technical indicators. This is expected behavior from the **Weekend Patch**.

---

## 🤝 Contributing

Contributions are welcome. Please submit a Pull Request or open an Issue.

---

## 📄 License

MIT License.

---

## 📧 Contact

For questions or feedback, please open an issue on GitHub.

https://mermaid.live/edit#pako:eNptVe1uKjcQfZWRpZtfEMHuEtL9l5Yb6UpFSpNUaiv-mPXs4uK1ubYXbhJF6jv0DfskHe-CWT4sJGzsc8bnzHj4YIURyHJWce39QgMNL71CeEauhq-yRnhB7elbe7iBuQmTpoYZd6ul4VbAf__8C0_W_I2Fh3BeSY0dkeAeH42tuQf4k8ZwPh_OZt0e_yHdYe_LEr6Ihe42HPFIo-FJca2lrijoDJ2s9tszLIkfLH5vpMVwGUcnavRWFg72I-fjASSj5G44Gg-T0QBSsUdzz8GZxhYIuOWq4W2s05HzZAC89Gih5YnYg-Lf_4AdBS8tr9GdY9OITbq4p7LaG3zTFbqw7PYepd7Kd3CFRdSElNpjZc-uli_7miZHTS_eFOvXnSQjVtJ5Q0ZwRRz7EAd01BR4skusDfkOeQbnaV73I0dNgeWAfUYhpIeHp2_nwfp-LLM-dnLdDyqfAp0jmm6zLbud1MLsYNkUa_ShEJSpZNGjLsZ96oMdcyLiFYJA7aR_Oy-NAzbaUfRSfKx0V5CPFHMjN21Bn2DTPja7wJJ9WkBh6k3jz5NYRDsCS3Jhx4Pm6s2H-97ACxU9V6478DN33UUCL7fSGe0u3RbRkiDwIOu3hgtL7xvait0Zuz73ssUeLcmO2Eep6KfuHRLHOsxso07rPhfREpFck3V8OzPcojKbYFR35Fe5RWo5lGQLni8VwpWRYxQWQqUXnt_EfBcrbr07wUZhgSU9N2UrXcOVfL_aCjAKw56hryuLbmWUAKekQBuyVbZGuT425hqv5vo1vJnW2Oe2qR09eabGCUrWMggLz9E58PvTR_4yeoK9hHVVA9-DJrKDmpwUF9LyMnpS9jx5QluGnqypPZoNWbt35TTZZfSkvJpsamfRz33rNEUT1HX3IL1fH2bzr-deV1FPmfYLMMgRWBsCbsiKyHOCjXoCy7i9ExuwykrBcm8bHLAaSVlYso_AvGB-RZYvWE5Twe16wRb6kzAbrv8ypj7ArGmqFctLeom0ajbhT20mOfXn4xF672h_MY32LJ-0DCz_YD9Ynk6z27vR_ein8XR6n6bJKBuwN5Zn09uMtqaTyV2S0if7HLD3Nubo9n46-fwffi0_Uw
```

```
