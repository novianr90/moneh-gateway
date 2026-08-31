import type { FastifyPluginAsync } from 'fastify';
import { userConfigService } from '../services/userConfig.service.js';
import { config } from '../config/env.js';

export const userConfigRoutes: FastifyPluginAsync = async (fastify) => {
	fastify.register(async (protectedRoutes) => {
		protectedRoutes.addHook('preHandler', fastify.authenticate);

		// Get the authenticated user's configuration (Actual Budget sync id, etc.)
		protectedRoutes.get('/api/config', async (request, reply) => {
			try {
				const configuration = await userConfigService.getConfiguration(request.supabase, request.user!.id);
				return reply.send({
					useActual: config.useActual,
					actualSyncId: configuration?.actual_sync_id ?? null
				});
			} catch (err: any) {
				return reply.code(500).send({ error: err.message || 'CFG001: Failed to load configuration' });
			}
		});

		// Set/update the authenticated user's Actual Budget sync id.
		protectedRoutes.put<{ Body: { actualSyncId: string | null } }>('/api/config/actual-sync-id', async (request, reply) => {
			try {
				const configuration = await userConfigService.upsertActualSyncId(
					request.supabase,
					request.user!.id,
					request.body?.actualSyncId ?? null
				);
				return reply.send({
					useActual: config.useActual,
					actualSyncId: configuration.actual_sync_id
				});
			} catch (err: any) {
				return reply.code(400).send({ error: err.message || 'CFG002: Failed to update configuration' });
			}
		});
	});
};
