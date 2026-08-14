import type { FastifyPluginAsync } from 'fastify';
import { categoryService, type InsertCategory, type UpdateCategory } from '../services/categories.service.js';

export const categoryRoutes: FastifyPluginAsync = async (fastify) => {
	fastify.register(async (protectedRoutes) => {
		protectedRoutes.addHook('preHandler', fastify.authenticate);

		// Get all categories
		protectedRoutes.get<{ Querystring: { active_only?: string } }>('/api/categories', async (request, reply) => {
			try {
				const onlyActive = request.query.active_only === 'true';
				const categories = await categoryService.getCategories(request.supabase, onlyActive);
				return reply.send(categories);
			} catch (err: any) {
				return reply.code(500).send({ error: err.message });
			}
		});

		// Create category
		protectedRoutes.post<{ Body: Omit<InsertCategory, 'user_id'> }>('/api/categories', async (request, reply) => {
			try {
				const category = await categoryService.createCategory(
					request.supabase,
					request.user!,
					request.body
				);
				return reply.code(201).send(category);
			} catch (err: any) {
				return reply.code(400).send({ error: err.message });
			}
		});

		// Update category
		protectedRoutes.put<{ Params: { id: string }; Body: UpdateCategory }>(
			'/api/categories/:id',
			async (request, reply) => {
				try {
					const category = await categoryService.updateCategory(
						request.supabase,
						request.params.id,
						request.body
					);
					return reply.send(category);
				} catch (err: any) {
					return reply.code(400).send({ error: err.message });
				}
			}
		);

		// Delete category
		protectedRoutes.delete<{ Params: { id: string } }>(
			'/api/categories/:id',
			async (request, reply) => {
				try {
					await categoryService.deleteCategory(request.supabase, request.params.id);
					return reply.send({ message: 'Category deleted successfully' });
				} catch (err: any) {
					return reply.code(400).send({ error: err.message });
				}
			}
		);
	});
};
