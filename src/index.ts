import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { config } from './config/env.js';
import authPlugin from './plugins/auth.js';
import { healthRoutes } from './routes/health.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { categoryRoutes } from './routes/categories.routes.js';
import { expenseRoutes } from './routes/expenses.routes.js';
import { paymentMethodRoutes } from './routes/paymentMethods.routes.js';
import { syncRoutes } from './routes/sync.routes.js';
import { reconciliationService } from './services/reconciliation.service.js';
import { defaultSupabase } from './lib/supabase.js';
import { actualService } from './services/actual.service.js';

const fastify = Fastify({
	logger: true
});

async function main() {
	// Register CORS
	await fastify.register(cors, {
		origin: config.clientOrigin,
		credentials: true
	});

	// Register Cookie parser
	await fastify.register(cookie);

	// Register Auth plugin
	await fastify.register(authPlugin);

	// Register Routes
	await fastify.register(healthRoutes);
	await fastify.register(authRoutes);
	await fastify.register(categoryRoutes);
	await fastify.register(expenseRoutes);
	await fastify.register(paymentMethodRoutes);
	await fastify.register(syncRoutes);

	// Start Background Reconciliation Runner for Actual Budget if enabled
	if (config.useActual) {
		reconciliationService.startBackgroundRunner(() => defaultSupabase);
	} else {
		console.log('ℹ️ Actual Budget integration is disabled (USE_ACTUAL=false). Operating in standalone/Spreadsheet sync mode.');
	}

	// Graceful shutdown hooks
	const cleanup = async () => {
		console.log('Shutting down server...');
		reconciliationService.stopBackgroundRunner();
		await actualService.shutdown();
		await fastify.close();
		process.exit(0);
	};

	process.on('SIGTERM', cleanup);
	process.on('SIGINT', cleanup);

	try {
		await fastify.listen({ port: config.port, host: config.host });
		console.log(`🚀 Moneh Gateway server running on http://${config.host}:${config.port}`);
	} catch (err) {
		fastify.log.error(err);
		process.exit(1);
	}
}

main();
