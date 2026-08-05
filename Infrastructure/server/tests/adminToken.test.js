import test from 'node:test'
import assert from 'node:assert/strict'
import { requireAdminTokenOrSession } from '../routes/auth.js'

// /api/fetch and /api/prediction/snapshot are driven by scripts, which cannot
// hold a session cookie. .env.example documented an X-Admin-Token check and
// scripts/auto_refresh_loop.sh has been sending the header since the endpoint
// was written, but the server never read it — the documented protection did not
// exist. These pin the behaviour so it cannot quietly stop existing again.

function fakeReq(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name) => lower[String(name).toLowerCase()], cookies: {} }
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (payload) => { res.body = payload; return res }
  return res
}

function run(headers, env) {
  const previous = process.env.ADMIN_TOKEN
  if (env === undefined) delete process.env.ADMIN_TOKEN
  else process.env.ADMIN_TOKEN = env
  const res = fakeRes()
  let passed = false
  try {
    requireAdminTokenOrSession(fakeReq(headers), res, () => { passed = true })
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TOKEN
    else process.env.ADMIN_TOKEN = previous
  }
  return { passed, status: res.statusCode, body: res.body }
}

const TOKEN = 'e3f1c9a2b7d84e6f90a1c2b3d4e5f60718293a4b5c6d7e8f'

test('the correct token in X-Admin-Token is accepted', () => {
  const r = run({ 'X-Admin-Token': TOKEN }, TOKEN)
  assert.equal(r.passed, true)
})

test('the correct token as Authorization: Bearer is accepted', () => {
  const r = run({ Authorization: `Bearer ${TOKEN}` }, TOKEN)
  assert.equal(r.passed, true)
})

test('Bearer matching is case-insensitive on the scheme', () => {
  assert.equal(run({ Authorization: `bearer ${TOKEN}` }, TOKEN).passed, true)
  assert.equal(run({ Authorization: `BEARER ${TOKEN}` }, TOKEN).passed, true)
})

test('a wrong token is rejected with 401', () => {
  const r = run({ 'X-Admin-Token': 'not-the-token' }, TOKEN)
  assert.equal(r.passed, false)
  assert.equal(r.status, 401)
})

test('a token that is a prefix of the real one is rejected', () => {
  const r = run({ 'X-Admin-Token': TOKEN.slice(0, -1) }, TOKEN)
  assert.equal(r.passed, false)
  assert.equal(r.status, 401)
})

test('FAIL CLOSED: a token presented while ADMIN_TOKEN is unset is refused', () => {
  // The point of the whole change. Before it, this request was served.
  const r = run({ 'X-Admin-Token': TOKEN }, undefined)
  assert.equal(r.passed, false)
  assert.equal(r.status, 503)
})

test('FAIL CLOSED: an empty ADMIN_TOKEN is not a usable secret', () => {
  const r = run({ 'X-Admin-Token': TOKEN }, '')
  assert.equal(r.passed, false)
  assert.equal(r.status, 503)
})

test('an empty presented token does not authenticate as a token', () => {
  // Falls through to the session check, which has no cookie here, so 401.
  const r = run({ 'X-Admin-Token': '' }, TOKEN)
  assert.equal(r.passed, false)
  assert.equal(r.status, 401)
})

test('no credentials at all falls through to the session check and is refused', () => {
  const r = run({}, TOKEN)
  assert.equal(r.passed, false)
  assert.equal(r.status, 401)
})

test('a non-bearer Authorization scheme is not treated as a token', () => {
  const r = run({ Authorization: `Basic ${TOKEN}` }, TOKEN)
  assert.equal(r.passed, false)
  assert.equal(r.status, 401)
})

test('X-Admin-Token wins over Authorization when both are present', () => {
  assert.equal(run({ 'X-Admin-Token': TOKEN, Authorization: 'Bearer wrong' }, TOKEN).passed, true)
  assert.equal(run({ 'X-Admin-Token': 'wrong', Authorization: `Bearer ${TOKEN}` }, TOKEN).passed, false)
})

test('surrounding whitespace on the header is tolerated', () => {
  assert.equal(run({ 'X-Admin-Token': `  ${TOKEN}  ` }, TOKEN).passed, true)
})
