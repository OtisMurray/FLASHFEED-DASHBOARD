import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ROOT } from './config.ts'

// ─── Ticker → Company name map (from finviz.csv) ──────────────────────────────
export const TICKER_COMPANY = new Map<string, string>()
export const FINVIZ_DATA = new Map<string, { sector?: string; industry?: string; price?: number; change_pct?: number; volume?: number }>()

// Common English words that are also ticker symbols — filter these out
export const TICKER_BLACKLIST = new Set([
  'A','I','AM','AN','ARE','AS','AT','BE','BY','DO','FOR','GO','HAS','HE','HER','HIS',
  'HOW','IF','IN','IS','IT','ITS','MAY','ME','MY','NEW','NO','NOT','NOW','OF','OLD',
  'ON','ONE','OR','OUR','OUT','OWN','SAY','SHE','SO','THE','TO','TOP','TWO','UP','US',
  'WAS','WAY','WE','WHO','WHY','ALL','ANY','BIG','CAN','DAY','DID','GET','GOT','HAD',
  'HAS','HIM','HOT','KEY','LET','LOW','MAN','MEN','NET','OFF','OIL','PAY','PUT','RAN',
  'RUN','SAW','SET','SIT','SIX','TEN','THE','TOO','USE','VIA','WAR','WON','YET',
  'BEST','CALL','COME','DATA','EACH','ELSE','EVER','FAST','FIND','FIVE','FREE','FULL',
  'FUND','GAVE','GOOD','HALF','HARD','HERE','HIGH','HOME','HOPE','HUGE','IDEA','INTO',
  'JUST','KEEP','KNOW','LAST','LATE','LEAD','LEFT','LESS','LIFE','LINE','LIST','LIVE',
  'LONG','LOOK','LOST','LOTS','MADE','MAIN','MAKE','MANY','MARK','MIND','MINE','MISS',
  'MORE','MOST','MUCH','MUST','NAME','NEAR','NEED','NEXT','NINE','NOTE','ONLY','OPEN',
  'OVER','PART','PAST','PLAN','PLAY','POST','PUSH','RATE','READ','REAL','REST','RIDE',
  'RISE','RISK','ROAD','ROLE','RULE','SAFE','SAID','SALE','SAME','SAVE','SEEN','SELF',
  'SEND','SHOW','SHUT','SIDE','SIGN','SIZE','SOME','SOON','STEP','STOP','SUCH','SURE',
  'TAKE','TALK','TEAM','TELL','TERM','TEST','TEXT','THAN','THAT','THEM','THEN','THEY',
  'THIS','THUS','TIME','TOLD','TOOK','TURN','TYPE','UPON','USED','VERY','VIEW','VOTE',
  'WAIT','WALK','WALL','WANT','WARM','WAVE','WEEK','WELL','WENT','WERE','WEST','WHAT',
  'WHEN','WIDE','WILL','WISH','WITH','WORD','WORK','YEAR','YOUR','ZERO',
  'FOR','CEO','CFO',
])

// Loader IIFE
;(() => {
  const csv = join(ROOT, 'social_pipeline', 'finviz.csv')
  if (!existsSync(csv)) return
  const lines = readFileSync(csv, 'utf8').split('\n')
  const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim())
  const ti = header.indexOf('Ticker')
  const ci = header.indexOf('Company')
  const si = header.indexOf('Sector')
  const ii = header.indexOf('Industry')
  const pi = header.indexOf('Price')
  const cpi = header.indexOf('Change')
  const vi = header.indexOf('Volume')
  if (ti < 0 || ci < 0) return
  for (let i = 1; i < lines.length; i++) {
    // Basic CSV split, ignores commas inside quotes for simplicity but works for this file
    const cols = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g)
    if (!cols) continue
    const ticker = cols[ti]?.replace(/"/g, '').trim()
    const company = cols[ci]?.replace(/"/g, '').trim()
    const sector = si >= 0 ? cols[si]?.replace(/"/g, '').trim() : undefined
    const ind = ii >= 0 ? cols[ii]?.replace(/"/g, '').trim() : undefined

    const priceStr = pi >= 0 ? cols[pi]?.replace(/"/g, '').trim() : ''
    const changeStr = cpi >= 0 ? cols[cpi]?.replace(/"/g, '').trim().replace('%', '') : ''
    const volStr = vi >= 0 ? cols[vi]?.replace(/"/g, '').trim() : ''

    const price = priceStr ? parseFloat(priceStr) : undefined
    const change_pct = changeStr ? parseFloat(changeStr) : undefined
    const volume = volStr ? parseInt(volStr.replace(/,/g, '')) : undefined

    if (ticker && company) {
      TICKER_COMPANY.set(ticker, company)
      FINVIZ_DATA.set(ticker, { sector, industry: ind, price, change_pct, volume })
    }
  }
  console.log(`[INFO] Loaded ${TICKER_COMPANY.size} ticker mappings & finviz data`)
})()
