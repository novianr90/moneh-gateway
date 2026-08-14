import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';
import type { Database } from './types/database.types.js';

export const defaultSupabase = createClient<Database>(
	config.supabaseUrl,
	config.supabaseAnonKey
);

export function getSupabaseClient(accessToken?: string): SupabaseClient<Database> {
	if (!accessToken) {
		return defaultSupabase;
	}

	return createClient<Database>(config.supabaseUrl, config.supabaseAnonKey, {
		global: {
			headers: {
				Authorization: `Bearer ${accessToken}`
			}
		}
	});
}
