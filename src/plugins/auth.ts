import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { getSupabaseClient } from '../lib/supabase.js';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '../lib/types/database.types.js';

declare module 'fastify' {
	interface FastifyRequest {
		supabase: SupabaseClient<Database>;
		user: User | null;
		token: string | null;
	}
	interface FastifyInstance {
		authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	}
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
	fastify.decorateRequest('supabase', null);
	fastify.decorateRequest('user', null);
	fastify.decorateRequest('token', null);

	fastify.addHook('onRequest', async (request) => {
		let token: string | null = null;

		// 1. Check Authorization header
		const authHeader = request.headers.authorization;
		if (authHeader && authHeader.startsWith('Bearer ')) {
			token = authHeader.substring(7);
		}

		// 2. Check cookies if token not in header
		if (!token && request.cookies) {
			token = request.cookies['sb-access-token'] || request.cookies['access_token'] || null;
		}

		request.token = token;
		const supabase = getSupabaseClient(token || undefined);
		request.supabase = supabase;

		if (token) {
			const { data: { user }, error } = await supabase.auth.getUser(token);
			if (!error && user) {
				request.user = user;
			}
		}
	});

	fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
		if (!request.user) {
			reply.code(401).send({ error: 'AUTH002: User unauthenticated' });
		}
	});
};

export default fp(authPlugin);
