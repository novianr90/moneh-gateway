import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '../lib/types/database.types.js';

export type PaymentMethodItem = Database['public']['Tables']['payment_methods']['Row'];
export type InsertPaymentMethodItem = Database['public']['Tables']['payment_methods']['Insert'];

const DEFAULT_PAYMENT_METHODS = ['Cash', 'QRIS', 'Credit Card', 'GoPay/OVO', 'Bank Transfer'];

export const paymentMethodService = {
	async getPaymentMethods(client: SupabaseClient<Database>, onlyActive = false): Promise<PaymentMethodItem[]> {
		try {
			let query = (client
				.from('payment_methods') as any)
				.select('*')
				.order('created_at', { ascending: true });

			if (onlyActive) {
				query = query.eq('is_active', true);
			}

			const { data, error } = await query;

			if (error) throw error;
			if (data && data.length > 0) {
				return data;
			}
		} catch (e: any) {
			console.warn('Could not fetch payment_methods table, using defaults:', e?.message);
		}

		// Fallback mock items if DB empty or uninitialized
		return DEFAULT_PAYMENT_METHODS.map((name, index) => ({
			id: `default-${index}`,
			user_id: 'default',
			name,
			is_active: true,
			is_credit_card: false,
			created_at: new Date().toISOString()
		}));
	},

	async createPaymentMethod(
		client: SupabaseClient<Database>,
		user: User,
		name: string
	): Promise<PaymentMethodItem> {
		const trimmedName = name.trim();
		if (!trimmedName) {
			throw new Error('PM001: Payment method name cannot be empty');
		}

		const { data, error } = await (client
			.from('payment_methods') as any)
			.insert({
				name: trimmedName,
				is_active: true,
				user_id: user.id
			})
			.select()
			.single();

		if (error) throw error;
		return data;
	},

	async deletePaymentMethod(client: SupabaseClient<Database>, id: string): Promise<void> {
		if (id.startsWith('default-')) {
			throw new Error('Default payment methods cannot be deleted directly');
		}

		const { error } = await (client
			.from('payment_methods') as any)
			.delete()
			.eq('id', id);

		if (error) throw error;
	},

	// Only is_credit_card is updatable here. `name` and `is_active` are one-way synced FROM
	// Actual Budget (see actualService.syncMasterDataToSupabase) - there is no reverse sync,
	// so editing them from Supabase would silently drift from the Actual account they mirror.
	// is_credit_card is a Supabase-only concept (Actual has no such flag), so it's conflict-free.
	async updatePaymentMethod(
		client: SupabaseClient<Database>,
		id: string,
		updates: { is_credit_card: boolean }
	): Promise<PaymentMethodItem> {
		if (id.startsWith('default-')) {
			throw new Error('Default payment methods cannot be updated directly');
		}

		if (typeof updates.is_credit_card !== 'boolean') {
			throw new Error('PM002: is_credit_card must be a boolean');
		}

		const { data, error } = await (client
			.from('payment_methods') as any)
			.update({ is_credit_card: updates.is_credit_card })
			.eq('id', id)
			.select()
			.single();

		if (error) throw error;
		return data;
	}
};
