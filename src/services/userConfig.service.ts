import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../lib/types/database.types.js';
import { config } from '../config/env.js';

export type UserConfiguration = Database['public']['Tables']['users_configurations']['Row'];

export const ACTUAL_SYNC_ID_MISSING_WARNING =
	'Your Actual sync ID is empty. Please set it up on the configuration page.';

export interface ActualAvailability {
	// True only when USE_ACTUAL=true AND the authenticated user has a non-blank actual_sync_id configured.
	available: boolean;
	actualSyncId: string | null;
	warning?: string;
}

export const userConfigService = {
	async getConfiguration(client: SupabaseClient<Database>, userId: string): Promise<UserConfiguration | null> {
		const { data, error } = await (client
			.from('users_configurations') as any)
			.select('*')
			.eq('user_id', userId)
			.maybeSingle();

		if (error) throw error;
		return data;
	},

	async getActualSyncId(client: SupabaseClient<Database>, userId: string): Promise<string | null> {
		const configuration = await this.getConfiguration(client, userId);
		const syncId = configuration?.actual_sync_id?.trim();
		return syncId ? syncId : null;
	},

	async upsertActualSyncId(
		client: SupabaseClient<Database>,
		userId: string,
		actualSyncId: string | null
	): Promise<UserConfiguration> {
		const trimmed = actualSyncId?.trim() || null;

		const { data, error } = await (client
			.from('users_configurations') as any)
			.upsert({ user_id: userId, actual_sync_id: trimmed }, { onConflict: 'user_id' })
			.select()
			.single();

		if (error) throw error;
		return data;
	},

	/**
	 * Sets/clears the category the user has designated as "Bills" (issue #7).
	 * A credit-card transaction's amount is added to this category's next-month budget.
	 */
	async upsertBillsCategoryId(
		client: SupabaseClient<Database>,
		userId: string,
		billsCategoryId: string | null
	): Promise<UserConfiguration> {
		const { data, error } = await (client
			.from('users_configurations') as any)
			.upsert({ user_id: userId, bills_category_id: billsCategoryId || null }, { onConflict: 'user_id' })
			.select()
			.single();

		if (error) throw error;
		return data;
	},

	async getBillsCategoryId(client: SupabaseClient<Database>, userId: string): Promise<string | null> {
		const configuration = await this.getConfiguration(client, userId);
		return configuration?.bills_category_id ?? null;
	},

	/**
	 * Resolves whether Actual Budget can be used for this user right now.
	 *
	 * - USE_ACTUAL=false (env)              -> unavailable, no warning (feature disabled outright).
	 * - USE_ACTUAL=true, actual_sync_id set -> available.
	 * - USE_ACTUAL=true, actual_sync_id blank -> unavailable, with a warning so callers can
	 *   behave like USE_ACTUAL=false but tell the user why (issue #2 follow-up).
	 */
	async resolveActualAvailability(client: SupabaseClient<Database>, userId: string): Promise<ActualAvailability> {
		if (!config.useActual) {
			return { available: false, actualSyncId: null };
		}

		const actualSyncId = await this.getActualSyncId(client, userId);
		if (!actualSyncId) {
			return { available: false, actualSyncId: null, warning: ACTUAL_SYNC_ID_MISSING_WARNING };
		}

		return { available: true, actualSyncId };
	}
};
