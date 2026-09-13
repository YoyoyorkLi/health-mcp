# Pulse Health Coach

A remote [MCP](https://modelcontextprotocol.io) server that exposes the
`pulse` Supabase project — sleep, HRV, recovery, workouts, and a drinking log
synced from a Fitbit/Pixel Watch via
[fitbitair-pwa](https://github.com/YoyoyorkLi/fitbitair-pwa) — to Claude.ai as
a read-only custom connector, gated to one GitHub account.

**Status: deployed.** `https://pulse-coach-mcp.yorkhealthmcp.workers.dev`

## What it's for

Connect it in Claude.ai (Settings → Connectors) and give Claude a health-coach
persona that can check real data before answering — "how was my last run
compared to the one before," "how much did I drink last month and how did I
recover," "why don't you see last night's data yet."

![Architecture: Claude connects over MCP to a Cloudflare Worker, which contains an OAuth provider (one-time GitHub login, gated to one account) and the PulseCoachMCP Durable Object (9 read-only tools). The Durable Object signs in to Supabase with a password login and queries it via PostgREST.](docs/architecture.svg)

The GitHub OAuth login only happens once, when the connector is first added —
it's how the Worker identifies who's connecting, checked against an allowlist
of one account. Every tool call after that runs on tokens; the Worker
separately logs itself into Supabase with a plain password (not OAuth,
invisible to you) to actually read the data.

Runs entirely on free tiers (Cloudflare Workers, the existing Supabase
project). No servers to manage.

## Tools

| Tool | Answers |
|---|---|
| `get_athlete_profile` | Who is this coach for — age, training goals, injury status, how to treat the drinking data |
| `get_recent_nights` | How have I been sleeping/recovering lately? |
| `get_night_detail` | Full detail on one specific night |
| `get_workouts` | My workouts over a range, filterable by type — for "last run vs the one before" |
| `get_hr_curve` | The overnight heart-rate curve for one night |
| `get_drinks` | Raw drink log for a date range |
| `get_dose_response` | Drinks vs next-morning physiology, night by night |
| `get_period_summary` | Aggregated stats for a period + comparison to the prior period |
| `get_sync_status` | Is the data actually up to date? |

All read-only. See [`MCP-HEALTH-COACH-PLAN.md`](MCP-HEALTH-COACH-PLAN.md) §3
for exact params and backing queries.

## Repo layout

- [`MCP-HEALTH-COACH-PLAN.md`](MCP-HEALTH-COACH-PLAN.md) — the design doc:
  architecture, auth model, why each decision was made, validation checklist,
  and candidate v2 features. Read this for *why*.
- [`worker/`](worker/) — the Cloudflare Worker itself.
  [`worker/README.md`](worker/README.md) has setup/deploy steps. Read that
  for *how*.

## Security note

Access is gated by a GitHub-login allowlist (`ALLOWED_GITHUB_LOGIN`), checked
both at OAuth callback and on every tool call. If you're standing up your own
copy of this, double-check that value before deploying —
[`worker/README.md`](worker/README.md) walks through it.
