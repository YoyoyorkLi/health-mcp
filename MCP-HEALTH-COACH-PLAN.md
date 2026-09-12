# Pulse Health Coach — Remote MCP Server Implementation Plan

Handoff doc for a build session. Goal: expose the `pulse` Supabase database to
Claude.ai (web/mobile) as a custom connector, so a "health coach" persona can
query sleep/HRV/recovery/drinking data conversationally, from any device, for
free.

This doc was scoped against the actual schema in this repo
(`pulse/sql/schema.sql`, `pulse/sql/add_workouts.sql`,
`pulse/sql/migrations/001_recovery_load.sql`, `.../002_deep_hrv_nadir_spo2.sql`)
— read those files first if anything below seems to assume a column that
doesn't exist; they're the source of truth, not this doc.

**Status: scaffolded.** The Worker lives in [`worker/`](worker/), built from
Cloudflare's `remote-mcp-github-oauth` template. All 7 tools below are
implemented (`worker/src/pulse-tools.ts`) and the server boots and typechecks
locally. Not yet done: the dedicated Supabase coach auth user, the GitHub
OAuth app, secrets, and a real deploy — see `worker/README.md` for the
remaining setup steps.

---

## 1. Architecture

```
Claude.ai (web/mobile)
   │  custom connector, OAuth
   ▼
Cloudflare Worker  (remote MCP server, free tier)
   │  signs in to Supabase Auth as a dedicated read-only user,
   │  calls PostgREST with the resulting JWT
   ▼
Supabase (existing `pulse` project)
   - public.night_summary (view)   <- the coach's main data source
   - public.drinks        (table)
   - public.sync_state    (table)
```

Total cost: **$0**. Cloudflare Workers free tier (100k req/day) comfortably
covers a personal assistant queried a few times a day. Supabase is the project
you already run. GitHub OAuth (used only to gate the connector to you) is free.

Key simplification found while scoping this: **no new SQL is needed.**
`public.night_summary` already joins drinks against the correct next-morning
`nights` row, computes every baseline delta (`hrv_pct_baseline`, `rhr_delta`,
`body_load`, etc.), and is exactly the "one row per morning, everything a
chart would draw" shape a coach wants. The MCP server is a thin read-only
wrapper around that view plus `drinks` and `sync_state` — no new views,
functions, or migrations required for v1.

---

## 2. Auth model (two separate concerns — don't conflate them)

**A. Claude.ai ↔ Worker (OAuth):** gates the connector so only you can add/use
it. Use Cloudflare's ready-made template — it already implements the OAuth
provider side (PKCE, token issuance, redirect handling):

```
npm create cloudflare@latest -- pulse-coach-mcp \
  --template=cloudflare/ai/demos/remote-mcp-github-oauth
```

This uses GitHub as the identity provider. After a user signs in with GitHub,
check their GitHub login/user-id against an allowlist of exactly one value
(yours) before letting any tool call through. Nothing else needs building for
auth on this side.

**B. Worker ↔ Supabase (data access):** the existing RLS policies in
`schema.sql` grant `select` on `drinks`, `nights`, `sync_state`,
`night_summary` to the `authenticated` role only — `anon` is explicitly
revoked. So the Worker needs a real Supabase Auth session, not just the anon
key.

Recommended: create a **second** Supabase Auth user dedicated to this Worker
(Authentication → Users → Add user, same manual flow `schema.sql` already
documents for the PWA's own login — email + password, auto-confirm, no
signups allowed). Don't reuse the PWA's own login credentials for this — keep
them independently revocable.

The Worker signs in via Supabase's password grant on each cold start /
periodically:

```
POST {SUPABASE_URL}/auth/v1/token?grant_type=password
{ "email": "...", "password": "..." }
```

...and uses the returned `access_token` as `Authorization: Bearer` on
PostgREST reads (`{SUPABASE_URL}/rest/v1/night_summary?...`). Given the tiny
request volume, don't build refresh-token caching in v1 — a fresh
password-grant sign-in per request (or per Worker isolate lifetime) is fine.
Add caching later only if it's actually slow.

**Open decision, flag for whoever builds this:** this "coach" auth user has
the same RLS rights as the PWA's login — technically it *can* insert/update/
delete `drinks`, even though the Worker will only ever call read endpoints.
The real guarantee is "the Worker's code never calls a write endpoint," not a
database-level read-only restriction. If that's not tight enough, the
alternative is a dedicated Postgres role + new RLS policies scoped to
`select`-only — more setup, harder guarantee. Default recommendation: ship
with the simple version above; revisit only if it starts to bother you.

---

## 3. MCP tools (v1) — implemented in `worker/src/pulse-tools.ts`

All read-only. Large `jsonb` columns (`hr_curve`, `stages`, `zone_min`,
`workouts`) are kept out of multi-night queries — they're only fetched for a
single night, or flattened (`workouts`), never returned raw across a range.

| Tool | Purpose | Params | Backing query |
|---|---|---|---|
| `get_recent_nights` | Trend data for "how have I been sleeping/recovering lately" | `n_nights` (default 14) | scalar columns only (no `hr_curve`/`stages`/`zone_min`/`workouts`) from `night_summary`, `order by night desc limit n_nights` |
| `get_night_detail` | Deep-dive on one specific night, incl. hypnogram/curve/workouts | `night` (date) | `select *` from `night_summary where night = :night` |
| `get_workouts` | Trend/comparison across workouts — "how was my last run vs the one before" | `since`, `until` (date, default last 90d), `type` (optional, e.g. `RUNNING`/`WEIGHTS`) | `select night, workouts from night_summary where workouts is not null and night between :since and :until`, flattened one row per workout in the Worker, filtered by `type` if given |
| `get_hr_curve` | Just the overnight HR curve for one night, without the rest of the row | `night` (date) | `select night, hr_curve from night_summary where night = :night` |
| `get_drinks` | Raw drink log for a date range | `since`, `until` (date, both optional, default last 90d) | `select * from drinks where night between :since and :until order by logged_at desc` |
| `get_dose_response` | The project's flagship analysis: drinks vs next-morning physiology | `since`, `until` (date, both optional, default last 90d) | `select night, std_drinks, hrv_pct_baseline, rhr_delta, sleep_score, body_load from night_summary where night between :since and :until order by night` |
| `get_period_summary` | Aggregated period stats in one call — total/avg drinks, avg sleep score, HRV% split by drinking vs sober nights, avg body load, workout counts by type — plus the same-length prior period and a delta. Answers "how much did I drink last month and how did I recover" without the caller summing raw rows | `since`, `until` (date, default last 30d), `compare_to_previous` (bool, default true) | fetches the same night_summary rows `get_dose_response` would, aggregates in the Worker (no new SQL) |
| `get_sync_status` | "Why don't you see last night's data" | none | `select * from sync_state where id = 1` |

Notes:
- `get_workouts` exists because nothing else surfaces workouts across a
  range — `get_recent_nights` deliberately excludes the jsonb column, and
  `get_night_detail` only covers one night. Real workout `type` values seen
  in this project's data (180-day sample): `WALKING`, `CARDIO_WORKOUT`,
  `SPORT`, `WORKOUT`, `RUNNING`, `TREADMILL`, `WEIGHTS`, `SKATING` — richer
  fields than schema.sql's comment shows (`zones`, `dist_m`, `pace_s_per_m`,
  `azm`, `steps` per workout, not just `type`/`start`/`min`/`cal`/`avg_hr`).
  Some types (`WEIGHTS`) are sparse (1 in 180 days) — a "vs previous lift"
  question may need a wider `since` than the 90-day default to find a second
  data point.
- Column list for `get_recent_nights` / `get_dose_response`: hardcoded in
  `pulse-tools.ts` from `night_summary`'s definition as of this build. If the
  view grows a new column via a future migration, update the column list
  there — this doc won't drift, but the constant will need a manual bump.
- `night` is a `date`, already bucketed to the 4am/America-Chicago
  convention described in `schema.sql`'s `drink_night()` comment. Don't
  re-derive or re-bucket it client-side — trust the column.
- If, after using this for a while, the same aggregation keeps getting
  re-derived by Claude turn after turn (e.g. "average HRV% on drinking vs
  sober nights"), that's a signal to add a small Postgres RPC function that
  computes it server-side — don't pre-build that speculatively for v1.

---

## 4. Build steps

1. ~~**Supabase**: add the dedicated auth user for the Worker~~ — **not done
   yet**. Still needed: dashboard → Authentication → Users → Add user, email +
   password, auto-confirm, "Allow new users to sign up" OFF. No schema
   changes needed.
2. ~~**Scaffold**~~ — **done**. `worker/`, from
   `npm create cloudflare@latest worker --category=remote-template --template=cloudflare/ai/demos/remote-mcp-github-oauth`.
   Note: the template's pinned `@cloudflare/workers-types` conflicts with its
   pinned `wrangler` (`ERESOLVE`) — `npm install` needs `--legacy-peer-deps`.
   Already run; `node_modules/` is gitignored so a fresh clone will hit this
   again and need the same flag.
3. **GitHub OAuth app**: register one (github.com/settings/developers),
   callback URL = the Worker's `/callback` route per `worker/README.md`. Not
   done yet — needed before the Worker is usable at all, even locally.
4. **Secrets** (`wrangler secret put ...`, see `worker/.dev.vars.example` for
   local dev): `SUPABASE_URL`, `SUPABASE_ANON_KEY` (needed to call the auth
   token endpoint), `SUPABASE_COACH_EMAIL`, `SUPABASE_COACH_PASSWORD`,
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`
   (template requires this for its own session cookie), `ALLOWED_GITHUB_LOGIN`
   (your username — checked twice: at the OAuth callback in
   `github-handler.ts`, which is the real gate, and again defensively before
   registering tools in `index.ts`). Not done yet.
5. ~~**Implement the 7 tools**~~ — **done**, `worker/src/pulse-tools.ts` +
   `worker/src/supabase.ts`. Typechecks (`npm run type-check`) and boots
   clean under `wrangler dev` (`/mcp` correctly 401s without auth); not yet
   exercised against real Supabase/GitHub credentials since none exist yet.
6. **Deploy**: needs a KV namespace first (`wrangler kv namespace create
   OAUTH_KV`, then paste the id into `wrangler.jsonc` — still has the
   template's `<Add-KV-ID>` placeholder) and steps 1/3/4 above, then
   `wrangler deploy`.
7. **Connect in Claude.ai**: Settings → Connectors → Add custom connector →
   paste the Worker's URL → complete the GitHub OAuth prompt once.
8. **Coach persona**: write this as Claude.ai Project instructions (not
   server code) — e.g. "You're my health coach. Use the Pulse tools to check
   my recent nights before giving advice. Flag when `body_load` is elevated
   or high, or `sync_status` looks stale. Be direct, not clinical." Iterate on
   tone in the chat itself; keep it out of the Worker so it can change
   without a redeploy.

---

## 5. Validation checklist

- [ ] OAuth: a signed-out GitHub account (or wrong username) is rejected by
      the Worker.
- [ ] `get_recent_nights` returns the last N nights with plausible
      `hrv_pct_baseline` / `body_load` values, no jsonb blobs.
- [ ] `get_night_detail` on a known night matches what the PWA shows for that
      night.
- [ ] `get_dose_response` output actually shows the drinks-vs-HRV
      relationship described in `schema.sql`'s `night_summary` comments.
- [ ] `get_sync_status` reflects the real `last_sync_at` — kill the GitHub
      Actions sync temporarily (or check on a day it's known stale) to
      confirm the coach notices.
- [ ] Confirm in the Supabase dashboard that the coach auth user has never
      triggered an insert/update/delete (should be zero, since no write tool
      exists).

---

## 6. Explicitly out of scope for v1

- No write tools (logging a drink via the coach, editing a night, etc.) —
  this is a read-only advisor to start.
- No token refresh/caching infrastructure — re-authenticate per request until
  that's demonstrably too slow.
- No new Postgres views/RPCs — `night_summary` already covers it.
- No multi-user support — the OAuth allowlist is exactly one GitHub account.

## 7. Candidate v2 features (not built, worth a deliberate yes before building)

- **Streaks**: "days since last drink," "current sober streak," "longest
  streak of sleep_score above N" — cheap to compute from data already
  returned by `get_dose_response`/`get_recent_nights`, mostly a UX/framing
  question of whether it's worth a dedicated tool vs letting the coach derive
  it from a fetched range.
- **Workout personal records**: fastest pace / longest duration / highest
  avg HR per workout type, all-time or within a range — extends
  "last run vs previous" (already supported) to "last run vs my best run."
- **A write tool (log a drink via the coach)**: the one candidate that
  reverses a deliberate v1 decision (§6) rather than extending it — needs an
  explicit choice, not a default addition, since it changes what the coach
  auth user's already-broader-than-needed RLS grants (§2B) actually get used
  for. If built, scope it to exactly one insert-shaped tool, nothing else.
