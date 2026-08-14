import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '../lib/types/database.types.js';

export type Category = Database['public']['Tables']['categories']['Row'];
export type InsertCategory = Database['public']['Tables']['categories']['Insert'];
export type UpdateCategory = Database['public']['Tables']['categories']['Update'];

export const categoryService = {
	async getCategories(client: SupabaseClient<Database>, onlyActive = false): Promise<Category[]> {
		let query = (client
			.from('categories') as any)
			.select('*')
			.order('name', { ascending: true });

		if (onlyActive) {
			query = query.eq('is_active', true);
		}

		const { data, error } = await query;
		if (error) throw error;
		return data || [];
	},

	async createCategory(
		client: SupabaseClient<Database>,
		user: User,
		payload: Omit<InsertCategory, 'user_id'>
	): Promise<Category> {
		const { data, error } = await (client
			.from('categories') as any)
			.insert({
				...payload,
				is_active: payload.is_active !== undefined ? payload.is_active : true,
				user_id: user.id
			})
			.select()
			.single();

		if (error) throw error;
		return data;
	},

	async updateCategory(
		client: SupabaseClient<Database>,
		id: string,
		payload: UpdateCategory
	): Promise<Category> {
		const { data, error } = await (client
			.from('categories') as any)
			.update(payload)
			.eq('id', id)
			.select()
			.single();

		if (error) throw error;
		return data;
	},

	async deleteCategory(client: SupabaseClient<Database>, id: string): Promise<void> {
		const { error } = await (client
			.from('categories') as any)
			.delete()
			.eq('id', id);

		if (error) throw error;
	}
};
