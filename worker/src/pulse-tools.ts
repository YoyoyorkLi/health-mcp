import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ATHLETE_PROFILE, TRAINING_PLAN } from "./profile";
import { buildQuery, pgrest } from "./supabase";

type AuthProps = { login: string };

// z.iso.date() validates real calendar dates (rejects 2024-02-30, leap years
// handled correctly) -- a hand-rolled `/^\d{4}-\d{2}-\d{2}$/` regex only
// checks shape, so an invalid-but-well-formed date would otherwise reach
// PostgREST and come back as a raw, unshaped Postgres error.
const dateSchema = z
	.iso.date()
	.describe("Date in YYYY-MM-DD form, bucketed to the project's 4am/America-Chicago night convention");

const NIGHT_TZ = "America/Chicago";

// "Today" and "N days ago" as the project's own civil date, not UTC's. The
// `night` column is bucketed on a 4am America/Chicago cutoff (see
// schema.sql's drink_night()), so a UTC-based default would drift by a full
// day for the ~5-6 hours per day that Chicago's evening is already
// tomorrow in UTC. Mirrors drink_night()'s own rule: convert to wall clock
// FIRST, then do arithmetic on the civil date -- never on a real-time Date.
function chicagoToday(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: NIGHT_TZ }); // en-CA -> YYYY-MM-DD
}

function daysAgo(n: number): string {
	return addDays(chicagoToday(), -n);
}

/** Add (or subtract, for negative n) n calendar days to a YYYY-MM-DD date string. */
function addDays(date: string, n: number): string {
	const [y, m, d] = date.split("-").map(Number);
	const civil = new Date(Date.UTC(y, m - 1, d));
	civil.setUTCDate(civil.getUTCDate() + n);
	return civil.toISOString().slice(0, 10);
}

/** Resolve a since/until pair against a shared default-days fallback. */
function resolveRange(
	since: string | undefined,
	until: string | undefined,
	defaultDays: number,
): { from: string; to: string } {
	return { from: since ?? daysAgo(defaultDays), to: until ?? chicagoToday() };
}

const MAX_SPAN_DAYS = 730; // ~2 years

/** Guard against a caller requesting an unbounded range of large payloads. */
function assertSpan(from: string, to: string) {
	const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
	if (days > MAX_SPAN_DAYS) {
		throw new Error(
			`Range too wide (${days} days, max ${MAX_SPAN_DAYS}). Narrow \`since\`/\`until\` and query in batches instead.`,
		);
	}
}

function textResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// The 4 jsonb blobs excluded from get_recent_nights's trend view: hr_curve
// (per-minute samples), stages (hypnogram), zone_min (still small, but kept
// out for symmetry), workouts (its own dedicated tool). Everything else in
// night_summary comes along automatically via select=* -- no hardcoded
// column list to keep in sync as the view grows new columns.
const JSONB_BLOB_COLUMNS = ["hr_curve", "stages", "zone_min", "workouts"] as const;

type SummaryRow = {
	night: string;
	std_drinks: number;
	sleep_score: number | null;
	hrv_pct_baseline: number | null;
	body_load: number | null;
	workouts: Array<{ type: string; min: number }> | null;
};

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

function avg(values: Array<number | null | undefined>): number | null {
	const nums = values.filter((v): v is number => v != null);
	return nums.length ? round1(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
}

/**
 * One period's stats, computed in the Worker rather than a Postgres
 * aggregate query -- no new SQL/RPC needed, and it's the kind of ad hoc
 * aggregation the plan doc flags as worth hand-computing per request until
 * it's demonstrably needed server-side.
 */
function summarize(rows: SummaryRow[]) {
	const drinkingNights = rows.filter((r) => r.std_drinks > 0);
	const soberNights = rows.filter((r) => r.std_drinks === 0);

	const workoutCounts: Record<string, number> = {};
	let totalWorkoutMin = 0;
	for (const row of rows) {
		for (const w of row.workouts ?? []) {
			workoutCounts[w.type] = (workoutCounts[w.type] ?? 0) + 1;
			totalWorkoutMin += w.min ?? 0;
		}
	}

	return {
		nights: rows.length,
		total_std_drinks: round1(rows.reduce((sum, r) => sum + (r.std_drinks ?? 0), 0)),
		drinking_nights: drinkingNights.length,
		sober_nights: soberNights.length,
		avg_sleep_score: avg(rows.map((r) => r.sleep_score)),
		avg_hrv_pct_baseline: avg(rows.map((r) => r.hrv_pct_baseline)),
		avg_hrv_pct_baseline_drinking_nights: avg(drinkingNights.map((r) => r.hrv_pct_baseline)),
		avg_hrv_pct_baseline_sober_nights: avg(soberNights.map((r) => r.hrv_pct_baseline)),
		avg_body_load: avg(rows.map((r) => r.body_load)),
		total_workout_min: totalWorkoutMin,
		workout_counts_by_type: workoutCounts,
	};
}

/** current-minus-previous for every numeric field two summaries share. */
function diffSummaries(
	current: Record<string, unknown>,
	previous: Record<string, unknown>,
): Record<string, number> {
	const delta: Record<string, number> = {};
	for (const key of Object.keys(current)) {
		const a = current[key];
		const b = previous[key];
		if (typeof a === "number" && typeof b === "number") {
			delta[key] = round1(a - b);
		}
	}
	return delta;
}

export function registerPulseTools(server: McpServer, env: Env, props: AuthProps) {
	// Re-checked on every tool call, not just when the Durable Object starts:
	// ALLOWED_GITHUB_LOGIN can be rotated (e.g. to revoke a compromised
	// account) via `wrangler secret put` + redeploy, and env bindings are
	// always current per-request -- but a session's `props` are fixed at
	// OAuth completion and don't change for the DO instance's life. Checking
	// only at init() (as this project originally did) would let an
	// already-warm session keep working under a revoked login until its
	// Durable Object happened to evict. Checking here closes that gap.
	function assertStillAllowed() {
		if (props.login !== env.ALLOWED_GITHUB_LOGIN) {
			throw new Error("Forbidden: this session's GitHub login is no longer on the allowlist.");
		}
	}

	server.tool(
		"get_athlete_profile",
		"Background on who this coach is for: age, training goals (including the upcoming half marathon target), current injury/rehab status, and how to treat the drinking data. Static and hand-maintained -- check `as_of` for how current it is. Call this early in a conversation, or whenever it would sharpen advice, so recommendations account for goals and constraints instead of just raw physiology numbers.",
		{},
		async () => {
			assertStillAllowed();
			return textResult(ATHLETE_PROFILE);
		},
	);

	server.tool(
		"get_training_plan",
		"The structured half-marathon build: phases with date ranges, weekly frequency, HR-zone targets (derived from real hrmax), session focus, and the week-24 decision point on whether the sub-2:00 goal is on track. Static and hand-maintained -- check `as_of` and `current_phase`. Call this before giving any training/pacing/scheduling advice so it matches the actual plan instead of being invented fresh each conversation.",
		{},
		async () => {
			assertStillAllowed();
			return textResult(TRAINING_PLAN);
		},
	);

	server.tool(
		"get_recent_nights",
		"Trend data for 'how have I been sleeping/recovering lately': one row per morning with sleep, HRV/RHR/respiration/SpO2/skin-temp recovery signals, and body_load. No workout or drink detail beyond counts -- use get_workouts / get_drinks for those, get_night_detail for one night's full row including jsonb blobs.",
		{
			n_nights: z
				.number()
				.int()
				.min(1)
				.max(365)
				.default(14)
				.describe("How many most-recent nights to return, newest first"),
		},
		async ({ n_nights }) => {
			assertStillAllowed();
			const rows = await pgrest(
				env,
				"night_summary",
				buildQuery([
					["select", "*"],
					["order", "night.desc"],
					["limit", String(n_nights)],
				]),
			);
			for (const row of rows) {
				for (const col of JSONB_BLOB_COLUMNS) delete row[col];
			}
			return textResult(rows);
		},
	);

	server.tool(
		"get_night_detail",
		"Full detail for one specific night: every night_summary column, including the hypnogram (stages), heart-rate curve, time-in-zone minutes, and any workouts logged that day. Use this for a deep-dive on a single night; use get_recent_nights for trends across many nights.",
		{ night: dateSchema },
		async ({ night }) => {
			assertStillAllowed();
			const rows = await pgrest(
				env,
				"night_summary",
				buildQuery([
					["select", "*"],
					["night", `eq.${night}`],
				]),
			);
			return textResult(rows[0] ?? null);
		},
	);

	server.tool(
		"get_workouts",
		"Workout sessions (passively detected, not logged by hand) across a date range: type, start time, duration, calories, avg heart rate, steps, distance, pace, active zone minutes, and time in HR zones. Use this to compare 'my last run vs the one before' or track a workout type over time -- fetch a range, then filter/diff by type yourself.",
		{
			since: dateSchema.optional().describe("Start of range, inclusive. Default: 90 days ago"),
			until: dateSchema.optional().describe("End of range, inclusive. Default: today"),
			type: z
				.string()
				.min(1)
				.optional()
				.describe(
					"Filter to one workout type (case-insensitive), e.g. RUNNING, WALKING, WEIGHTS, CARDIO_WORKOUT, SPORT, WORKOUT, TREADMILL, SKATING. Omit to return every type.",
				),
		},
		async ({ since, until, type }) => {
			assertStillAllowed();
			const { from, to } = resolveRange(since, until, 90);
			assertSpan(from, to);

			const filters: Array<[string, string]> = [
				["select", "night,workouts"],
				["night", `gte.${from}`],
				["night", `lte.${to}`],
				["order", "night.desc"],
				["workouts", "not.is.null"],
			];
			// PostgREST jsonb containment (`cs.`) pushes the type filter down to
			// Postgres so non-matching nights, and every other type's payload on
			// matching nights, never cross the wire -- instead of fetching every
			// workout in range and discarding most of it in JS. Stored `type`
			// values are always upper-case in this data, hence the normalization.
			// Kept ANDed with `not.is.null` above rather than replacing it, since
			// that's what already excludes nights with no workouts column at all.
			if (type) {
				filters.push(["workouts", `cs.[{"type":"${type.toUpperCase()}"}]`]);
			}
			const rows = await pgrest(env, "night_summary", buildQuery(filters));

			const wantType = type?.toLowerCase();
			const flattened = (rows as Array<{ night: string; workouts: any[] }>).flatMap((row) =>
				(row.workouts ?? [])
					.filter((w) => !wantType || w.type?.toLowerCase() === wantType)
					.map((w) => ({ night: row.night, ...w })),
			);

			return textResult(flattened);
		},
	);

	server.tool(
		"get_hr_curve",
		"The overnight heart-rate curve for one night, as [time, bpm] pairs at 1-minute resolution. Large -- only fetch for a single night you're drilling into.",
		{ night: dateSchema },
		async ({ night }) => {
			assertStillAllowed();
			const rows = await pgrest(
				env,
				"night_summary",
				buildQuery([
					["select", "night,hr_curve"],
					["night", `eq.${night}`],
				]),
			);
			return textResult(rows[0] ?? null);
		},
	);

	server.tool(
		"get_drinks",
		"Raw drink log for a date range: one row per drink with kind (beer/wine/cocktail/shot/double/other), standard-drink count (the actual ethanol dose), and how it was logged.",
		{
			since: dateSchema.optional().describe("Start of range, inclusive. Default: 90 days ago"),
			until: dateSchema.optional().describe("End of range, inclusive. Default: today"),
		},
		async ({ since, until }) => {
			assertStillAllowed();
			const { from, to } = resolveRange(since, until, 90);
			assertSpan(from, to);
			const rows = await pgrest(
				env,
				"drinks",
				buildQuery([
					["select", "*"],
					["night", `gte.${from}`],
					["night", `lte.${to}`],
					["order", "logged_at.desc"],
				]),
			);
			return textResult(rows);
		},
	);

	server.tool(
		"get_dose_response",
		"The project's flagship analysis: drinks vs next-morning physiology. One row per night with std_drinks alongside hrv_pct_baseline, rhr_delta, sleep_score and body_load, so the drinking-vs-recovery relationship (or 'how much did I drink last month and how did I recover') can be read directly off the list.",
		{
			since: dateSchema.optional().describe("Start of range, inclusive. Default: 90 days ago"),
			until: dateSchema.optional().describe("End of range, inclusive. Default: today"),
		},
		async ({ since, until }) => {
			assertStillAllowed();
			const { from, to } = resolveRange(since, until, 90);
			assertSpan(from, to);
			const rows = await pgrest(
				env,
				"night_summary",
				buildQuery([
					["select", "night,std_drinks,hrv_pct_baseline,rhr_delta,sleep_score,body_load"],
					["night", `gte.${from}`],
					["night", `lte.${to}`],
					["order", "night.asc"],
				]),
			);
			return textResult(rows);
		},
	);

	server.tool(
		"get_period_summary",
		"Aggregated stats for a period in one call: total/average drinks, average sleep score, HRV vs baseline (overall, and split by drinking vs sober nights -- the project's flagship comparison), average body load, and workout counts by type. Answers 'how much did I drink last month and how did I recover' directly, without summing raw rows by hand. Defaults to comparing against the immediately-prior period of the same length -- set compare_to_previous to false to skip that.",
		{
			since: dateSchema.optional().describe("Start of range, inclusive. Default: 30 days ago"),
			until: dateSchema.optional().describe("End of range, inclusive. Default: today"),
			compare_to_previous: z
				.boolean()
				.default(true)
				.describe("Also compute the same-length immediately-prior period and a delta against it"),
		},
		async ({ since, until, compare_to_previous }) => {
			assertStillAllowed();
			const { from, to } = resolveRange(since, until, 30);
			assertSpan(from, to);

			const fetchRows = (rangeFrom: string, rangeTo: string) =>
				pgrest(
					env,
					"night_summary",
					buildQuery([
						["select", "night,std_drinks,sleep_score,hrv_pct_baseline,body_load,workouts"],
						["night", `gte.${rangeFrom}`],
						["night", `lte.${rangeTo}`],
					]),
				) as Promise<SummaryRow[]>;

			const current = summarize(await fetchRows(from, to));

			if (!compare_to_previous) {
				return textResult({ range: { from, to }, current });
			}

			const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
			const prevTo = addDays(from, -1);
			const prevFrom = addDays(prevTo, -(spanDays - 1));
			const previous = summarize(await fetchRows(prevFrom, prevTo));

			return textResult({
				range: { from, to },
				current,
				previous_range: { from: prevFrom, to: prevTo },
				previous,
				delta: diffSummaries(current, previous),
			});
		},
	);

	server.tool(
		"get_sync_status",
		"When the hourly sync last ran and whether it succeeded. Check this before trusting that recent data ('why don't you see last night') is actually up to date.",
		{},
		async () => {
			assertStillAllowed();
			const rows = await pgrest(
				env,
				"sync_state",
				buildQuery([
					["select", "*"],
					["id", "eq.1"],
				]),
			);
			return textResult(rows[0] ?? null);
		},
	);
}
