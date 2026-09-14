// Pure logic used by the tool handlers in pulse-tools.ts -- date math and
// the get_period_summary aggregation. Split out from pulse-tools.ts (which
// also does I/O via pgrest/env) so this can be unit tested directly with
// plain Vitest: no Cloudflare bindings, fetch, or Durable Object storage
// involved, just plain functions in, plain values out.

const NIGHT_TZ = "America/Chicago";

// "Today" and "N days ago" as the project's own civil date, not UTC's. The
// `night` column is bucketed on a 4am America/Chicago cutoff (see
// schema.sql's drink_night()), so a UTC-based default would drift by a full
// day for the ~5-6 hours per day that Chicago's evening is already
// tomorrow in UTC. Mirrors drink_night()'s own rule: convert to wall clock
// FIRST, then do arithmetic on the civil date -- never on a real-time Date.
export function chicagoToday(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: NIGHT_TZ }); // en-CA -> YYYY-MM-DD
}

/** Add (or subtract, for negative n) n calendar days to a YYYY-MM-DD date string. */
export function addDays(date: string, n: number): string {
	const [y, m, d] = date.split("-").map(Number);
	const civil = new Date(Date.UTC(y, m - 1, d));
	civil.setUTCDate(civil.getUTCDate() + n);
	return civil.toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
	return addDays(chicagoToday(), -n);
}

/** Resolve a since/until pair against a shared default-days fallback. */
export function resolveRange(
	since: string | undefined,
	until: string | undefined,
	defaultDays: number,
): { from: string; to: string } {
	return { from: since ?? daysAgo(defaultDays), to: until ?? chicagoToday() };
}

export const MAX_SPAN_DAYS = 730; // ~2 years

/** Guard against a caller requesting an unbounded range of large payloads. */
export function assertSpan(from: string, to: string) {
	const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
	if (days > MAX_SPAN_DAYS) {
		throw new Error(
			`Range too wide (${days} days, max ${MAX_SPAN_DAYS}). Narrow \`since\`/\`until\` and query in batches instead.`,
		);
	}
}

export type SummaryRow = {
	night: string;
	std_drinks: number;
	sleep_score: number | null;
	hrv_pct_baseline: number | null;
	body_load: number | null;
	workouts: Array<{ type: string; min: number }> | null;
};

export function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

export function avg(values: Array<number | null | undefined>): number | null {
	const nums = values.filter((v): v is number => v != null);
	return nums.length ? round1(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
}

/**
 * One period's stats, computed in the Worker rather than a Postgres
 * aggregate query -- no new SQL/RPC needed, and it's the kind of ad hoc
 * aggregation the plan doc flags as worth hand-computing per request until
 * it's demonstrably needed server-side.
 */
export function summarize(rows: SummaryRow[]) {
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
export function diffSummaries(
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
