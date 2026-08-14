import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, SyncStatus, SyncFailureType } from '../lib/types/database.types.js';
import { actualService } from './actual.service.js';
import { config } from '../config/env.js';

export interface ReconciliationReport {
	scanned: number;
	resolvedSynced: number;
	advancedToPending: number;
	markedFailedDefinite: number;
	exhausted: number;
	errors: Array<{ expenseId: string; error: string }>;
}

interface ReconciliationRecord {
	id: string;
	user_id: string;
	category_id: string;
	amount: number;
	description: string;
	expense_date: string;
	payment_method: string;
	is_upload: string;
	actual_transaction_id: string | null;
	sync_status: SyncStatus;
	sync_failure_type: SyncFailureType;
	sync_error: string | null;
	idempotency_key: string | null;
	updated_at: string;
}

class ReconciliationService {
	private isRunning = false;
	private intervalHandle: NodeJS.Timeout | null = null;

	/**
	 * Runs a single reconciliation cycle across all pending/ambiguous records in Supabase.
	 */
	public async reconcileExpenses(client: SupabaseClient<Database>): Promise<ReconciliationReport> {
		if (this.isRunning) {
			return {
				scanned: 0,
				resolvedSynced: 0,
				advancedToPending: 0,
				markedFailedDefinite: 0,
				exhausted: 0,
				errors: [{ expenseId: 'ALL', error: 'Reconciliation is already running' }]
			};
		}

		this.isRunning = true;
		const report: ReconciliationReport = {
			scanned: 0,
			resolvedSynced: 0,
			advancedToPending: 0,
			markedFailedDefinite: 0,
			exhausted: 0,
			errors: []
		};

		try {
			const gracePeriodDate = new Date(Date.now() - config.reconciliationGracePeriodMs).toISOString();

			// 1. Fetch expenses needing reconciliation past grace period
			const { data: records, error } = await (client
				.from('expenses') as any)
				.select(`
					id,
					user_id,
					category_id,
					amount,
					description,
					expense_date,
					payment_method,
					is_upload,
					actual_transaction_id,
					sync_status,
					sync_failure_type,
					sync_error,
					idempotency_key,
					updated_at
				`)
				.in('sync_status', ['RECONCILIATION_REQUIRED', 'PENDING', 'ROLLBACK_PENDING'])
				.lte('updated_at', gracePeriodDate)
				.limit(50);

			if (error) {
				throw new Error(`REC001: Failed to query expenses for reconciliation: ${error.message}`);
			}

			const typedRecords = (records || []) as ReconciliationRecord[];

			if (typedRecords.length === 0) {
				return report;
			}

			report.scanned = typedRecords.length;

			// Fetch category map for category name resolution if needed
			const { data: categoryList } = await (client.from('categories') as any).select('id, name');
			const categoryMap = new Map((categoryList || []).map((c: any) => [c.id, c.name]));

			// 2. Process each record
			for (const expense of typedRecords) {
				try {
					// Case A: Gateway crashed between setting ROLLBACK_PENDING and SYNC_FAILED (§7.3.a)
					if (expense.sync_status === 'ROLLBACK_PENDING') {
						await (client
							.from('expenses') as any)
							.update({
								sync_status: 'SYNC_FAILED',
								sync_failure_type: 'DEFINITE_FAILURE',
								updated_at: new Date().toISOString()
							})
							.eq('id', expense.id);

						report.markedFailedDefinite++;
						continue;
					}

					const idempotencyKey = expense.idempotency_key || `moneh-${expense.id}`;

					// Case B: Search Actual Budget for existing matching transaction via correlation notes (§7.3.c)
					const matched = await actualService.findTransactionByCorrelation(
						expense.payment_method,
						expense.id,
						idempotencyKey,
						expense.expense_date
					);

					if (matched) {
						// Matched in Actual Budget -> mark SYNCED (§7.3.d)
						await (client
							.from('expenses') as any)
							.update({
								actual_transaction_id: matched.id,
								sync_status: 'SYNCED',
								sync_failure_type: null,
								sync_error: null,
								synced_at: new Date().toISOString(),
								updated_at: new Date().toISOString()
							})
							.eq('id', expense.id);

						report.resolvedSynced++;
						continue;
					}

					// Case C: No match found in Actual Budget (§7.3.e)
					if (expense.sync_status === 'RECONCILIATION_REQUIRED') {
						// Confirmed missing in Actual Budget -> transition to PENDING so partial retry is safe
						await (client
							.from('expenses') as any)
							.update({
								sync_status: 'PENDING',
								sync_failure_type: null,
								sync_error: null,
								updated_at: new Date().toISOString()
							})
							.eq('id', expense.id);

						report.advancedToPending++;
					} else if (expense.sync_status === 'PENDING') {
						// Stale PENDING -> Attempt direct Actual Budget write
						try {
							const categoryName = categoryMap.get(expense.category_id) as string | undefined;
							const txResult = await actualService.createTransaction({
								expense_id: expense.id,
								idempotency_key: idempotencyKey,
								account_name: expense.payment_method,
								payee_name: expense.description || 'General',
								category_name: categoryName,
								amount: expense.amount,
								expense_date: expense.expense_date
							});

							await (client
								.from('expenses') as any)
								.update({
									actual_transaction_id: txResult.actual_transaction_id,
									sync_status: 'SYNCED',
									sync_failure_type: null,
									sync_error: null,
									synced_at: new Date().toISOString(),
									updated_at: new Date().toISOString()
								})
								.eq('id', expense.id);

							report.resolvedSynced++;
						} catch (writeErr: any) {
							// Check failure type
							const isDefinite = writeErr.message && (writeErr.message.includes('ACT002') || writeErr.message.includes('validation'));
							if (isDefinite) {
								await (client
									.from('expenses') as any)
									.update({
										sync_status: 'SYNC_FAILED',
										sync_failure_type: 'DEFINITE_FAILURE',
										sync_error: writeErr.message,
										updated_at: new Date().toISOString()
									})
									.eq('id', expense.id);
								report.markedFailedDefinite++;
							} else {
								// Ambiguous write error -> mark RECONCILIATION_REQUIRED
								await (client
									.from('expenses') as any)
									.update({
										sync_status: 'RECONCILIATION_REQUIRED',
										sync_error: writeErr.message,
										updated_at: new Date().toISOString()
									})
									.eq('id', expense.id);
							}
						}
					}
				} catch (recErr: any) {
					report.errors.push({
						expenseId: expense.id,
						error: recErr.message || 'Unknown reconciliation error'
					});
				}
			}

			return report;
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * Start background periodic reconciliation job.
	 */
	public startBackgroundRunner(getClient: () => SupabaseClient<Database>): void {
		if (this.intervalHandle) return;

		console.log(`⏱️ Reconciliation engine scheduled every ${config.reconciliationIntervalMs}ms`);
		this.intervalHandle = setInterval(async () => {
			try {
				const client = getClient();
				const result = await this.reconcileExpenses(client);
				if (result.scanned > 0) {
					console.log(`🔍 Reconciliation cycle completed: Scanned=${result.scanned}, Synced=${result.resolvedSynced}, Pending=${result.advancedToPending}, DefiniteFailed=${result.markedFailedDefinite}`);
				}
			} catch (err) {
				console.error('Error during scheduled reconciliation:', err);
			}
		}, config.reconciliationIntervalMs);
	}

	/**
	 * Stops background reconciliation job.
	 */
	public stopBackgroundRunner(): void {
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
	}
}

export const reconciliationService = new ReconciliationService();
