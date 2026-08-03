import User from './models/User.js'
import { sendStockAlertSms, smsReady } from './smsSender.js'

// Self-contained SMS stock-alert checker — reads articles the existing news
// pipeline already wrote (does not modify or hook into that pipeline at all),
// and texts any user who opted into alerts for that ticker. A small
// sms_alerts_sent collection tracks (userId, articleId) pairs already sent so
// a re-run (or the next tick) never double-texts the same article.
const CHECK_WINDOW_MINUTES = Number(process.env.SMS_ALERT_CHECK_WINDOW_MINUTES || 10)
const MAX_ALERTS_PER_TICK = Number(process.env.SMS_ALERT_MAX_PER_TICK || 25)

export async function runSmsAlertCheck(db) {
  if (!smsReady() || !db) return { sent: 0, skipped: 'sms_not_configured_or_no_db' }

  const subscribers = await User.find({ smsAlertsOptIn: true, phone: { $ne: null }, 'smsAlertTickers.0': { $exists: true } })
  if (!subscribers.length) return { sent: 0, skipped: 'no_subscribers' }

  const tickerToUsers = new Map()
  for (const u of subscribers) {
    for (const t of u.smsAlertTickers) {
      if (!tickerToUsers.has(t)) tickerToUsers.set(t, [])
      tickerToUsers.get(t).push(u)
    }
  }
  const watchedTickers = Array.from(tickerToUsers.keys())
  if (!watchedTickers.length) return { sent: 0, skipped: 'no_tickers' }

  const sinceSec = Math.floor(Date.now() / 1000) - CHECK_WINDOW_MINUTES * 60
  // Two separate $or clauses (ticker match, recency) combined under $and —
  // Mongo query objects can't have two top-level "$or" keys, so they can't
  // just sit side by side.
  const recentArticles = await db.collection('articles').find({
    $and: [
      { $or: [{ ticker: { $in: watchedTickers } }, { tickers: { $in: watchedTickers } }] },
      { $or: [
        { publish_date: { $type: 'number', $gte: sinceSec } },
        { publish_date: { $type: 'date', $gte: new Date(sinceSec * 1000) } },
        { fetched_date: { $type: 'number', $gte: sinceSec } },
        { fetched_date: { $type: 'date', $gte: new Date(sinceSec * 1000) } },
      ] },
    ],
  }, { projection: { ticker: 1, tickers: 1, title: 1, sentiment: 1 } }).limit(200).toArray()

  let sent = 0
  for (const article of recentArticles) {
    if (sent >= MAX_ALERTS_PER_TICK) break
    const articleTickers = new Set([article.ticker, ...(article.tickers || [])].filter(Boolean))
    for (const ticker of articleTickers) {
      const users = tickerToUsers.get(String(ticker).toUpperCase())
      if (!users) continue
      for (const user of users) {
        if (sent >= MAX_ALERTS_PER_TICK) break
        const already = await db.collection('sms_alerts_sent').findOne({ userId: user._id, articleId: article._id })
        if (already) continue
        try {
          const headline = String(article.title || '').slice(0, 100)
          const tone = article.sentiment ? ` (${article.sentiment})` : ''
          await sendStockAlertSms(user.phone, ticker, `${headline}${tone}`)
          await db.collection('sms_alerts_sent').insertOne({ userId: user._id, articleId: article._id, ticker, sentAt: new Date() })
          sent += 1
        } catch (err) {
          console.error(`SMS alert failed for user ${user._id} / ${ticker}:`, err.message)
        }
      }
    }
  }
  return { sent, checked: recentArticles.length }
}
