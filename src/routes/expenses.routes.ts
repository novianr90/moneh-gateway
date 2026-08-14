import type { FastifyPluginAsync } from 'fastify';
import {
	expenseService,
	type ExpenseFilters,
	type InsertExpense,
	type UpdateExpense
} from '../services/expenses.service.js';

export const expenseRoutes: FastifyPluginAsync = async (fastify) => {
	fastify.register(async (protectedRoutes) => {
		protectedRoutes.addHook('preHandler', fastify.authenticate);

		// Get paginated expenses with filters
		protectedRoutes.get<{ Querystring: ExpenseFilters }>('/api/expenses', async (request, reply) => {
			try {
				const { startDate, endDate, categoryId, paymentMethod, searchKey, page, pageSize } = request.query;
				const filters: ExpenseFilters = {
					startDate,
					endDate,
					categoryId,
					paymentMethod,
					searchKey,
					page: page ? Number(page) : undefined,
					pageSize: pageSize ? Number(pageSize) : undefined
				};

				const result = await expenseService.getExpenses(request.supabase, request.user!, filters);
				return reply.send(result);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message });
			}
		});

		// Get payees list for autocomplete
		protectedRoutes.get('/api/payees', async (request, reply) => {
			try {
				const payees = await expenseService.getPayees(request.supabase, request.user!);
				return reply.send(payees);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message });
			}
		});

		protectedRoutes.get('/api/expenses/payees', async (request, reply) => {
			try {
				const payees = await expenseService.getPayees(request.supabase, request.user!);
				return reply.send(payees);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message });
			}
		});

		// Get monthly summary metrics
		protectedRoutes.get<{ Querystring: { month?: string } }>(
			'/api/expenses/summary',
			async (request, reply) => {
				try {
					const summary = await expenseService.getMonthlySummary(
						request.supabase,
						request.query.month
					);
					return reply.send(summary);
				} catch (err: any) {
					return reply.code(500).send({ error: err.message });
				}
			}
		);

		// Get monthly category breakdown
		protectedRoutes.get<{ Querystring: { month?: string } }>(
			'/api/expenses/category-breakdown',
			async (request, reply) => {
				try {
					const breakdown = await expenseService.getMonthlyCategoryBreakdown(
						request.supabase,
						request.query.month
					);
					return reply.send(breakdown);
				} catch (err: any) {
					return reply.code(500).send({ error: err.message });
				}
			}
		);

		// Get recent transactions feed
		protectedRoutes.get<{ Querystring: { limit?: string } }>(
			'/api/expenses/recent',
			async (request, reply) => {
				try {
					const limit = request.query.limit ? parseInt(request.query.limit, 10) : 10;
					const transactions = await expenseService.getRecentTransactions(
						request.supabase,
						limit
					);
					return reply.send(transactions);
				} catch (err: any) {
					return reply.code(500).send({ error: err.message });
				}
			}
		);

		// Get daily expense trends analytics
		protectedRoutes.get<{ Querystring: { month?: string } }>(
			'/api/expenses/trends',
			async (request, reply) => {
				try {
					const trends = await expenseService.getDailyExpenseTrends(
						request.supabase,
						request.query.month
					);
					return reply.send(trends);
				} catch (err: any) {
					return reply.code(500).send({ error: err.message });
				}
			}
		);

		// Create expense entry via Saga Dual-Write (§6.2)
		protectedRoutes.post<{
			Headers: { 'idempotency-key'?: string };
			Body: Omit<InsertExpense, 'user_id'> & { idempotency_key?: string };
		}>('/api/expenses', async (request, reply) => {
			try {
				const idempotencyKey =
					request.headers['idempotency-key'] ||
					request.body.idempotency_key;

				const result = await expenseService.createExpense(
					request.supabase,
					request.user!,
					request.body,
					idempotencyKey
				);

				return reply.code(result.statusCode).send(result);
			} catch (err: any) {
				const isValidation = err.message && (err.message.startsWith('EXP') || err.message.startsWith('ACT005'));
				return reply.code(isValidation ? 400 : 500).send({ error: err.message });
			}
		});

		// Retry expense sync (§6.3)
		protectedRoutes.post<{ Params: { id: string } }>(
			'/api/expenses/:id/retry',
			async (request, reply) => {
				try {
					const result = await expenseService.retryExpense(
						request.supabase,
						request.user!,
						request.params.id
					);
					return reply.code(result.statusCode).send(result);
				} catch (err: any) {
					return reply.code(400).send({ error: err.message });
				}
			}
		);

		// Update expense entry
		protectedRoutes.put<{ Params: { id: string }; Body: UpdateExpense }>(
			'/api/expenses/:id',
			async (request, reply) => {
				try {
					const expense = await expenseService.updateExpense(
						request.supabase,
						request.params.id,
						request.body
					);
					return reply.send(expense);
				} catch (err: any) {
					return reply.code(400).send({ error: err.message });
				}
			}
		);

		// Delete expense entry
		protectedRoutes.delete<{ Params: { id: string } }>(
			'/api/expenses/:id',
			async (request, reply) => {
				try {
					await expenseService.deleteExpense(request.supabase, request.params.id);
					return reply.send({ message: 'Expense deleted successfully' });
				} catch (err: any) {
					return reply.code(400).send({ error: err.message });
				}
			}
		);
	});
};
