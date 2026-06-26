# Free, always-up FlashFeed — with a working "Run Now"

Goal: a public website that's always up, where clicking **Run Now** fetches fresh news.

How the pieces map (all free):

| Piece | Host | Always up? |
|---|---|---|
| **Website** (React frontend) | Vercel **or** Netlify **or** Cloudflare Pages | ✅ yes, instantly |
| **Backend** (Express API + Python fetchers — what Run Now calls) | Render free (Docker) | ⏳ sleeps after ~15 min idle; kept warm in Step 4 |
| **Database** | MongoDB Atlas M0 | ✅ yes (512 MB) |

You do **not** need Kafka or Redis for this — the app reads straight from Mongo, so the free stack is just these three. `render.yaml` and `app/vercel.json` are already in this repo.

**What I can't do for you:** actually click "deploy" — that runs inside *your* accounts, and only you can log in. Everything below is the click path.

---

## Step 0 — push this repo to GitHub
Create a new GitHub repo and push this project to it. Render and Vercel both deploy from GitHub.
(`.env` is gitignored, so your token won't be pushed — good. You'll paste secrets into the dashboards instead.)

## Step 1 — Database: MongoDB Atlas (free)
1. Sign up at mongodb.com/atlas → create a **free M0 cluster**.
2. **Database Access** → add a user (username + password).
3. **Network Access** → Add IP → **Allow access from anywhere** (`0.0.0.0/0`) so Render can connect.
4. **Connect → Drivers** → copy the connection string (looks like `mongodb+srv://USER:PASS@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority`). Keep it for Step 2.

## Step 2 — Backend: Render (free, Docker)
1. Sign up at render.com → **New + → Blueprint** → pick your GitHub repo. Render reads `render.yaml`.
2. It will prompt for the two secrets:
   - `MONGODB_URI` → paste your Atlas string from Step 1 (add your DB name before the `?`, e.g. `...mongodb.net/flashfeed?retryWrites=...`).
   - `FINVIZ_AUTH_TOKEN` → your Finviz Elite token.
3. Click **Apply / Deploy**. First build takes a few minutes (it installs Python + the news pipeline into the image).
4. When live, copy the service URL, e.g. `https://flashfeed-api.onrender.com`. Test it: open `…/api/health` → you should see an OK response.

> Not seeing the Blueprint option? Use **New + → Web Service → Docker**, set Dockerfile path `Infrastructure/server/Dockerfile`, **Docker Build Context Directory** `.` (repo root), **Docker Command** `npm start`, Health Check Path `/api/health`, and add the env vars listed in `render.yaml`.

## Step 3 — Website: Vercel (free)
1. Edit `app/vercel.json` → in the `/api/:path*` rewrite, replace `REPLACE-WITH-YOUR-BACKEND-URL` with your Render host from Step 2 (no `https://`, just the host, e.g. `flashfeed-api.onrender.com`). Commit + push.
2. Sign up at vercel.com → **Add New → Project** → import the repo → set **Root Directory = `app`** → Deploy.
3. You get a public URL like `https://your-app.vercel.app`. **That's your website.** Because the frontend calls relative `/api/...` and Vercel proxies it to Render, no code changes and no CORS setup are needed.

*(Prefer Netlify or Cloudflare Pages? Same idea: base directory `app`, build `vite build`, publish `dist`, and add a proxy/redirect for `/api/*` → your Render URL.)*

## Step 4 — Keep it warm so Run Now is instant (free)
Render free sleeps after ~15 min idle, which would make the first Run Now wait ~30–60 s for a cold start. Prevent that:
1. Sign up at **uptimerobot.com** (free).
2. Add a **HTTP(s) monitor** → URL `https://flashfeed-api.onrender.com/api/health` → interval **5 minutes**.
This pings the backend so it stays awake, and Run Now responds immediately. (One free Render service running ~24/7 fits the 750 hrs/month free allowance.)

## Step 5 — Use it
Open your Vercel URL → click **Run Now** (Fast mode). The frontend POSTs `/api/fetch`, Render runs the Python news fetchers, fresh articles land in Atlas, and the News/Overview tabs refresh. Done — a free site, always up, where Run Now updates the news.

---

## Notes & limits (honest)
- **Run Now timing:** Fast mode is quick and works through the Vercel proxy. A full "Full" refresh can run longer; if a proxy ever times out, use the **Watch** toggle (it streams progress over SSE and won't time out the same way).
- **RAM:** Render free is 512 MB. The fetchers (curl_cffi, parsing, sentiment) can be tight there — if a run gets killed, stay on Fast mode, or move the backend to a $7/mo instance (everything else stays free).
- **Atlas 512 MB housekeeping:** the fetchers upsert by URL (re-running doesn't duplicate), so growth is bounded by unique articles. If you ever approach the cap, add a TTL index to expire old docs, e.g. in `mongosh`:
  `db.articles.createIndex({ detected_at: 1 }, { expireAfterSeconds: 1209600 })`  *(14 days — only works if `detected_at` is stored as a BSON Date; adjust the field/type to match your schema).*
- **Finviz Elite** is a paid subscription (separate from hosting). Keep the token in the Render dashboard (a secret env var), never in the repo. If it's ever been shared, rotate it.
- **No paid news APIs required:** the core feed comes from RSS sources + Finviz. The optional keys in `render.yaml` (Benzinga, X, Reddit, etc.) only add those extra sources.
- **Truly zero cold-start, always-on backend:** that's the one thing free tiers don't guarantee. The warm-ping above gets you 99% of the way; a $7/mo Render instance removes it entirely.
