import { defaultSupabase } from '../lib/supabase.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../lib/types/database.types.js';

export const authService = {
	async signIn(email: string, password: string) {
		const { data, error } = await defaultSupabase.auth.signInWithPassword({
			email,
			password
		});
		if (error) throw error;
		return data;
	},

	async signOut(client: SupabaseClient<Database>) {
		const { error } = await client.auth.signOut();
		if (error) throw error;
	},

	async getSession(client: SupabaseClient<Database>) {
		const { data, error } = await client.auth.getSession();
		if (error) throw error;
		return data.session;
	},

	async getUser(client: SupabaseClient<Database>, token?: string) {
		if (token) {
			const { data, error } = await client.auth.getUser(token);
			if (error) throw error;
			return data.user;
		}
		const { data, error } = await client.auth.getUser();
		if (error) throw error;
		return data.user;
	}
};
