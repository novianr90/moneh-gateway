import type { FastifyPluginAsync } from 'fastify';
import { paymentMethodService } from '../services/paymentMethods.service.js';

export const paymentMethodRoutes: FastifyPluginAsync = async (fastify) => {
	fastify.register(async (protectedRoutes) => {
		protectedRoutes.addHook('preHandler', fastify.authenticate);

		// Get all payment methods
		protectedRoutes.get<{ Querystring: { active_only?: string } }>('/api/payment-methods', async (request, reply) => {
			try {
				const onlyActive = request.query.active_only === 'true';
				const paymentMethods = await paymentMethodService.getPaymentMethods(request.supabase, onlyActive);
				return reply.send(paymentMethods);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message });
			}
		});

		// Create payment method
		protectedRoutes.post<{ Body: { name: string } }>('/api/payment-methods', async (request, reply) => {
			try {
				const paymentMethod = await paymentMethodService.createPaymentMethod(
					request.supabase,
					request.user!,
					request.body.name
				);
				return reply.code(201).send(paymentMethod);
			} catch (err: any) {
				return reply.code(400).send({ error: err.message });
			}
		});

		// Delete payment method
		protectedRoutes.delete<{ Params: { id: string } }>(
			'/api/payment-methods/:id',
			async (request, reply) => {
				try {
					await paymentMethodService.deletePaymentMethod(request.supabase, request.params.id);
					return reply.send({ message: 'Payment method deleted successfully' });
				} catch (err: any) {
					return reply.code(400).send({ error: err.message });
				}
			}
		);
	});
};
