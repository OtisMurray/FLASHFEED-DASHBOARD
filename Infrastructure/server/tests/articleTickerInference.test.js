import test from 'node:test'
import assert from 'node:assert/strict'
import { inferArticleTickers, buildTickerAliasContext, companyAliases, buildAliasPhraseIndex, articleGainsInferredTicker } from '../routes/articles.js'

// "Matched only" is the News page default. It used to be answered in Mongo by
// requiring a raw ticker field, which ran before inferArticleTickers had a
// chance to recognise the company by name — so an approved newswire story that
// arrived with an empty ticker field was hidden even though the page would
// happily have shown a ticker for it. Production had 5,372 such articles in a
// three-day window.
//
// These cases are taken from real hidden articles.

const aliasContext = buildTickerAliasContext([
  { ticker: 'RBLX', company: 'Roblox Corporation', aliases: companyAliases('Roblox Corporation') },
  { ticker: 'CELC', company: 'Celcuity Inc.', aliases: companyAliases('Celcuity Inc.') },
  { ticker: 'COLD', company: 'Americold Realty Trust, Inc.', aliases: companyAliases('Americold Realty Trust, Inc.') },
])

test('a newswire headline with a company alias but no raw ticker resolves', () => {
  // Real production row: source Business Wire, ticker field "".
  const article = {
    title: 'RBLX Investors Have Opportunity to Join Roblox Corporation Fraud Investigation with SBS Law',
    ticker: '',
    source: 'Business Wire',
  }
  const out = inferArticleTickers(article, aliasContext)
  assert.ok(out.tickers.includes('RBLX'), `expected RBLX, got ${JSON.stringify(out)}`)
  assert.ok(out.tickers.length > 0, 'must surface under matched-only')
})

test('a second real hidden article resolves by alias', () => {
  const article = { title: 'CELC Investors Have Opportunity to Join Celcuity Inc. Fraud Investigation with SBS Law', ticker: '' }
  assert.ok(inferArticleTickers(article, aliasContext).tickers.includes('CELC'))
})

test('a multi-word company alias resolves from the headline', () => {
  const article = { title: 'COLD Investors Have Opportunity to Join Americold Realty Trust, Inc. Fraud Investigation', ticker: '' }
  assert.ok(inferArticleTickers(article, aliasContext).tickers.includes('COLD'))
})

test('an article with no company reference still yields nothing', () => {
  // Matched-only must stay meaningful: this one should remain hidden.
  const article = { title: 'Markets drift as traders await the jobs print', ticker: '' }
  const out = inferArticleTickers(article, aliasContext)
  assert.deepEqual(out.tickers, [])
  assert.equal(out.method, 'none')
})

test('an explicit cashtag wins outright', () => {
  const out = inferArticleTickers({ title: 'Why $RBLX ran today', ticker: '' }, aliasContext)
  assert.ok(out.tickers.includes('RBLX'))
  assert.equal(out.method, 'explicit_cashtag')
})

test('single-word company names never become aliases', () => {
  // The crude version of this idea matched "people" -> PPLI and "repay" -> RPAY
  // on unrelated stories. companyAliases requires at least two words, which is
  // what keeps matched-only from filling up with false positives.
  for (const name of ['People', 'Repay', 'Tron', 'Inno']) {
    assert.deepEqual(companyAliases(name), [], `${name} must not produce an alias`)
  }
})

test('an alias must match on word boundaries, not as a substring', () => {
  const ctx = buildTickerAliasContext([
    { ticker: 'INHD', company: 'Inno Holdings', aliases: companyAliases('Inno Holdings') },
  ])
  // "CSPC Innovation" contains "inno" but is a different company.
  const out = inferArticleTickers({ title: 'Weekly Recap: CSPC Innovation H1 profit', ticker: '' }, ctx)
  assert.deepEqual(out.tickers, [], 'substring match would be a false positive')
})

test('a numeric foreign listing in the raw field does not count as a ticker', () => {
  // Real row: TradingView News Flow, ticker "688235". Not a valid US symbol, so
  // matched-only should rely on inference rather than on that raw value.
  const out = inferArticleTickers({ title: 'BeOne Medicines AG reports results for the quarter', ticker: '688235' }, aliasContext)
  assert.ok(!out.tickers.includes('688235'), 'a numeric listing id is not a ticker')
})

// The bulk matched-only pass uses a phrase index instead of walking every alias
// per article, because the straightforward shape took 22.9s over a three-day
// window in production. It has to agree with inferArticleTickers, or a rescued
// row would surface with no ticker on it.

test('the phrase index agrees with the real matcher on the rescued cases', () => {
  const rows = [
    { ticker: 'RBLX', company: 'Roblox Corporation', aliases: companyAliases('Roblox Corporation') },
    { ticker: 'CELC', company: 'Celcuity Inc.', aliases: companyAliases('Celcuity Inc.') },
    { ticker: 'NVO', company: 'Novo Nordisk A/S', aliases: companyAliases('Novo Nordisk A/S') },
    { ticker: 'BAC', company: 'Bank of America Corporation', aliases: companyAliases('Bank of America Corporation') },
  ]
  const index = buildAliasPhraseIndex(rows)
  const ctx = buildTickerAliasContext(rows)
  const cases = [
    'RBLX Investors Have Opportunity to Join Roblox Corporation Fraud Investigation',
    'Novo Nordisk wins Dutch court injunction in semaglutide patent infringement case',
    'Bank of America spends $250 million a year on GLP-1 drugs for its employees',
    'Markets drift as traders await the jobs print',
    'CSPC Innovation H1 profit',
  ]
  for (const title of cases) {
    const article = { title, ticker: '' }
    assert.equal(
      articleGainsInferredTicker(article, index),
      inferArticleTickers(article, ctx).tickers.length > 0,
      `disagreement on: ${title}`
    )
  }
})

test('the phrase index still requires whole-word phrases', () => {
  const rows = [{ ticker: 'INHD', company: 'Inno Holdings', aliases: companyAliases('Inno Holdings') }]
  const index = buildAliasPhraseIndex(rows)
  assert.equal(articleGainsInferredTicker({ title: 'CSPC Innovation H1 profit' }, index), false)
  assert.equal(articleGainsInferredTicker({ title: 'Inno Holdings reports Q2' }, index), true)
})

test('the phrase index sees an explicit cashtag', () => {
  const index = buildAliasPhraseIndex([{ ticker: 'RBLX', company: 'Roblox Corporation', aliases: companyAliases('Roblox Corporation') }])
  assert.equal(articleGainsInferredTicker({ title: 'why $TSLA ran' }, index), true)
})
