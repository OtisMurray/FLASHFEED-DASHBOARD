# Planned Alert System

## Market Sessions

- Premarket: 4:00 AM to 9:30 AM Eastern
- Regular market: 9:30 AM to 4:00 PM Eastern
- Postmarket: 4:00 PM to 8:00 PM Eastern

## Rising Stars Screener

The screener should rank the best stocks to buy or watch separately for each
market session. Rankings should combine:

- News velocity and freshness
- News sentiment and event strength
- Social sentiment, message density, and recent trend
- Price momentum, relative volume, and spread/liquidity filters

## Alert Behavior

- Alerts should fire when a ticker becomes a rising star inside the active
  session.
- Alerts should explain whether the signal came mainly from news, social
  sentiment, or both.
- Alerts should dedupe repeated triggers for the same ticker/session unless the
  score materially improves.
- The backend scheduler, not the browser tab, should run alert evaluation so
  alerts continue while the user is away.
