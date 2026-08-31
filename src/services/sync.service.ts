import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, SyncStatus } from '../lib/types/database.types.js';
import { reconciliationService, type ReconciliationReport } from './reconciliation.service.js';
import { actualService, type MasterDataSyncReport } from './actual.service.js';
import { userConfigService } from './userConfig.service.js';
import { config } from '../config/env.js';

export type SyncLog = Database['public']['Tables']['sync_logs']['Row'];

export interface ActualSyncStatusSummary {
	enabled: boolean;
	synced: number;
	pending: number;
	reconciling: number;
	failed: number;
	total: number;
	warning?: string;
}

export const syncService = {
	// ==========================================
	// Actual Budget Reconciliation & Master Data
	// ==========================================
	async reconcileActualBudget(client: SupabaseClient<Database>): Promise<ReconciliationReport> {
		if (!config.useActual) {
			return {
				scanned: 0,
				resolvedSynced: 0,
				advancedToPending: 0,
				markedFailedDefinite: 0,
				exhausted: 0,
				errors: [{ expenseId: 'ALL', error: 'Actual Budget integration is disabled (USE_ACTUAL=false)' }]
			};
		}
		return await reconciliationService.reconcileExpenses(client);
	},

	async syncMasterData(client: SupabaseClient<Database>, userId: string): Promise<MasterDataSyncReport> {
		const availability = await userConfigService.resolveActualAvailability(client, userId);
		if (!availability.available) {
			throw new Error(
				availability.warning
					? `ACT_SYNC003: ${availability.warning}`
					: 'ACT_SYNC003: Actual Budget integration is disabled (USE_ACTUAL=false)'
			);
		}
		return await actualService.syncMasterDataToSupabase(client, userId, availability.actualSyncId!);
	},

	async getActualSyncStatus(client: SupabaseClient<Database>, userId: string): Promise<ActualSyncStatusSummary> {
		const availability = await userConfigService.resolveActualAvailability(client, userId);
		if (!availability.available) {
			return {
				enabled: false,
				synced: 0,
				pending: 0,
				reconciling: 0,
				failed: 0,
				total: 0,
				warning: availability.warning
			};
		}

		const { data, error } = await (client
			.from('expenses') as any)
			.select('sync_status')
			.eq('user_id', userId);

		if (error) throw error;

		const summary: ActualSyncStatusSummary = {
			enabled: true,
			synced: 0,
			pending: 0,
			reconciling: 0,
			failed: 0,
			total: data?.length || 0
		};

		for (const row of (data || []) as Array<{ sync_status: SyncStatus }>) {
			if (row.sync_status === 'SYNCED') summary.synced++;
			else if (row.sync_status === 'PENDING') summary.pending++;
			else if (row.sync_status === 'RECONCILIATION_REQUIRED' || row.sync_status === 'ROLLBACK_PENDING') summary.reconciling++;
			else if (row.sync_status === 'SYNC_FAILED') summary.failed++;
		}

		return summary;
	},

	// ==========================================
	// Google Sheets Reporting Services (Preserved)
	// ==========================================
	async triggerGoogleSheetsSync(
		client: SupabaseClient<Database>,
		token: string
	): Promise<{ status: string; syncedCount: number; message?: string }> {
		const response = await client.functions.invoke('sync-google-sheets', {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});

		if (response.error) {
			throw new Error(response.error.message || 'SYNC003: Sync execution failed');
		}

		return response.data;
	},

	async getSyncLogs(client: SupabaseClient<Database>, limit = 20): Promise<SyncLog[]> {
		const { data, error } = await client
			.from('sync_logs')
			.select('*')
			.order('started_at', { ascending: false })
			.limit(limit);

		if (error) throw error;
		return data || [];
	},

	async getActiveCronJobs(client: SupabaseClient<Database>): Promise<{ jobid: number; jobname: string; schedule: string; active: boolean }[]> {
		try {
			const { data, error } = await (client as any).rpc('get_cron_jobs');
			if (error) return [];
			return data || [];
		} catch {
			return [];
		}
	}
};
