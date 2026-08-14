import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
	const healthHandler = async () => {
		return { status: 'ok', service: 'moneh-gateway', timestamp: new Date().toISOString() };
	};

	// Support all standard healthcheck endpoints
	fastify.get('/', healthHandler);
	fastify.get('/health', healthHandler);
	fastify.get('/api/health', healthHandler);
};
