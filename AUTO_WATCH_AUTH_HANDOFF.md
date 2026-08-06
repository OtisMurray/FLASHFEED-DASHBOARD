# Post-demo: gate `/api/watch` and the Auto control together

**Status:** deferred, deliberately. Do not ship before the demo.
**Raised:** 2026-08-06, from an investigation into a reported Positions outage.
**Blast radius:** one frontend component. No scripts, no cron, no machine callers.

---

## Why this is deferred rather than done

There is no outage and no live exposure worth the risk of a pre-demo change.

`/api/watch` (`Infrastructure/server/index.js:9415`) is an unauthenticated SSE
endpoint that runs `runDataRefreshCycle(...)` on connect and then every 60s. That
sounds worse than it is: production already runs the same cycle every 60s with no
client attached. Sampled 2026-08-06:

```json
"onsite_fetch": { "enabled": true, "interval_minutes": 1 },
"away_fetch":   { "enabled": true, "interval_minutes": 1 },
"refresh_cycle_in_flight": true
```

`refreshCycleInFlight` caps concurrency at one, so extra connections de-duplicate
rather than multiply. An anonymous caller triggers what the server already does on
its own schedule. Marginal load and marginal Finviz Elite quota consumption are
close to zero.

What the stream exposes is ingestion counts, the top-10 momentum ticker symbols,
and cycle timings. No credentials, no user data, no position data.

So this is hygiene, not an incident. It is worth fixing, and worth fixing
*correctly* rather than quickly.

## The trap: why the API guard cannot ship alone

The obvious one-line fix — add `requireAdminTokenOrSession` to `/api/watch`,
matching `/api/fetch` four lines above at `index.js:9373-9374` — **breaks the Auto
toggle for every anonymous and non-admin visitor**, silently.

Two facts combine:

1. `requireAdminTokenOrSession` (`Infrastructure/server/routes/auth.js:303`) is
   **cookie-first, header-optional**. With no `X-Admin-Token` / `Authorization`
   header it delegates to `requireAdmin` → `requireAuth`, which reads the
   `ff_session` cookie and then requires `role === 'admin'`. Verified against the
   already-guarded `/api/fetch`:

   ```
   no header, no cookie  → HTTP 401  {"error":"Not logged in."}                  (cookie path)
   bogus X-Admin-Token   → HTTP 503  {"error":"Admin token ... not configured"}  (token path)
   ```

2. The Auto control is **not** admin-gated in the UI. In
   `app/src/components/shared/TopBar.tsx`, `user` is referenced only at line 696
   (the login/logout menu); the Controls dropdown holding the Auto toggle renders
   unconditionally. Confirmed against production anonymously — the nav renders
   `Controls · Auto · ⚙ · Log In`.

`EventSource` surfaces only a generic `onerror`, so the failure presents as
"Auto-watch connection lost" with no cause. It is also invisible in local testing
if you are signed in as admin.

**Therefore: the UI gate and the API gate must land in the same commit.** Not
sequentially. API-first opens a window where the control is visible but
non-functional for logged-out users; UI-first leaves the endpoint open. One change.

## Not needed: any token scheme

`EventSource` **can** carry cookies. Verified 2026-08-06 with a planted
`httpOnly`, `SameSite=Lax` cookie, inspecting the real outgoing request headers:

```
SSE request URL   : http://localhost:3001/api/watch?interval=30&mode=rss
Cookie header sent: probe_session=probe-value-12345
Accept header     : text/event-stream
>>> COOKIE CARRIED BY EventSource: YES
```

The session cookie (`routes/auth.js:41-44`) is `httpOnly`, `sameSite: 'lax'`,
`secure` in production, and the stream is same-origin, so it rides along
automatically. The genuine `EventSource` limitation is **custom headers only** —
you cannot set `Authorization`; the constructor silently ignores a `headers`
option.

Do **not** introduce a short-lived URL token for this. It would solve a
non-problem, and a token in a query string lands in Railway access logs, any
fronting proxy, and browser history regardless of its expiry.

---

## The change

### 1. Gate the Auto control in the UI

`app/src/components/shared/TopBar.tsx` — wrap the Auto toggle in `AdminOnly` from
`app/src/components/shared/RouteGuards.tsx`.

Use `AdminOnly` rather than a hand-rolled `user?.role === 'admin'`. It is the
repo's existing primitive for exactly this situation — its own doc comment reads
"For controls sitting inside a page anyone can open" — and it wraps
`isAdmin` (which *is* `user?.role === 'admin'`, see `lib/useAuth.tsx:46`) plus the
`loading` case, so the control never appears and then vanishes once
`/api/auth/me` resolves. A raw role check would flash it on every page load.

Gate the Auto toggle specifically, not the whole Controls dropdown — the other
controls in that menu are out of scope here and should be assessed separately.

### 2. Guard the endpoint

`Infrastructure/server/index.js:9415` — add `requireAdminTokenOrSession`, matching
`/api/fetch` directly above:

```js
app.get("/api/watch", requireAdminTokenOrSession, async (req, res) => {
```

It is already imported at `index.js:26`. Same commit as step 1.

### 3. Stop echoing raw error text to SSE clients

`Infrastructure/server/index.js:9433` currently writes upstream exception text
straight to the stream:

```js
data: JSON.stringify({ message: `Auto-watch cycle failed: ${err.message}` })
```

Log the detail server-side; send a generic message to the client. Lower severity
than the other two, but it is the only part of this stream that can leak internal
state, and it is a two-line change while the file is open.

## Verification

- Signed in as **admin**: Auto toggle visible, stream connects, lines flow.
- Signed in as **non-admin**: toggle absent; direct `GET /api/watch` → 403.
- **Anonymous**: toggle absent; direct `GET /api/watch` → 401.
- No console 401/403 on any page for an anonymous visitor apart from the expected
  `/api/auth/me` probe.
- Grep confirms no other caller broke — see below.

## Blast radius (grepped 2026-08-06)

| Location | Status |
|---|---|
| `app/src/components/shared/TopBar.tsx:355` | **Live caller** — the SPA that ships |
| `frontend/shared/TopBar.tsx:53` | Stale mirror folder; not built, not served |
| `1_News/backend/fetch.ts:284` | A different server's own route definition, not a caller |
| `Infrastructure/server/index.js:9415` | The handler itself |
| `.ua/*.json` | Knowledge-graph artifacts, not code |

Zero references in `scripts/`, zero in any `*.sh`, zero cron. Searched for both
`api/watch` and `EventSource`. No automation depends on this endpoint.

## Related, explicitly out of scope

`/api/position-screener` (`index.js:3632`) is also fully public — it served 162KB
of position data to an unauthenticated production request on 2026-08-06. That is a
separate decision about whether dashboard data is public-by-design, not part of
this ticket. Do not bundle it in.
