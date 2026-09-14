# Pulse Health Coach — remote MCP server

Exposes the `pulse` Supabase project (sleep / HRV / recovery / drinking data
from [fitbitair-pwa](https://github.com/YoyoyorkLi/fitbitair-pwa)) to Claude.ai
as a custom connector, read-only, gated to one GitHub account.

Full design rationale lives in
[`../MCP-HEALTH-COACH-PLAN.md`](../MCP-HEALTH-COACH-PLAN.md) — read that
first if anything here is unclear. This file is just the setup mechanics.

Built from Cloudflare's [`remote-mcp-github-oauth`](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth)
template: [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
handles the OAuth *server* side (issuing tokens to MCP clients like
Claude.ai); this Worker is simultaneously an OAuth *client* to GitHub, used
only to identify who's connecting.

## What's here

- `src/index.ts` — the `PulseCoachMCP` Durable Object (the MCP server itself)
  and the `ALLOWED_GITHUB_LOGIN` gate.
- `src/github-handler.ts` — the GitHub OAuth dance (`/authorize`,
  `/callback`). **The real access-control boundary is here**: it refuses to
  issue a token to any GitHub login other than `ALLOWED_GITHUB_LOGIN`, before
  the approval dialog even matters.
- `src/supabase.ts` — signs in to Supabase Auth with the password grant,
  caches the access token in the calling Durable Object's own storage (so it
  survives isolate churn, not just the current isolate's lifetime), wraps
  PostgREST GETs.
- `src/logic.ts` — pure date-math and aggregation logic (date-range
  resolution, the `get_period_summary` rollup), split out from
  `pulse-tools.ts` specifically so it's unit-testable with plain Vitest —
  see Testing below.
- `src/profile.ts` — `ATHLETE_PROFILE`, a small hand-maintained fact sheet
  (age, training goal, injury status) behind the `get_athlete_profile` tool.
  Not derived from Supabase; edit this file directly when any of it changes.
- `src/pulse-tools.ts` — the 9 tools. See the plan doc §3 for the full table.
- `src/workers-oauth-utils.ts`, `src/utils.ts` — template plumbing (CSRF,
  approval-dialog cookie, GitHub token exchange). Untouched.

## Setup

### 1. Supabase: dedicated coach auth user

Dashboard → Authentication → Users → Add user. Email + password,
auto-confirm. Confirm Authentication → Sign In / Providers → "Allow new users
to sign up" is **off** first, or anyone can self-register as `authenticated`
and read everything. Don't reuse the PWA's own login — keep this
independently revocable. See plan doc §2B for why this user's RLS rights are
broader than "read-only" in practice, and the tradeoff of not tightening that
for v1.

### 2. GitHub OAuth app

Register at [github.com/settings/developers](https://github.com/settings/developers) →
"New OAuth App".

- **Production**: Homepage URL `https://pulse-coach-mcp.<your-subdomain>.workers.dev`,
  callback URL `https://pulse-coach-mcp.<your-subdomain>.workers.dev/callback`.
- **Local dev**: a *second* OAuth app — Homepage `http://localhost:8788`,
  callback `http://localhost:8788/callback`. Local and prod need different
  apps because GitHub OAuth apps take exactly one callback URL.

### 3. Install deps

```bash
npm install --legacy-peer-deps
```

The `--legacy-peer-deps` flag is required: the template pins
`@cloudflare/workers-types` and `wrangler` versions whose peer dependencies
conflict (`ERESOLVE`). Harmless in practice — plain `npm install` fails, this
doesn't.

### 4. Local dev secrets

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` (gitignored, never commit it) with the **local** GitHub
OAuth app's credentials, a random `COOKIE_ENCRYPTION_KEY`
(`openssl rand -hex 32`), your GitHub username as `ALLOWED_GITHUB_LOGIN`, and
the Supabase values from step 1 / `fitbitair-pwa/.env.local`.

```bash
npm run dev        # wrangler dev, http://localhost:8788
npm run type-check
```

### 5. KV namespace (needed before any deploy, including first)

```bash
npx wrangler kv namespace create OAUTH_KV
```

Paste the returned id into `wrangler.jsonc`, replacing `<Add-KV-ID>`.

### 6. Production secrets

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put ALLOWED_GITHUB_LOGIN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_COACH_EMAIL
npx wrangler secret put SUPABASE_COACH_PASSWORD
```

Use the **production** GitHub OAuth app's credentials here, not the local
dev app's. When you set the first secret, Wrangler will ask to create the
Worker on your Cloudflare account — say yes.

### 7. Deploy

```bash
npx wrangler deploy
```

### 8. Connect in Claude.ai

Settings → Connectors → Add custom connector → paste the deployed Worker's
URL (`https://pulse-coach-mcp.<your-subdomain>.workers.dev/mcp`) → complete
the GitHub OAuth prompt once. A GitHub login other than the one in
`ALLOWED_GITHUB_LOGIN` gets a 403 at the callback, not a token.

### 9. Local testing without Claude.ai

[MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx @modelcontextprotocol/inspector@latest
```

Enter `http://localhost:8788/mcp`, connect, go through the GitHub prompt,
"List Tools".

## Testing

```bash
npm test
```

Plain Vitest (no Cloudflare Workers pool needed) against `src/logic.ts` —
date-range resolution, the span guard, and the `get_period_summary`
aggregation, all pure functions with no bindings or I/O. This is what
should have caught things like the `buildQuery` duplicate-key bug that
shipped and got fixed mid-session the first time around, instead of relying
on a live deploy and a manual tool call to notice. `pulse-tools.ts` itself
(the `server.tool(...)` registrations and the PostgREST calls) isn't
covered — that's integration-shaped and would need mocking `fetch`/the DO
storage API to test meaningfully; not done here.

## Known gotcha: reconnecting after a deploy

**A `wrangler deploy` does not restart an already-connected MCP session.**
`PulseCoachMCP` is a Durable Object; `init()` (where tools get registered)
only runs when that DO instance starts, not on every request. An
already-open Claude.ai chat or Claude Code session keeps running whatever
tool list and code were live when it first connected — new tools won't
appear, and fixes to existing tools' logic won't take effect — until that
specific session gets a fresh connection.

What actually works, roughly in order of effort:

1. **New conversation.** Should be enough in principle, but wasn't fully
   reliable in testing — a fresh chat sometimes still showed a stale tool
   count, suggesting there's a connector-level cache above the per-session
   one that a new chat alone doesn't always bypass.
2. **Toggle the connector off and on** (in Claude Code: disable it, end the
   turn, re-enable, end the turn again — the change only applies at turn
   boundaries). Got a stale session from 7 tools to 8 in testing, but
   plateaued there across repeated cycles rather than reaching the actual
   current count — don't expect a second or third cycle to make further
   progress once it stops moving.
3. **Fully remove and re-add the connector** in Claude.ai (Settings →
   Connectors → delete → Add custom connector → paste the URL again → redo
   the GitHub approval). The most reliable option seen so far, since it
   forces a genuinely new OAuth handshake and MCP session rather than
   reusing anything pooled.

If you're debugging "why doesn't the coach see tool X," check this before
assuming the Worker code is wrong — confirm the actual deployment is
current first (`npx wrangler deployments list`), which rules out a stale
Cloudflare deploy in about 10 seconds and points squarely at the connector
layer instead.

## Security note

> [!WARNING]
> This started from a demo template. `ALLOWED_GITHUB_LOGIN` is the only
> thing standing between "just me" and "anyone with a GitHub account" —
> double-check it's set correctly before deploying, and treat the Supabase
> coach password with the same care as the PWA's own credentials.
