import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
	fastify.get('/health', async () => {
		return { status: 'ok', service: 'moneh-gateway', timestamp: new Date().toISOString() };
	});
};
