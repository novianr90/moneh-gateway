import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config/env.js';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
	const healthHandler = async () => {
		return { status: 'ok', service: 'moneh-gateway', timestamp: new Date().toISOString() };
	};

	const configHandler = async () => {
		return {
			useActual: config.useActual,
			version: '1.0.0'
		};
	};

	// Support all standard healthcheck endpoints
	fastify.get('/', healthHandler);
	fastify.get('/health', healthHandler);
	fastify.get('/api/health', healthHandler);

	// Bare /config kept for legacy/tooling healthchecks. /api/config is owned by
	// userConfig.routes.ts (authenticated, per-user actualSyncId) - do not re-declare it
	// here, Fastify throws on duplicate route registration.
	fastify.get('/config', configHandler);
};
