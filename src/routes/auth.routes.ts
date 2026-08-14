import type { FastifyPluginAsync } from 'fastify';
import { authService } from '../services/auth.service.js';
import { config } from '../config/env.js';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
	// Login endpoint
	fastify.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', async (request, reply) => {
		const { email, password } = request.body || {};
		if (!email || !password) {
			return reply.code(400).send({ error: 'Please enter both email and password' });
		}

		try {
			const data = await authService.signIn(email, password);
			if (data.session) {
				const isProduction = process.env.NODE_ENV === 'production';
				const cookieDomain = config.cookieDomain;

				reply.setCookie('sb-access-token', data.session.access_token, {
					path: '/',
					httpOnly: true,
					secure: isProduction,
					sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
					domain: cookieDomain,
					maxAge: data.session.expires_in
				});
				reply.setCookie('sb-refresh-token', data.session.refresh_token, {
					path: '/',
					httpOnly: true,
					secure: isProduction,
					sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
					domain: cookieDomain,
					maxAge: 60 * 60 * 24 * 30
				});
			}

			return reply.send({ session: data.session, user: data.user });
		} catch (err: any) {
			return reply.code(401).send({ error: err.message || 'AUTH001: Invalid email or password' });
		}
	});

	// Logout endpoint
	fastify.post('/api/auth/logout', async (request, reply) => {
		try {
			if (request.supabase) {
				await authService.signOut(request.supabase);
			}
		} catch (e) {
			// Ignore signout error if session already expired
		}

		const isProduction = process.env.NODE_ENV === 'production';
		const cookieDomain = config.cookieDomain;

		const clearOptions = {
			path: '/',
			httpOnly: true,
			secure: isProduction,
			sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
			domain: cookieDomain
		};

		reply.clearCookie('sb-access-token', clearOptions);
		reply.clearCookie('sb-refresh-token', clearOptions);
		reply.clearCookie('sb-access-token', { path: '/' });
		reply.clearCookie('sb-refresh-token', { path: '/' });
		return reply.send({ message: 'Signed out successfully' });
	});

	// Get current user & session endpoint
	fastify.get('/api/auth/me', async (request, reply) => {
		if (!request.user || !request.token) {
			return reply.send({ user: null, session: null });
		}

		try {
			const session = await authService.getSession(request.supabase);
			return reply.send({ user: request.user, session });
		} catch {
			return reply.send({ user: request.user, session: null });
		}
	});
};
