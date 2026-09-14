import { describe, expect, it } from "vitest";
import { addDays, assertSpan, avg, chicagoToday, diffSummaries, resolveRange, summarize } from "./logic";
import type { SummaryRow } from "./logic";

describe("chicagoToday", () => {
	it("returns a YYYY-MM-DD date string", () => {
		expect(chicagoToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("addDays", () => {
	it("adds days within a month", () => {
		expect(addDays("2026-09-12", 3)).toBe("2026-09-15");
	});

	it("subtracts days within a month", () => {
		expect(addDays("2026-09-12", -3)).toBe("2026-09-09");
	});

	it("crosses a month boundary", () => {
		expect(addDays("2026-09-29", 3)).toBe("2026-10-02");
	});

	it("crosses a year boundary", () => {
		expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
	});

	it("handles a leap-year February correctly", () => {
		// 2028 is a leap year; Feb 28 + 1 = Feb 29, not Mar 1.
		expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
		expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
	});
});

describe("resolveRange", () => {
	it("uses explicit since/until when both given", () => {
		const { from, to } = resolveRange("2026-01-01", "2026-01-31", 90);
		expect(from).toBe("2026-01-01");
		expect(to).toBe("2026-01-31");
	});

	it("defaults `to` to today when until is omitted", () => {
		const { to } = resolveRange("2026-01-01", undefined, 90);
		expect(to).toBe(chicagoToday());
	});

	it("defaults `from` to defaultDays before today when since is omitted", () => {
		const { from } = resolveRange(undefined, undefined, 30);
		expect(from).toBe(addDays(chicagoToday(), -30));
	});
});

describe("assertSpan", () => {
	it("does not throw for a span within the max", () => {
		expect(() => assertSpan("2026-01-01", "2026-06-01")).not.toThrow();
	});

	it("does not throw exactly at the max", () => {
		const to = addDays("2026-01-01", 730);
		expect(() => assertSpan("2026-01-01", to)).not.toThrow();
	});

	it("throws once the span exceeds the max", () => {
		const to = addDays("2026-01-01", 731);
		expect(() => assertSpan("2026-01-01", to)).toThrow(/Range too wide/);
	});
});

describe("avg", () => {
	it("returns null for an empty array", () => {
		expect(avg([])).toBeNull();
	});

	it("returns null when every value is null/undefined", () => {
		expect(avg([null, undefined, null])).toBeNull();
	});

	it("ignores null/undefined and averages the rest", () => {
		expect(avg([10, null, 20, undefined, 30])).toBe(20);
	});

	it("rounds to one decimal place", () => {
		expect(avg([1, 2, 2])).toBe(1.7); // 5/3 = 1.666...
	});

	it("does not drop a real zero value (falsy-zero check)", () => {
		expect(avg([0, 10])).toBe(5);
	});
});

describe("summarize", () => {
	const rows: SummaryRow[] = [
		{
			night: "2026-09-06",
			std_drinks: 0,
			sleep_score: 74,
			hrv_pct_baseline: 103.8,
			body_load: 0.288,
			workouts: [{ type: "RUNNING", min: 31 }],
		},
		{
			night: "2026-09-08",
			std_drinks: 6,
			sleep_score: 42,
			hrv_pct_baseline: 59.7,
			body_load: 0.816,
			workouts: null,
		},
		{
			night: "2026-09-09",
			std_drinks: 5,
			sleep_score: 60,
			hrv_pct_baseline: 94.9,
			body_load: 0.187,
			workouts: [{ type: "WALKING", min: 20 }],
		},
		{
			night: "2026-09-11",
			std_drinks: 0,
			sleep_score: 85,
			hrv_pct_baseline: 129.2,
			body_load: 0,
			workouts: [
				{ type: "RUNNING", min: 32 },
				{ type: "WALKING", min: 10 },
			],
		},
	];

	it("splits nights into drinking vs sober correctly", () => {
		const s = summarize(rows);
		expect(s.nights).toBe(4);
		expect(s.drinking_nights).toBe(2);
		expect(s.sober_nights).toBe(2);
	});

	it("sums std_drinks across the period", () => {
		expect(summarize(rows).total_std_drinks).toBe(11);
	});

	it("computes overall and split HRV averages -- the flagship comparison", () => {
		const s = summarize(rows);
		// Sober nights: 103.8, 129.2 -> avg 116.5
		expect(s.avg_hrv_pct_baseline_sober_nights).toBe(116.5);
		// Drinking nights: 59.7, 94.9 -> avg 77.3
		expect(s.avg_hrv_pct_baseline_drinking_nights).toBe(77.3);
		expect(s.avg_hrv_pct_baseline).toBe(avg(rows.map((r) => r.hrv_pct_baseline)));
	});

	it("counts workouts by type and sums total minutes across the period", () => {
		const s = summarize(rows);
		expect(s.workout_counts_by_type).toEqual({ RUNNING: 2, WALKING: 2 });
		expect(s.total_workout_min).toBe(31 + 20 + 32 + 10);
	});

	it("handles an empty period without throwing", () => {
		const s = summarize([]);
		expect(s.nights).toBe(0);
		expect(s.total_std_drinks).toBe(0);
		expect(s.avg_sleep_score).toBeNull();
		expect(s.workout_counts_by_type).toEqual({});
	});

	it("does not let a real body_load of 0 register as missing (falsy-zero check)", () => {
		// The Sep 11 row has body_load: 0 -- a real "no elevated load" reading,
		// not a missing value, so it must count in the average.
		const onlyZero: SummaryRow[] = [
			{ night: "2026-01-01", std_drinks: 0, sleep_score: null, hrv_pct_baseline: null, body_load: 0, workouts: null },
		];
		expect(summarize(onlyZero).avg_body_load).toBe(0);
	});
});

describe("diffSummaries", () => {
	it("computes current-minus-previous for shared numeric fields", () => {
		const current = { avg_sleep_score: 70.7, nights: 31 };
		const previous = { avg_sleep_score: 83.4, nights: 14 };
		expect(diffSummaries(current, previous)).toEqual({
			avg_sleep_score: -12.7,
			nights: 17,
		});
	});

	it("skips non-numeric fields like workout_counts_by_type", () => {
		const current = { avg_sleep_score: 70, workout_counts_by_type: { RUNNING: 3 } };
		const previous = { avg_sleep_score: 60, workout_counts_by_type: { RUNNING: 1 } };
		expect(diffSummaries(current, previous)).toEqual({ avg_sleep_score: 10 });
	});

	it("skips fields missing from either side", () => {
		const current = { a: 5, b: 10 };
		const previous = { a: 2 };
		expect(diffSummaries(current, previous)).toEqual({ a: 3 });
	});
});
