import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config/env.js';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
	const healthHandler = async () => {
		return { status: 'ok', service: 'moneh-gateway', timestamp: new Date().toISOString() };
	};

	// Support all standard healthcheck endpoints
	fastify.get('/', healthHandler);
	fastify.get('/health', healthHandler);
	fastify.get('/api/health', healthHandler);

	// Gateway configuration endpoint (feature flags and runtime config)
	fastify.get('/api/config', async () => {
		return {
			useActual: config.useActual,
			version: '1.0.0'
		};
	});
};
