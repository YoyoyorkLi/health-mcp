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
			current_state:
				"Runs on and off (the watch doesn't catch every session -- get_workouts undercounts real frequency). Recent logged runs (Sept 2026) were at 190-193 bpm, near max effort. 1-2 days/week for now, expected to climb closer to the race.",
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
