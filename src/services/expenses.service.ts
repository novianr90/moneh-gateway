import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '../lib/types/database.types.js';
import { actualService } from './actual.service.js';
import { userConfigService } from './userConfig.service.js';

export type Expense = Database['public']['Tables']['expenses']['Row'];
export type InsertExpense = Database['public']['Tables']['expenses']['Insert'];
export type UpdateExpense = Database['public']['Tables']['expenses']['Update'];
export type RecentExpenseView = Database['public']['Views']['recent_expenses']['Row'];

export interface MonthlySummary {
	total_amount: number;
	transaction_count: number;
	prev_month_total: number;
}

export interface CategoryBreakdown {
	category_id: string;
	category_name: string;
	color: string;
	icon: string;
	total_amount: number;
}

export interface DailyTrendPoint {
	expense_date: string;
	daily_total: number;
	cumulative_total: number;
}

export interface ExpenseFilters {
	startDate?: string;
	endDate?: string;
	categoryId?: string;
	paymentMethod?: string;
	searchKey?: string;
	page?: number;
	pageSize?: number;
}

export interface PaginatedExpenses {
	data: RecentExpenseView[];
	totalCount: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

export interface ExpenseOperationResult {
	expense: Expense;
	statusCode: 200 | 201 | 202 | 409;
	message?: string;
	cached?: boolean;
	// Present when USE_ACTUAL=true but the user has no actual_sync_id configured yet (issue #2).
	warning?: string;
}

export const expenseService = {
	/**
	 * Auto-Adjust Bills on Next-Month (issue #7). Best-effort/non-blocking: called after an
	 * expense has already synced successfully to Actual - a failure here must never fail the
	 * expense creation, so all errors are swallowed and logged as a warning.
	 */
	async adjustBillsBudgetIfCreditCard(
		client: SupabaseClient<Database>,
		userId: string,
		actualSyncId: string,
		expense: Pick<Expense, 'payment_method' | 'amount' | 'expense_date'>
	): Promise<void> {
		try {
			const { data: paymentMethod } = await (client
				.from('payment_methods') as any)
				.select('is_credit_card')
				.eq('user_id', userId)
				.eq('name', expense.payment_method)
				.maybeSingle();

			if (!paymentMethod?.is_credit_card) return;

			const billsCategoryId = await userConfigService.getBillsCategoryId(client, userId);
			if (!billsCategoryId) return; // Not configured yet - skip silently.

			const { data: billsCategory } = await (client
				.from('categories') as any)
				.select('name')
				.eq('id', billsCategoryId)
				.maybeSingle();

			if (!billsCategory?.name) return;

			await actualService.adjustNextMonthBudget(
				actualSyncId,
				billsCategory.name,
				expense.amount,
				expense.expense_date
			);
		} catch (e: any) {
			console.warn('Failed to auto-adjust Bills budget for credit-card expense:', e?.message);
		}
	},

	async getExpenses(
		client: SupabaseClient<Database>,
		user: User,
		filters?: ExpenseFilters
	): Promise<PaginatedExpenses> {
		const page = filters?.page && filters.page > 0 ? filters.page : 1;
		const pageSize = filters?.pageSize && filters.pageSize > 0 ? filters.pageSize : 25;
		const from = (page - 1) * pageSize;
		const to = from + pageSize - 1;

		let query = (client
			.from('recent_expenses') as any)
			.select('*', { count: 'exact' })
			.eq('user_id', user.id)
			.order('expense_date', { ascending: false });

		if (filters?.startDate) {
			query = query.gte('expense_date', filters.startDate);
		}
		if (filters?.endDate) {
			query = query.lte('expense_date', filters.endDate);
		}
		if (filters?.categoryId) {
			query = query.eq('category_name', filters.categoryId);
		}
		if (filters?.paymentMethod) {
			query = query.eq('payment_method', filters.paymentMethod);
		}
		if (filters?.searchKey) {
			query = query.ilike('description', `%${filters.searchKey}%`);
		}

		query = query.range(from, to);

		const { data, error, count } = await query;
		if (error) throw error;

		const totalCount = count || 0;
		const totalPages = Math.ceil(totalCount / pageSize) || 1;

		return {
			data: data || [],
			totalCount,
			page,
			pageSize,
			totalPages
		};
	},

	/**
	 * Saga Dual-Write Expense Creation Flow (§6.2)
	 */
	async createExpense(
		client: SupabaseClient<Database>,
		user: User,
		payload: Omit<InsertExpense, 'user_id'>,
		idempotencyKeyInput?: string
	): Promise<ExpenseOperationResult> {
		if (payload.amount <= 0) {
			throw new Error('EXP002: Expense amount must be greater than 0');
		}

		const idempotencyKey = idempotencyKeyInput?.trim() || `moneh-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

		// Resolved once up-front: USE_ACTUAL=false, or true but this user has no actual_sync_id
		// configured yet (issue #2), both fall back to "disabled" behavior with an optional warning.
		const availability = await userConfigService.resolveActualAvailability(client, user.id);

		// ==========================================
		// Phase 0: Idempotency Check (§6.1)
		// ==========================================
		const { data: existing } = await (client
			.from('expenses') as any)
			.select('*')
			.eq('idempotency_key', idempotencyKey)
			.maybeSingle();

		if (existing) {
			if (existing.sync_status === 'SYNCED') {
				return {
					expense: existing,
					statusCode: 201,
					cached: true,
					message: 'Cached response (already synced)'
				};
			}

			if (['PENDING', 'RECONCILIATION_REQUIRED', 'ROLLBACK_PENDING'].includes(existing.sync_status)) {
				return {
					expense: existing,
					statusCode: 409,
					message: `Operation currently in progress (status: ${existing.sync_status})`
				};
			}

			if (existing.sync_status === 'SYNC_FAILED') {
				if (existing.sync_failure_type === 'DEFINITE_FAILURE') {
					// Safe partial retry
					if (!availability.available) {
						throw new Error(
							availability.warning
								? `ACT007: ${availability.warning}`
								: 'ACT007: Actual Budget synchronization is disabled (USE_ACTUAL=false)'
						);
					}
					return await this.retryDefiniteFailure(client, existing, availability.actualSyncId!);
				} else {
					// RECONCILIATION_EXHAUSTED -> must route to reconciliation
					const { data: updated } = await (client
						.from('expenses') as any)
						.update({
							sync_status: 'RECONCILIATION_REQUIRED',
							sync_failure_type: null,
							sync_error: null,
							updated_at: new Date().toISOString()
						})
						.eq('id', existing.id)
						.select()
						.single();

					return {
						expense: updated || existing,
						statusCode: 202,
						message: 'Reconciliation required before retry'
					};
				}
			}
		}

		// If Actual Budget integration is disabled (USE_ACTUAL=false), or enabled but this
		// user has no actual_sync_id configured yet, behave like it's disabled - just surface
		// a warning in the latter case so the client can point the user at the config page.
		if (!availability.available) {
			const { data: insertedExpense, error: insertError } = await (client
				.from('expenses') as any)
				.insert({
					...payload,
					payee: payload.payee ? payload.payee.trim() : null,
					user_id: user.id,
					sync_status: 'PENDING',
					is_upload: payload.is_upload || 'N',
					idempotency_key: idempotencyKey
				})
				.select()
				.single();

			if (insertError) {
				throw new Error(`DB001: Failed to create expense record in Supabase: ${insertError.message}`);
			}

			return {
				expense: insertedExpense,
				statusCode: 201,
				warning: availability.warning
			};
		}

		const actualSyncId = availability.actualSyncId!;

		// ==========================================
		// Phase 1: Payee Master-Data Resolution (§6.2 Phase 1)
		// ==========================================
		const payeeName = (payload.payee || payload.description || 'General').trim();
		try {
			await actualService.resolveOrCreatePayee(actualSyncId, payeeName);
		} catch (payeeErr: any) {
			throw new Error(`ACT004: Payee master-data resolution failed: ${payeeErr.message}`);
		}

		// ==========================================
		// Phase 2: Operational Store Record Creation (§6.2 Phase 2)
		// ==========================================
		const { data: insertedExpense, error: insertError } = await (client
			.from('expenses') as any)
			.insert({
				...payload,
				payee: payload.payee ? payload.payee.trim() : null,
				user_id: user.id,
				sync_status: 'PENDING',
				is_upload: payload.is_upload || 'N',
				idempotency_key: idempotencyKey
			})
			.select()
			.single();

		if (insertError) {
			throw new Error(`DB001: Failed to create expense record in Supabase: ${insertError.message}`);
		}

		// Fetch Category Name if category_id provided
		let categoryName: string | undefined = undefined;
		if (insertedExpense.category_id) {
			const { data: catData } = await (client
				.from('categories') as any)
				.select('name')
				.eq('id', insertedExpense.category_id)
				.maybeSingle();
			categoryName = catData?.name;
		}

		// ==========================================
		// Phase 3: Financial System of Record Write (§6.2 Phase 3)
		// ==========================================
		try {
			const txResult = await actualService.createTransaction(actualSyncId, {
				expense_id: insertedExpense.id,
				idempotency_key: idempotencyKey,
				account_name: insertedExpense.payment_method || 'Cash',
				payee_name: payeeName,
				category_name: categoryName,
				amount: insertedExpense.amount,
				expense_date: insertedExpense.expense_date,
				notes: insertedExpense.description || undefined
			});

			// Auto-Adjust Bills on Next-Month (issue #7) - best-effort, non-blocking.
			await this.adjustBillsBudgetIfCreditCard(client, user.id, actualSyncId, insertedExpense);

			// Option A: Definite Success
			const { data: syncedRecord, error: updateError } = await (client
				.from('expenses') as any)
				.update({
					actual_transaction_id: txResult.actual_transaction_id,
					sync_status: 'SYNCED',
					synced_at: new Date().toISOString(),
					sync_error: null,
					sync_failure_type: null,
					updated_at: new Date().toISOString()
				})
				.eq('id', insertedExpense.id)
				.select()
				.single();

			if (updateError || !syncedRecord) {
				return {
					expense: insertedExpense,
					statusCode: 202,
					message: 'Actual Budget transaction created; Supabase state update pending reconciliation'
				};
			}

			return {
				expense: syncedRecord,
				statusCode: 201
			};
		} catch (actualErr: any) {
			const errMsg = actualErr.message || 'Unknown Actual Budget error';
			const isDefinite = errMsg.includes('ACT002') || errMsg.includes('ACT003') || errMsg.includes('validation') || errMsg.includes('400');

			if (isDefinite) {
				// Option B: Definite Failure Compensation (§6.4)
				await (client
					.from('expenses') as any)
					.update({
						sync_status: 'ROLLBACK_PENDING',
						sync_error: errMsg,
						updated_at: new Date().toISOString()
					})
					.eq('id', insertedExpense.id);

				const { data: failedRecord } = await (client
					.from('expenses') as any)
					.update({
						sync_status: 'SYNC_FAILED',
						sync_failure_type: 'DEFINITE_FAILURE',
						updated_at: new Date().toISOString()
					})
					.eq('id', insertedExpense.id)
					.select()
					.single();

				throw new Error(`ACT005: Actual Budget rejected transaction: ${errMsg}`);
			} else {
				// Option C: Ambiguous Failure / Timeout (§7.1)
				const { data: ambiguousRecord } = await (client
					.from('expenses') as any)
					.update({
						sync_status: 'RECONCILIATION_REQUIRED',
						sync_error: `Ambiguous failure/timeout: ${errMsg}`,
						updated_at: new Date().toISOString()
					})
					.eq('id', insertedExpense.id)
					.select()
					.single();

				return {
					expense: ambiguousRecord || insertedExpense,
					statusCode: 202,
					message: 'Transaction write timed out or ambiguous; queued for background reconciliation'
				};
			}
		}
	},

	/**
	 * Partial Saga Retry for DEFINITE_FAILURE (§6.3.A)
	 */
	async retryDefiniteFailure(client: SupabaseClient<Database>, existing: Expense, actualSyncId: string): Promise<ExpenseOperationResult> {
		// 1. Reset state to PENDING
		await (client
			.from('expenses') as any)
			.update({
				sync_status: 'PENDING',
				sync_failure_type: null,
				sync_error: null,
				synced_at: null,
				updated_at: new Date().toISOString()
			})
			.eq('id', existing.id);

		// 2. Resolve Payee
		const payeeName = (existing.payee || existing.description || 'General').trim();
		await actualService.resolveOrCreatePayee(actualSyncId, payeeName);

		// Resolve category name
		let categoryName: string | undefined = undefined;
		if (existing.category_id) {
			const { data: catData } = await (client
				.from('categories') as any)
				.select('name')
				.eq('id', existing.category_id)
				.maybeSingle();
			categoryName = catData?.name;
		}

		// 3. Write to Actual Budget
		try {
			const txResult = await actualService.createTransaction(actualSyncId, {
				expense_id: existing.id,
				idempotency_key: existing.idempotency_key || `moneh-${existing.id}`,
				account_name: existing.payment_method || 'Cash',
				payee_name: payeeName,
				category_name: categoryName,
				amount: existing.amount,
				expense_date: existing.expense_date,
				notes: existing.description || undefined
			});

			// Auto-Adjust Bills on Next-Month (issue #7) - best-effort, non-blocking.
			await this.adjustBillsBudgetIfCreditCard(client, existing.user_id, actualSyncId, existing);

			const { data: syncedRecord } = await (client
				.from('expenses') as any)
				.update({
					actual_transaction_id: txResult.actual_transaction_id,
					sync_status: 'SYNCED',
					synced_at: new Date().toISOString(),
					sync_error: null,
					sync_failure_type: null,
					updated_at: new Date().toISOString()
				})
				.eq('id', existing.id)
				.select()
				.single();

			return {
				expense: syncedRecord || existing,
				statusCode: 201
			};
		} catch (retryErr: any) {
			const errMsg = retryErr.message || 'Retry write failed';
			await (client
				.from('expenses') as any)
				.update({
					sync_status: 'SYNC_FAILED',
					sync_failure_type: 'DEFINITE_FAILURE',
					sync_error: errMsg,
					updated_at: new Date().toISOString()
				})
				.eq('id', existing.id);

			throw new Error(`ACT006: Retry write rejected by Actual Budget: ${errMsg}`);
		}
	},

	/**
	 * Explicit retry endpoint logic for a specific expense ID.
	 */
	async retryExpense(client: SupabaseClient<Database>, user: User, expenseId: string): Promise<ExpenseOperationResult> {
		const availability = await userConfigService.resolveActualAvailability(client, user.id);
		if (!availability.available) {
			throw new Error(
				availability.warning
					? `ACT007: ${availability.warning}`
					: 'ACT007: Actual Budget synchronization is disabled (USE_ACTUAL=false)'
			);
		}

		const { data: existing, error } = await (client
			.from('expenses') as any)
			.select('*')
			.eq('id', expenseId)
			.eq('user_id', user.id)
			.maybeSingle();

		if (error || !existing) {
			throw new Error('EXP004: Expense not found');
		}

		if (existing.sync_status !== 'SYNC_FAILED') {
			throw new Error(`EXP005: Only expenses with SYNC_FAILED status can be retried (current: ${existing.sync_status})`);
		}

		if (existing.sync_failure_type === 'DEFINITE_FAILURE') {
			return await this.retryDefiniteFailure(client, existing, availability.actualSyncId!);
		} else {
			// RECONCILIATION_EXHAUSTED -> Transition to RECONCILIATION_REQUIRED
			const { data: updated } = await (client
				.from('expenses') as any)
				.update({
					sync_status: 'RECONCILIATION_REQUIRED',
					sync_failure_type: null,
					sync_error: null,
					updated_at: new Date().toISOString()
				})
				.eq('id', existing.id)
				.select()
				.single();

			return {
				expense: updated || existing,
				statusCode: 202,
				message: 'Reconciliation required before retry. Queued for background reconciliation.'
			};
		}
	},

	async updateExpense(
		client: SupabaseClient<Database>,
		id: string,
		payload: UpdateExpense
	): Promise<Expense> {
		if (payload.amount !== undefined && payload.amount <= 0) {
			throw new Error('EXP002: Expense amount must be greater than 0');
		}

		// Prevent editing expenses that are already synced to Google Sheets
		const { data: existing } = await (client
			.from('expenses') as any)
			.select('user_id, is_upload, sync_status, actual_transaction_id, idempotency_key')
			.eq('id', id)
			.maybeSingle();

		if (existing?.is_upload === 'Y') {
			throw new Error('EXP003: Cannot edit an expense that has already been synced to Google Sheets');
		}

		if (existing?.actual_transaction_id) {
			const availability = await userConfigService.resolveActualAvailability(client, existing.user_id);
			if (availability.available) {
				try {
					let categoryName: string | undefined = undefined;
					if (payload.category_id) {
						const { data: catData } = await (client
							.from('categories') as any)
							.select('name')
							.eq('id', payload.category_id)
							.maybeSingle();
						categoryName = catData?.name;
					}

					await actualService.updateTransaction(availability.actualSyncId!, existing.actual_transaction_id, {
						account_name: payload.payment_method,
						payee_name: payload.payee || payload.description || undefined,
						category_name: categoryName,
						amount: payload.amount,
						expense_date: payload.expense_date,
						notes: payload.description || undefined,
						expense_id: id,
						idempotency_key: existing.idempotency_key || `moneh-${id}`
					});
				} catch (e: any) {
					console.warn('Failed to update transaction in Actual Budget:', e?.message);
				}
			}
		}

		const { data, error } = await (client
			.from('expenses') as any)
			.update({
				...payload,
				updated_at: new Date().toISOString()
			})
			.eq('id', id)
			.select()
			.single();

		if (error) throw error;
		return data;
	},

	async deleteExpense(client: SupabaseClient<Database>, id: string): Promise<void> {
		const { data: existing } = await (client
			.from('expenses') as any)
			.select('user_id, actual_transaction_id')
			.eq('id', id)
			.maybeSingle();

		if (existing?.actual_transaction_id) {
			const availability = await userConfigService.resolveActualAvailability(client, existing.user_id);
			if (availability.available) {
				try {
					await actualService.deleteTransaction(availability.actualSyncId!, existing.actual_transaction_id);
				} catch (e: any) {
					console.warn('Failed to delete transaction in Actual Budget:', e?.message);
				}
			}
		}

		const { error } = await (client
			.from('expenses') as any)
			.delete()
			.eq('id', id);

		if (error) throw error;
	},

	async getMonthlySummary(
		client: SupabaseClient<Database>,
		month?: string
	): Promise<MonthlySummary> {
		const { data, error } = await (client as any).rpc('get_monthly_summary', {
			p_month: month
		});

		if (error) throw error;
		if (data && data.length > 0) {
			return {
				total_amount: Number(data[0].total_amount),
				transaction_count: Number(data[0].transaction_count),
				prev_month_total: Number(data[0].prev_month_total)
			};
		}
		return { total_amount: 0, transaction_count: 0, prev_month_total: 0 };
	},

	async getMonthlyCategoryBreakdown(
		client: SupabaseClient<Database>,
		month?: string
	): Promise<CategoryBreakdown[]> {
		const { data, error } = await (client as any).rpc('get_monthly_category_breakdown', {
			p_month: month
		});

		if (error) throw error;
		return (data || []).map((row: any) => ({
			...row,
			total_amount: Number(row.total_amount)
		}));
	},

	async getRecentTransactions(
		client: SupabaseClient<Database>,
		limit = 10
	): Promise<RecentExpenseView[]> {
		const { data, error } = await (client as any).rpc('get_recent_transactions', {
			p_limit: limit
		});

		if (error) throw error;
		return data || [];
	},

	async getDailyExpenseTrends(
		client: SupabaseClient<Database>,
		month?: string
	): Promise<DailyTrendPoint[]> {
		const { data, error } = await (client as any).rpc('get_daily_expense_trends', {
			p_month: month
		});

		if (error) throw error;
		return (data || []).map((row: any) => ({
			expense_date: row.expense_date,
			daily_total: Number(row.daily_total),
			cumulative_total: Number(row.cumulative_total)
		}));
	},

	async getPayees(client: SupabaseClient<Database>, user: User): Promise<string[]> {
		const payeeSet = new Set<string>();

		// 1. Fetch from Actual Budget if enabled and configured for this user
		const availability = await userConfigService.resolveActualAvailability(client, user.id);
		if (availability.available) {
			try {
				const actualPayees = await actualService.getPayees(availability.actualSyncId!);
				actualPayees.forEach((p) => {
					if (p && p.trim()) payeeSet.add(p.trim());
				});
			} catch (e: any) {
				console.warn('Could not load payees from Actual Budget:', e?.message);
			}
		}

		// 2. Fetch distinct payees from Supabase expenses
		try {
			const { data, error } = await (client
				.from('expenses') as any)
				.select('payee')
				.eq('user_id', user.id)
				.not('payee', 'is', null);

			if (!error && data) {
				data.forEach((row: { payee: string | null }) => {
					if (row.payee && row.payee.trim()) {
						payeeSet.add(row.payee.trim());
					}
				});
			}
		} catch (e: any) {
			console.warn('Could not load payees from Supabase expenses:', e?.message);
		}

		return Array.from(payeeSet).sort((a, b) => a.localeCompare(b));
	}
};
