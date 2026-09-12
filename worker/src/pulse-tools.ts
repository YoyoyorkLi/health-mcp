import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pgrest } from "./supabase";

const dateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in YYYY-MM-DD form")
	.describe("Date in YYYY-MM-DD form, bucketed to the project's 4am/America-Chicago night convention");

function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return isoDate(d);
}

function today(): string {
	return isoDate(new Date());
}

// Every night_summary column that isn't a large per-minute/per-workout jsonb
// blob (hr_curve, stages, zone_min, workouts). Trend/list tools select only
// these; get_night_detail is the escape hatch for the rest.
const NIGHT_SUMMARY_SCALAR_COLUMNS = [
	"night",
	"drinks",
	"std_drinks",
	"first_drink",
	"last_drink",
	"hrv_rmssd",
	"hrv_baseline",
	"hrv_deep_rmssd",
	"hrv_pct_baseline",
	"hrv_deep_baseline",
	"hrv_deep_pct_baseline",
	"rhr",
	"rhr_baseline",
	"rhr_delta",
	"non_rem_hr",
	"non_rem_hr_baseline",
	"non_rem_hr_delta",
	"resp_rate",
	"resp_rate_baseline",
	"resp_rate_delta",
	"spo2",
	"spo2_min",
	"spo2_drop",
	"spo2_sd",
	"steps",
	"sleep_start",
	"sleep_end",
	"total_sleep_min",
	"rem_min",
	"deep_min",
	"light_min",
	"waso_min",
	"in_bed_min",
	"sleep_need_min",
	"sleep_debt_min",
	"sleep_score",
	"recovery",
	"strain",
	"hrmax",
	"hr_nadir_bpm",
	"hr_nadir_at",
	"min_to_nadir",
	"hr_nadir_min_baseline",
	"nadir_delay_min",
	"skin_temp_c",
	"skin_temp_baseline_c",
	"skin_temp_delta",
	"body_load",
].join(",");

function textResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function registerPulseTools(server: McpServer, env: Env) {
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
			const rows = await pgrest(
				env,
				"night_summary",
				`select=${NIGHT_SUMMARY_SCALAR_COLUMNS}&order=night.desc&limit=${n_nights}`,
			);
			return textResult(rows);
		},
	);

	server.tool(
		"get_night_detail",
		"Full detail for one specific night: every night_summary column, including the hypnogram (stages), heart-rate curve, time-in-zone minutes, and any workouts logged that day. Use this for a deep-dive on a single night; use get_recent_nights for trends across many nights.",
		{ night: dateSchema },
		async ({ night }) => {
			const rows = await pgrest(env, "night_summary", `select=*&night=eq.${night}`);
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
				.optional()
				.describe(
					"Filter to one workout type (case-insensitive), e.g. RUNNING, WALKING, WEIGHTS, CARDIO_WORKOUT, SPORT, WORKOUT, TREADMILL, SKATING. Omit to return every type.",
				),
		},
		async ({ since, until, type }) => {
			const from = since ?? daysAgo(90);
			const to = until ?? today();
			const rows = await pgrest(
				env,
				"night_summary",
				`select=night,workouts&workouts=not.is.null&night=gte.${from}&night=lte.${to}&order=night.desc`,
			);

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
			const rows = await pgrest(env, "night_summary", `select=night,hr_curve&night=eq.${night}`);
			return textResult(rows[0] ?? null);
		},
	);

	server.tool(
		"get_drinks",
		"Raw drink log for a date range: one row per drink with kind (beer/wine/cocktail/shot/double/other), standard-drink count (the actual ethanol dose), and how it was logged.",
		{
			since: dateSchema.describe("Start of range, inclusive"),
			until: dateSchema.optional().describe("End of range, inclusive. Default: today"),
		},
		async ({ since, until }) => {
			const to = until ?? today();
			const rows = await pgrest(
				env,
				"drinks",
				`select=*&night=gte.${since}&night=lte.${to}&order=logged_at.desc`,
			);
			return textResult(rows);
		},
	);

	server.tool(
		"get_dose_response",
		"The project's flagship analysis: drinks vs next-morning physiology. One row per night with std_drinks alongside hrv_pct_baseline, rhr_delta, sleep_score and body_load, so the drinking-vs-recovery relationship (or 'how much did I drink last month and how did I recover') can be read directly off the list.",
		{
			since: dateSchema.optional().describe("Start of range, inclusive. Takes priority over `days` if given."),
			until: dateSchema.optional().describe("End of range, inclusive. Default: today"),
			days: z
				.number()
				.int()
				.min(1)
				.max(3650)
				.optional()
				.describe("Trailing day count, used only when `since` is omitted. Default: 90"),
		},
		async ({ since, until, days }) => {
			const from = since ?? daysAgo(days ?? 90);
			const to = until ?? today();
			const rows = await pgrest(
				env,
				"night_summary",
				`select=night,std_drinks,hrv_pct_baseline,rhr_delta,sleep_score,body_load&night=gte.${from}&night=lte.${to}&order=night.asc`,
			);
			return textResult(rows);
		},
	);

	server.tool(
		"get_sync_status",
		"When the hourly sync last ran and whether it succeeded. Check this before trusting that recent data ('why don't you see last night') is actually up to date.",
		{},
		async () => {
			const rows = await pgrest(env, "sync_state", "select=*&id=eq.1");
			return textResult(rows[0] ?? null);
		},
	);
}
