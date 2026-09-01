import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';
import type { Database } from './types/database.types.js';

// Known Supabase-side bug: PostgREST's cached clock occasionally lags behind a freshly
// issued JWT's `iat`, rejecting otherwise-valid requests with PGRST303 "JWT issued at future".
// Affects every PostgREST call (any table, any client), not just auth. Tracked upstream:
// https://github.com/orgs/supabase/discussions/48123
// Workaround: transparently replay the exact same request once, after a short delay, so the
// validator's clock has time to catch up. Wired in once here via `global.fetch` so it covers
// every Supabase client/query in the app without touching individual service call sites.
async function fetchWithClockSkewRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const res = await fetch(input, init);

	if (res.status === 500) {
		const body = await res.clone().text().catch(() => '');
		if (body.includes('PGRST303') || /issued at future/i.test(body)) {
			console.warn('Clock drift detected (PGRST303), retrying request in 3s...');
			await new Promise((resolve) => setTimeout(resolve, 3000));
			return fetch(input, init);
		}
	}

	return res;
}

export const defaultSupabase = createClient<Database>(config.supabaseUrl, config.supabaseAnonKey, {
	global: {
		fetch: fetchWithClockSkewRetry
	}
});

export function getSupabaseClient(accessToken?: string): SupabaseClient<Database> {
	if (!accessToken) {
		return defaultSupabase;
	}

	return createClient<Database>(config.supabaseUrl, config.supabaseAnonKey, {
		global: {
			fetch: fetchWithClockSkewRetry,
			headers: {
				Authorization: `Bearer ${accessToken}`
			}
		}
	});
}
