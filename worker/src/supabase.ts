// Thin PostgREST client for the `pulse` Supabase project.
//
// Auth model (see MCP-HEALTH-COACH-PLAN.md §2B): the Worker signs in as a
// dedicated read-only-in-practice Supabase Auth user via the password grant,
// then calls PostgREST with the resulting JWT. RLS on drinks/nights/
// sync_state/night_summary grants `select` to `authenticated` only -- the
// anon key alone cannot read any of this.
//
// The access token is cached two ways: a plain module-level variable for
// the fast path (no I/O at all when warm), backed by the calling Durable
// Object's own storage so the cache survives isolate churn -- a personal
// coach queried a few times a day plausibly never keeps one isolate warm
// long enough for a module-level-only cache to ever hit in practice. DO
// storage reads are a local, sub-millisecond op, not a network call, so
// checking it on a cold cache costs far less than a wasted Supabase
// sign-in would.
type SupabaseSession = {
	accessToken: string;
	expiresAt: number; // ms epoch
};

const SESSION_STORAGE_KEY = "supabase_session";

let memoryCache: SupabaseSession | null = null;

// Two tool calls landing close together with no cached (or expired) session
// would otherwise both pass the cache check before either's fetch resolves,
// firing duplicate sign-ins. Coalescing onto one in-flight promise means the
// second caller awaits the first's request instead of starting its own.
let signInPromise: Promise<string> | null = null;

function isFresh(session: SupabaseSession | null | undefined, now: number): session is SupabaseSession {
	return !!session && session.expiresAt - 30_000 > now;
}

async function signIn(env: Env, storage: DurableObjectStorage): Promise<string> {
	const now = Date.now();
	if (isFresh(memoryCache, now)) {
		return memoryCache.accessToken;
	}

	const stored = await storage.get<SupabaseSession>(SESSION_STORAGE_KEY);
	if (isFresh(stored, now)) {
		memoryCache = stored;
		return stored.accessToken;
	}

	if (!signInPromise) {
		signInPromise = doSignIn(env, storage).finally(() => {
			signInPromise = null;
		});
	}
	return signInPromise;
}

async function doSignIn(env: Env, storage: DurableObjectStorage): Promise<string> {
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
	const session: SupabaseSession = {
		accessToken: data.access_token,
		expiresAt: Date.now() + data.expires_in * 1000,
	};
	memoryCache = session;
	await storage.put(SESSION_STORAGE_KEY, session);
	return session.accessToken;
}

/**
 * Build a PostgREST query string from `[key, value]` pairs, e.g.
 * `[["select", "night,workouts"], ["night", "gte.2026-01-01"]]` ->
 * `select=night%2Cworkouts&night=gte.2026-01-01`.
 *
 * Pairs, not an object: PostgREST ANDs repeated filters on the same column
 * (`night=gte.X&night=lte.Y` means "between X and Y"), which a plain object
 * can't represent since its keys must be unique.
 *
 * Every value is encoded via URLSearchParams -- earlier versions of this
 * client built query strings with raw template-literal interpolation, which
 * was only safe because every caller happened to validate its inputs first.
 * This is the actual defense: a value containing `&`/`=`/etc. can no longer
 * break or redirect the query, regardless of what validation a future tool
 * does or doesn't add upstream.
 */
export function buildQuery(params: Array<[string, string]>): string {
	const search = new URLSearchParams();
	for (const [key, value] of params) search.append(key, value);
	return search.toString();
}

/** GET against PostgREST. `resource` is the table/view, `query` from buildQuery(). */
export async function pgrest(
	env: Env,
	storage: DurableObjectStorage,
	resource: string,
	query: string,
): Promise<any> {
	const token = await signIn(env, storage);
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
