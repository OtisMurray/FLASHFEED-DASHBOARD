# Dashboard Improvement Plan and Project Reflection

## Page 1 - Technical Gap Analysis and Near-Term Work

The professor's notes describe a fast market intelligence dashboard, not just a
news feed. The target system should detect market-moving information as close to
real time as possible, rank it with AI, connect it to numeric screeners and chart
signals, and support broker execution workflows. The current FeedFlash dashboard
already has important foundations: MongoDB storage, Redis/Kafka infrastructure,
news ingestion, social ingestion, keyword filtering, sentiment scoring, Finviz
and TradingView-style screener work, chart endpoints, and the teammate's
completed chart views wired into the Charts page. The immediate improvement goal
is to stabilize and present these working pieces as one coherent dashboard before
building every advanced feature.

The first priority is source coverage. The professor specifically listed broker
news, platform news, structured newswires, SEC/FDA sources, and social channels.
The current code already includes several of these categories, including RSS
news, Benzinga-style ingestion, Interactive Brokers-related scraping, Finviz and
TradingView screeners, Stocktwits, Reddit, Bluesky, and placeholders for X. What
still needs work is source validation, credential setup, and source-health
reporting. Each source should show whether it is live, credential-blocked,
disabled because of endpoint quality, or still planned. This keeps the project
honest and prevents demo confusion.

The second priority is speed. The professor emphasized that real-time
performance is the main objective and that the system should avoid unnecessary
disk I/O. The current architecture already points in the right direction with
Redis, Kafka, and MongoDB. Work we can accomplish now includes keeping hot feed
state in Redis, adding MongoDB indexes for article time, detected time, ticker,
source, and sentiment fields, and making the dashboard poll only the small
payloads it needs. The longer-term step is to move more collectors into
producer-consumer jobs so news, social messages, screener rows, and AI scores can
flow through memory-first queues before resting in MongoDB.

The third priority is ranking. The professor wants keyword dictionary selection,
AI rankings, numeric screeners, and a combined AI numeric ranking with sorting,
thresholding, and correlation. Near term, we can expose a clear ranking formula:
news sentiment score, social sentiment score, social message density, screener
momentum, market cap/volume filters, and freshness. That lets the dashboard sort
tickers by urgency instead of showing separate disconnected panels. Later, the
formula can become a learning agent that updates weights based on post-news
returns and failed signals.

The fourth priority is chart integration. The teammate's completed charts should
be the chart source of truth. The Charts page now uses the teammate-style chart
experience: candlesticks, Bollinger bands, RSI, MACD, price+density research
charts, sentiment-score charts, density-vs-sentiment charts, and a charts grid
that mirrors the screener universe. The work to do now is visual QA, confirm the
chart APIs return the correct payloads under live data, and avoid introducing
parallel chart systems that confuse the demo. Any future chart change should
extend this chart layer instead of replacing it.

## Page 2 - Roadmap, What We Can Accomplish Now, and Team Reflection

Work we can accomplish now is practical and demo-focused. First, stabilize the
Charts page and confirm it compiles. Second, add source-status panels so the
dashboard shows which broker, newswire, platform, and social feeds are working.
Third, tighten sorting around detected time, published time, sentiment score, and
social density. Fourth, expose keyword dictionary controls in Settings so the
professor can see how dictionary-based filtering works. Fifth, add alerts for
short-squeeze candidates, sudden social-message density, unusual sentiment, and
fresh structured news. Sixth, document which features are live, which require
credentials, and which are future research.

Medium-term work should cover the larger professor list: Interactive Brokers and
TD Ameritrade/Schwab news, broker trading and bracket orders, Dow Jones/PR
Newswire/Business Wire/ACCESS Newswire validation, SEC and FDA feeds, Google
Trends, options, futures, arbitrage, long-term scans, short-squeeze scoring, CVD
from high-resolution signals, and an AI agent that learns from outcomes. These
features are possible, but they should not be presented as complete until data
quality, credentials, latency, and compliance are handled. A strong project demo
is better when it clearly separates working features from planned integrations.

Punctuality matters for both projects because this dashboard depends on timing in
two ways. The product itself is about catching market-moving information quickly,
and the team process also depends on delivering working pieces on schedule. A
late feed, a delayed chart, or an unfinished integration can change the meaning
of the whole demo. For the team, punctuality means setting small deadlines,
testing before presentation day, and committing stable code early enough for
others to integrate it.

Self-reliance is also central. The project touches APIs, databases, scraping,
frontend charts, AI scoring, and deployment, so every teammate has to be able to
debug their own piece without waiting for someone else to rescue it. In practice,
self-reliance means reading errors, checking logs, validating data in MongoDB,
running builds, and proving a source works before claiming it. It does not mean
working alone; it means bringing a working or clearly diagnosed piece back to the
team.

Self-learning is what makes the project realistic. Many of the professor's
requested integrations are not simple classroom examples. Broker APIs, Reddit,
Stocktwits, Bluesky, X, SEC feeds, Finviz, TradingView, Redis, Kafka, MongoDB,
and charting libraries all have their own constraints. The team has to learn
from documentation, failed requests, rate limits, data gaps, and real market
behavior. The dashboard should reflect that learning by becoming more modular:
new sources should plug into the same schema, new ranking models should be
measurable, and new chart signals should connect back to observable outcomes.

The best next-stage version is a self-contained dashboard that proves the core
idea: fast source collection, RAM-first processing, MongoDB storage, sentiment
and numeric ranking, teammate-built charts, screener mirroring, social-density
signals, and alerts. From there, the advanced broker trading, options, futures,
arbitrage, long-term scan, and AI-agent features can be added without rebuilding
the platform from scratch.
