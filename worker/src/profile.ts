// Static, hand-maintained context about who this coach is for. Not derived
// from Supabase -- there's no "athlete profile" table, this is just a fact
// sheet the coach can pull up to reason about goals/constraints alongside
// the physiological data the other tools return.
//
// `as_of` exists because none of this is computed -- age, training goals,
// and injury status all drift with time, and a hardcoded age in particular
// would silently go wrong in exactly one year. Storing the date this was
// last confirmed true (rather than e.g. a guessed birth year) means a stale
// entry is visible instead of silently trusted forever. Update this file
// (and as_of) whenever any of it changes.
export const ATHLETE_PROFILE = {
	as_of: "2026-09-12",
	age: 22,
	life_stage: "Senior in college",
	activity_level: "Very active: lifts, runs, and drinks regularly",

	training: {
		half_marathon: {
			target_month: "April 2027",
			first_half_marathon: true,
			goal: "Sub-2:00 -- self-described as ambitious for a first half marathon",
			has_structured_plan: "See get_training_plan for the full phase-by-phase build.",
		},
		disciplines: ["running", "lifting"],
	},

	injuries: [
		{
			description:
				"Severe right ankle sprain, September 2025. Still clicks/pops on rotation as of this writing. Actively rehabbing and improving.",
			coaching_relevance:
				"Weigh running-volume/intensity advice against this, especially as half-marathon training ramps up. Recurring right-ankle pain, swelling, or instability (not just the click) is worth backing off for, not pushing through.",
		},
	],

	coaching_guidance: {
		drinking:
			"Flag it when drinking appears to be hurting training or recovery (elevated body_load, depressed HRV, poor sleep) rather than reporting the dose-response data neutrally. Don't moralize about drinking itself -- only speak up when it's actually costing training or recovery.",
	},
} as const;

// The half-marathon build, phase by phase. Written 2026-09-12 from a
// baseline of ~0 runs in the prior 11 months, two recent ~5K efforts at
// 190-193 bpm (essentially redline the whole way, against a 193 hrmax), and
// a right ankle still being rehabbed (see ATHLETE_PROFILE.injuries). HR
// zones are derived from that same 193 hrmax.
//
// `as_of` for the same staleness reason as ATHLETE_PROFILE. This plan is a
// living document -- update `current_phase`, weekly frequency, and the
// week-24 decision as reality diverges from the plan, don't let the coach
// keep citing a phase that's already passed.
export const TRAINING_PLAN = {
	as_of: "2026-09-12",
	race: {
		event: "Half marathon",
		distance_km: 21.1,
		target_month: "2027-04",
		first_half_marathon: true,
		goal_time: "2:00:00",
		goal_pace_per_km: "5:41",
		goal_confidence:
			"Contingent on frequency actually climbing from 1-2 days/week to 3-4 by the base-building phase, as planned. Week 24's goal-pace segments are the real test -- retarget to a strong-finish goal if they push into Z5 instead of holding Z3-Z4.",
	},

	plan_start: "2026-09-14",
	current_phase: "Reintroduction",

	hr_zones_bpm: {
		z1_recovery: [97, 116],
		z2_easy: [116, 135],
		z3_steady: [135, 154],
		z4_tempo_threshold: [154, 174],
		z5_max: [174, 193],
	},

	phases: [
		{
			name: "Reintroduction",
			weeks: [1, 10],
			calendar: "mid-Sep to late-Nov 2026",
			frequency_per_week: "1-2",
			focus:
				"Rebuild the aerobic base at Z1-Z2 only (<135 bpm), not a mileage plan yet. No pace targets. Walk/run structure is expected, not a failure.",
			session_length_min: [15, 35],
			strength: "2x/week: calf raises 3x15, single-leg balance 3x30s/side, ankle circles",
			exit_criteria: "35 min continuous running, staying under ~145 bpm",
		},
		{
			name: "Base building",
			weeks: [11, 20],
			calendar: "Dec 2026 to mid-Feb 2027",
			frequency_per_week: "2-3, climbing as schedule allows",
			focus:
				"Still overwhelmingly Z2 easy. Long run grows 40 -> 75 min. Weekly strides (6x20s relaxed pickups) for turnover, not intensity.",
			strength: "2x/week: ankle + hip",
			exit_criteria: "10K continuous at conversational effort",
		},
		{
			name: "Specific build",
			weeks: [21, 26],
			calendar: "mid-Feb to late-Mar 2027",
			frequency_per_week: "3-4",
			focus:
				"Long run to 14-17K. First goal-pace work: 15-20 min at 5:41/km embedded inside an otherwise-easy run.",
			decision_point:
				"Week 24: if goal-pace segments hold in Z3-Z4, keep sub-2:00. If they push into Z5 like the pre-plan 5Ks did, retarget to a strong-finish goal instead.",
		},
		{
			name: "Peak and taper",
			weeks: [27, 30],
			calendar: "early to mid-Apr 2027",
			focus:
				"Longest run (16-18K) at week 27, then -30% volume week 28, -50% week 29, short shakeouts plus rest in race week.",
		},
	],

	rules: [
		"Zone 2 means Zone 2 -- slower than feels productive is the training effect, not underperformance.",
		"Ankle work happens before every run, not after or 'if there's time'.",
		"Instability or swelling stops the session that day, no exceptions. The known ankle click alone does not.",
		"When life cuts into training time, frequency drops before intensity does -- keep the long run, skip an easy day first.",
		"Alcohol the night before a long run or a goal-pace session blunts it -- save heavier drinking nights for after a key session, not before.",
	],
} as const;
