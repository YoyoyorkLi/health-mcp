// Thin PostgREST client for the `pulse` Supabase project.
//
// Auth model (see MCP-HEALTH-COACH-PLAN.md §2B): the Worker signs in as a
// dedicated read-only-in-practice Supabase Auth user via the password grant,
// then calls PostgREST with the resulting JWT. RLS on drinks/nights/
// sync_state/night_summary grants `select` to `authenticated` only -- the
// anon key alone cannot read any of this.
//
// The access token is cached at module scope for the lifetime of the Worker
// isolate. No refresh-token handling: a fresh sign-in happens whenever the
// cached token is missing or about to expire. Given the tiny request volume
// (a personal health coach queried a few times a day), that's cheaper to
// reason about than token refresh and costs nothing worth optimizing.
type SupabaseSession = {
	accessToken: string;
	expiresAt: number; // ms epoch
};

let cachedSession: SupabaseSession | null = null;

async function signIn(env: Env): Promise<string> {
	const now = Date.now();
	if (cachedSession && cachedSession.expiresAt - 30_000 > now) {
		return cachedSession.accessToken;
	}

	const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			apikey: env.SUPABASE_ANON_KEY,
		},
		body: JSON.stringify({
			email: env.SUPABASE_COACH_EMAIL,
			password: env.SUPABASE_COACH_PASSWORD,
		}),
	});

	if (!res.ok) {
		throw new Error(`Supabase sign-in failed (${res.status}): ${await res.text()}`);
	}

	const data = (await res.json()) as { access_token: string; expires_in: number };
	cachedSession = {
		accessToken: data.access_token,
		expiresAt: now + data.expires_in * 1000,
	};
	return cachedSession.accessToken;
}

/**
 * GET against PostgREST. `query` is everything after `night_summary?` --
 * e.g. `select=night,std_drinks&order=night.desc&limit=14`.
 */
export async function pgrest(env: Env, resource: string, query: string): Promise<any> {
	const token = await signIn(env);
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${resource}?${query}`, {
		headers: {
			apikey: env.SUPABASE_ANON_KEY,
			authorization: `Bearer ${token}`,
		},
	});

	if (!res.ok) {
		throw new Error(`Supabase query failed (${res.status}): ${await res.text()}`);
	}

	return res.json();
}
