# Figma Make Prompt: Stock Sentiment Dashboard

Design a real-time stock sentiment dashboard. This is a Next.js 14 App Router + TypeScript + shadcn/ui + Tailwind CSS application. It displays sentiment data computed from Reddit and Bluesky posts about stocks. Dark theme (financial dashboard style). The design reference is Finviz.com's screener. Use shadcn/ui components exclusively -- no custom component libraries. Responsive: desktop-first but must work on tablet. Dense layout -- maximize data density like Finviz, minimize whitespace. All numbers should be formatted: sentiment to 2 decimal places, large numbers abbreviated (1.2K, 3.4M). Color-code sentiment everywhere it appears: green (>0.2), red (<-0.2), gray (neutral).

---

## Design Tokens / Color System

| Token | Value | Usage |
|-------|-------|-------|
| Background | `slate-950` (#020617) | Dark mode primary background |
| Cards | `slate-900` (#0f172a) | Card and panel surfaces |
| Borders | `slate-800` (#1e293b) | Dividers, table borders |
| Bullish / Positive | `emerald-500` (#10b981) | Sentiment > 0.2, buy signals |
| Bearish / Negative | `red-500` (#ef4444) | Sentiment < -0.2, sell signals |
| Neutral | `slate-400` (#94a3b8) | Sentiment between -0.2 and 0.2 |
| Accent | `blue-500` (#3b82f6) | Interactive elements, links, focus rings |
| Text Primary | `slate-50` (#f8fafc) | Headings, primary data |
| Text Secondary | `slate-400` (#94a3b8) | Labels, secondary info |
| Font | Inter or system font stack | Standard shadcn default |

---

## Navigation

Compact sidebar or top nav with three items: **Screener**, **Settings**, **About**. Most screen space goes to the data table. Use the shadcn Sidebar component or a simple top nav with Tabs. Active item highlighted with the `blue-500` accent. Collapsed sidebar on smaller screens.

---

## Page 1: Screener Table

**Route:** `/`

This is the hero of the app -- a Finviz-inspired dense data table showing every active ticker with both traditional financial metrics (from Finviz CSV data) and real-time social sentiment metrics (from Reddit + Bluesky).

### Top Bar

- **Search input** (shadcn `Input`): Filter tickers by symbol. Placeholder: "Search ticker..."
- **Time window selector** (shadcn `Select`): Dropdown with options: 1m, 3m, 5m, 10m, 15m, 30m, 60m. Default: 60m. This controls which rolling window the sentiment data comes from.
- **Sort controls**: Clickable column headers to sort ascending/descending. Show a small arrow indicator on the active sort column.
- **Active ticker count**: Small text like "Showing 142 tickers" on the right side of the top bar.

### Table Columns (in order, left to right)

| # | Column | Source | Format | Notes |
|---|--------|--------|--------|-------|
| 1 | **Ticker** | Finviz | Bold, left-aligned, monospace-style | Clickable -- navigates to `/ticker/[symbol]` |
| 2 | **Price** | Finviz | Dollar amount, 2 decimals (`$178.50`) | |
| 3 | **Market Cap** | Finviz | Abbreviated (`2.4T`, `150B`, `3.2M`) | Right-aligned |
| 4 | **P/E Ratio** | Finviz | Number, 1 decimal (`52.3`) | Show "-" if unavailable |
| 5 | **Analyst Rating** | Finviz | Normalized -1.0 to +1.0 | Show as colored badge: emerald for buy (>0.2), red for sell (<-0.2), slate for hold. Text inside badge: "Buy", "Hold", "Sell" |
| 6 | **Sentiment Score** | Rolling window | -1.0 to +1.0, 2 decimals | Color-coded horizontal bar or pill. Green fill for positive, red for negative, gray for neutral. The bar width represents magnitude. |
| 7 | **Message Count** | Rolling window | Integer (`150`) | Right-aligned. Number of posts mentioning this ticker in the selected time window. |
| 8 | **Bull/Bear Ratio** | Rolling window | Small stacked horizontal bar | Green portion = bullish%, red = bearish%, gray = neutral%. Show percentages on hover via Tooltip. |
| 9 | **Trend Spark** | Rolling window | Tiny inline sparkline | Optional/nice-to-have. Shows sentiment trajectory over the last few hours. Thin line, no axes. Green if trending up, red if trending down. |

### Table Behavior

- Each row is clickable -- navigates to the ticker detail page at `/ticker/[symbol]`.
- Rows have subtle hover state (`slate-800` background).
- Dense row height -- similar to Finviz's tight spacing. No excessive padding.
- Auto-refreshes every 60 seconds. Show a subtle "Last updated: 2 min ago" indicator in the top bar or footer.
- Default sort: by Message Count descending (most discussed tickers first).

### Footer

- Subtle text: "Data from Reddit (24 subreddits) + Bluesky. Updated every 60s."
- "Powered by Reddit + Bluesky" in `slate-600` text.

### shadcn Components Used

`DataTable`, `Input`, `Select`, `Badge`, `Tooltip`, `Button` (for pagination if needed)

---

## Page 2: Ticker Detail

**Route:** `/ticker/[symbol]`

Detailed view for a single ticker showing historical sentiment trends, message volume, and recent posts.

### Header Section

- **Back button** or breadcrumb: "Screener / TSLA" to return to the main table.
- **Ticker symbol**: Large heading (text-3xl or text-4xl), bold, `slate-50`.
- **Current price**: Next to ticker, slightly smaller, `slate-300`.
- **Sentiment score badge**: Same colored badge style as the screener table. Large size.
- **Message count**: "150 posts in last 60 min" as secondary text.

### Charts Section

Two charts side by side on desktop, stacked on tablet/mobile. Use Recharts (standard for Next.js).

#### Chart 1: Sentiment Over Time (left)

- **Type**: Line chart
- **Y-axis**: -1.0 to +1.0 (sentiment score)
- **X-axis**: Time (labels formatted as "1:00 PM", "2:00 PM", etc.)
- **Line color**: `emerald-500` (#10b981)
- **Zero line**: Dashed gray line at y=0 (`slate-600`)
- **Fill**: Subtle gradient fill below the line (green above zero, red below zero)
- **Background**: `slate-900` card

#### Chart 2: Message Density Over Time (right)

- **Type**: Bar chart
- **Y-axis**: Message count (integer)
- **X-axis**: Time (same scale as sentiment chart)
- **Bar color**: `blue-500` (#3b82f6)
- **Background**: `slate-900` card

#### Time Range Tabs

Above the charts, a tab group (shadcn `Tabs`): **1hr**, **6hr**, **24hr**. Default: 24hr. Switching tabs adjusts the x-axis range and re-queries data.

### Sentiment Breakdown Card

Below the charts or in a sidebar column. Shows the composition of sentiment for the current window.

- **Option A -- Donut chart**: Green (bullish), red (bearish), gray (neutral) segments. Center shows total post count.
- **Option B -- Three stat cards**: Side by side. Each card shows the count and percentage.
  - Bullish: emerald icon, count, percentage
  - Bearish: red icon, count, percentage
  - Neutral: slate icon, count, percentage

### Recent Posts Table

Below the charts. Shows the actual posts that contributed to this ticker's sentiment.

| Column | Format |
|--------|--------|
| Title | Post title text, truncated to 1 line with ellipsis |
| Source | Badge: "Reddit" (orange-500) or "Bluesky" (blue-400) |
| Sentiment | Colored score badge (-1.0 to +1.0) |
| Time | Relative timestamp ("5 min ago", "2 hr ago") |

- Show the 20 most recent posts.
- Each row links to the original post URL.

### shadcn Components Used

`Card`, `Tabs`, `Table`, `Badge`, `Button` (back), `Separator`

---

## Page 3: Config Panel

**Route:** `/settings` (or accessible as a slide-over drawer from the nav)

Simple settings page. Settings are stored in `localStorage` -- no backend persistence needed.

### Section 1: Data Sources

**Heading:** "Data Sources"

Toggle switches (shadcn `Switch` + `Label`) for subreddit groups:

| Toggle | Subreddits Included |
|--------|-------------------|
| WSB Variants | wallstreetbets, wallstreetbets2, wallstreetbets_wins, wallstreetbetsELITE, wallstreetbetsnew, wallstreetelite, wallstreetsmallcap |
| Small/Penny Stocks | smallstreetbets, pennystocks, pennystock, 10xpennystocks, wallstreetsmallcap |
| General Trading | stockmarket, stocks, stocks_picks, stocksandtrading, stockstobuytoday, stocktradingalerts, swingtrading, trading |
| Squeeze/Momentum | trakstocks, shortsqueeze, stockaday, options, thewallstreet |
| Bluesky | Toggle for Bluesky cashtag search data |

All toggles default to ON.

### Section 2: Time Window

**Heading:** "Default Time Window"

Dropdown (shadcn `Select`) to select the default rolling window size displayed on the screener.

Options: 1 min, 3 min, 5 min, 10 min, 15 min, 30 min, 60 min. Default: 60 min.

### Section 3: Refresh Rate

**Heading:** "Auto-Refresh Interval"

Slider (shadcn `Slider`) with labeled tick marks.

Options: 15s, 30s, 60s, 120s. Default: 60s. Show the current value as a label next to the slider.

### Section 4: Display

**Heading:** "Display Preferences"

- **Dark/Light mode** toggle (shadcn `Switch`). Default: dark.
- **Show sparklines** toggle (shadcn `Switch`). Default: on. Controls whether the Trend Spark column appears in the screener table.

### Layout

Each section in its own shadcn `Card` with a heading. Sections stacked vertically. Max-width container (~600px) centered on the page.

### shadcn Components Used

`Switch`, `Select`, `Slider`, `Card`, `Label`, `Separator`

---

## Data Shape Reference

These are the actual data structures the dashboard consumes. Use these to populate realistic mock data in the design.

### Screener Row (from Redis + Finviz MongoDB)

```json
{
  "ticker": "TSLA",
  "avg_sentiment": 0.42,
  "message_count": 150,
  "bullish_count": 80,
  "bearish_count": 30,
  "neutral_count": 40,
  "window_minutes": 60,
  "price": 178.50,
  "market_cap": "567B",
  "pe_ratio": 52.3,
  "analyst_recom": 0.4
}
```

Fields breakdown:
- `ticker`: Stock symbol (string, uppercase)
- `avg_sentiment`: Average sentiment score for the window (-1.0 to +1.0, float)
- `message_count`: Total posts mentioning this ticker in the window (integer)
- `bullish_count`: Posts scored above +0.15 (integer)
- `bearish_count`: Posts scored below -0.15 (integer)
- `neutral_count`: Posts scored between -0.15 and +0.15 (integer)
- `window_minutes`: Rolling window size in minutes (1, 3, 5, 10, 15, 30, or 60)
- `price`: Current stock price from Finviz (float, dollars)
- `market_cap`: Market capitalization from Finviz (string, abbreviated)
- `pe_ratio`: Price-to-earnings ratio from Finviz (float)
- `analyst_recom`: Analyst recommendation normalized to -1.0 (sell) to +1.0 (buy)

### Ticker History Point (from PostgreSQL window_history)

```json
{
  "ticker": "TSLA",
  "window_minutes": 60,
  "avg_sentiment": 0.42,
  "message_count": 150,
  "bullish_count": 80,
  "bearish_count": 30,
  "neutral_count": 40,
  "window_start": "2026-03-27T12:00:00Z",
  "window_end": "2026-03-27T13:00:00Z",
  "computed_at": "2026-03-27T13:00:00Z"
}
```

This is one row from the `window_history` PostgreSQL table. The ticker detail charts plot an array of these objects over time to show sentiment and message density trends.

### Redis Key Structure

- `window:{ticker}:{window_minutes}` -- Hash containing the latest rolling window data for a ticker/window pair.
- `active_tickers` -- Sorted set of tickers ranked by 60-minute message count (descending). Used to populate the screener table.
- `pipeline:last_sync` -- ISO timestamp of the last pipeline run. Used for the "Last updated" indicator.

### Post Schema (for Recent Posts table on ticker detail)

```json
{
  "id": "abc123",
  "source": "reddit",
  "subreddit": "wallstreetbets",
  "author": "diamond_hands_42",
  "title": "TSLA to the moon after earnings beat",
  "text": "Just loaded up on more calls...",
  "url": "https://old.reddit.com/r/wallstreetbets/comments/abc123",
  "score": 245,
  "num_comments": 89,
  "published_at": "2026-03-27T12:34:56Z",
  "detected_at": "2026-03-27T12:35:02Z",
  "tickers_mentioned": ["TSLA"],
  "sentiment_score": 0.72,
  "is_duplicate": false,
  "is_spam": false
}
```

---

## Sample Mock Data for the Screener

Use these rows to populate a realistic-looking table in the design:

| Ticker | Price | Mkt Cap | P/E | Analyst | Sentiment | Messages | Bull | Bear | Neutral |
|--------|-------|---------|-----|---------|-----------|----------|------|------|---------|
| TSLA | $178.50 | 567B | 52.3 | +0.40 (Buy) | +0.42 | 150 | 80 | 30 | 40 |
| NVDA | $924.80 | 2.3T | 68.1 | +0.80 (Buy) | +0.65 | 203 | 140 | 22 | 41 |
| GME | $27.40 | 7.6B | - | -0.30 (Sell) | +0.28 | 312 | 180 | 72 | 60 |
| AMC | $4.85 | 1.4B | - | -0.60 (Sell) | -0.15 | 189 | 65 | 80 | 44 |
| AAPL | $192.30 | 2.9T | 29.8 | +0.70 (Buy) | +0.18 | 87 | 42 | 18 | 27 |
| PLTR | $24.60 | 54B | 88.4 | +0.10 (Hold) | +0.55 | 145 | 95 | 20 | 30 |
| SPY | $524.10 | - | - | - | +0.08 | 64 | 28 | 22 | 14 |
| SOFI | $8.92 | 8.4B | - | -0.10 (Hold) | -0.32 | 98 | 25 | 55 | 18 |
| AMD | $178.20 | 288B | 45.6 | +0.50 (Buy) | +0.38 | 76 | 48 | 12 | 16 |
| COIN | $225.40 | 54B | 35.2 | +0.20 (Buy) | -0.45 | 112 | 30 | 65 | 17 |

---

## Important Design Constraints

1. **Use shadcn/ui components exclusively** -- no custom component libraries.
2. **Responsive**: Desktop-first but must work on tablet (min-width ~768px).
3. **Dense layout** -- maximize data density like Finviz. Minimize whitespace. Tight row heights, compact padding.
4. **All numbers formatted**: Sentiment to 2 decimal places. Large numbers abbreviated (1.2K, 3.4M, 150B, 2.3T). Prices with dollar sign and 2 decimals.
5. **Color-code sentiment everywhere** it appears: emerald-500 for positive (>0.2), red-500 for negative (<-0.2), slate-400 for neutral.
6. **Chart library**: Recharts (standard for Next.js/React).
7. **Dark theme by default**. Light mode is a toggle in settings but dark is the primary design.
8. **No authentication** -- this is a read-only public dashboard.
9. **Auto-refresh indicator** -- always show when data was last updated.
10. **Financial dashboard aesthetic** -- think Bloomberg terminal meets Finviz, not a consumer SaaS app.
