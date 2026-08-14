import type { FastifyPluginAsync } from 'fastify';
import { syncService } from '../services/sync.service.js';

export const syncRoutes: FastifyPluginAsync = async (fastify) => {
	fastify.register(async (protectedRoutes) => {
		protectedRoutes.addHook('preHandler', fastify.authenticate);

		// ==========================================
		// Actual Budget Sync Routes
		// ==========================================
		// Trigger manual reconciliation for Actual Budget
		protectedRoutes.post('/api/sync/actual/reconcile', async (request, reply) => {
			try {
				const result = await syncService.reconcileActualBudget(request.supabase);
				return reply.send(result);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message || 'ACT_SYNC001: Reconciliation failed' });
			}
		});

		// Sync Master Data (Categories & Accounts) from Actual Budget into Supabase
		protectedRoutes.post('/api/sync/actual/master-data', async (request, reply) => {
			try {
				const result = await syncService.syncMasterData(request.supabase, request.user!.id);
				return reply.send(result);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message || 'ACT_SYNC002: Master data sync failed' });
			}
		});

		// Get Actual Budget synchronization overview / status counts
		protectedRoutes.get('/api/sync/actual/status', async (request, reply) => {
			try {
				const status = await syncService.getActualSyncStatus(request.supabase, request.user!.id);
				return reply.send(status);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message });
			}
		});

		// ==========================================
		// Google Sheets Reporting Sync Routes (Preserved)
		// ==========================================
		// Trigger Google Sheets sync edge function (supports both /api/sync/trigger and /api/sync/spreadsheet/trigger)
		const triggerHandler = async (request: any, reply: any) => {
			try {
				if (!request.token) {
					return reply.code(401).send({ error: 'AUTH002: Session expired / Unauthorized' });
				}
				const result = await syncService.triggerGoogleSheetsSync(
					request.supabase,
					request.token
				);
				return reply.send(result);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message || 'SYNC003: Sync execution failed' });
			}
		};

		protectedRoutes.post('/api/sync/trigger', triggerHandler);
		protectedRoutes.post('/api/sync/spreadsheet/trigger', triggerHandler);

		// Get sync logs
		protectedRoutes.get<{ Querystring: { limit?: string } }>('/api/sync/logs', async (request, reply) => {
			try {
				const limit = request.query.limit ? parseInt(request.query.limit, 10) : 20;
				const logs = await syncService.getSyncLogs(request.supabase, limit);
				return reply.send(logs);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message });
			}
		});

		// Get active cron jobs
		protectedRoutes.get('/api/sync/cron-jobs', async (request, reply) => {
			try {
				const jobs = await syncService.getActiveCronJobs(request.supabase);
				return reply.send(jobs);
			} catch (err: any) {
				return reply.send([]);
			}
		});
	});
};
