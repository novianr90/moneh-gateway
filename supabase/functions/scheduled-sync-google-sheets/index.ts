import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.8';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Scheduled Cron Edge Function: scheduled-sync-google-sheets
 * Automatically invoked by pg_cron or Supabase Scheduled Triggers to auto-sync un-uploaded transactions.
 */
serve(async (req: Request) => {
	if (req.method === 'OPTIONS') {
		return new Response('ok', { headers: corsHeaders });
	}

	const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
	const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';

	if (!supabaseUrl || !serviceRoleKey) {
		return new Response(
			JSON.stringify({ error: 'Supabase URL or Service Role Key missing in Edge Function environment.' }),
			{ status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
		);
	}

	const supabase = createClient(supabaseUrl, serviceRoleKey);

	try {
		// Fetch all pending expenses across users (is_upload != 'Y')
		const { data: pendingExpenses, error: fetchErr } = await supabase
			.from('recent_expenses')
			.select('*')
			.neq('is_upload', 'Y');

		if (fetchErr) throw fetchErr;

		const totalCount = pendingExpenses?.length || 0;

		if (totalCount === 0) {
			return new Response(
				JSON.stringify({ status: 'success', message: 'No pending transactions found for scheduled sync.', syncedCount: 0 }),
				{ status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
			);
		}

		const googleScriptUrl = Deno.env.get('GOOGLE_SCRIPT_URL');
		const spreadsheetApiKey = Deno.env.get('SPREADSHEET_API_KEY');

		if (!googleScriptUrl || !spreadsheetApiKey) {
			return new Response(
				JSON.stringify({ status: 'skipped', message: 'GOOGLE_SCRIPT_URL or SPREADSHEET_API_KEY unconfigured.' }),
				{ status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
			);
		}

		// Group expenses by user_id to fetch user email and record sync logs
		const expensesByUser = new Map<string, any[]>();
		for (const exp of pendingExpenses) {
			const list = expensesByUser.get(exp.user_id) || [];
			list.push(exp);
			expensesByUser.set(exp.user_id, list);
		}

		let totalSynced = 0;

		for (const [userId, userExpenses] of expensesByUser.entries()) {
			// Fetch user email from auth.users via admin API
			const { data: userData } = await supabase.auth.admin.getUserById(userId);
			const userEmail = userData?.user?.email || 'scheduled-sync@trackermoneh';

			// Record in_progress sync log
			const { data: syncLog } = await supabase
				.from('sync_logs')
				.insert({
					user_id: userId,
					status: 'in_progress',
					started_at: new Date().toISOString()
				})
				.select()
				.single();

			try {
				const gasResponse = await fetch(googleScriptUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						apiKey: spreadsheetApiKey,
						action: 'syncExpenses',
						data: userExpenses.map((exp: any) => ({
							id: exp.id,
							expense_date: exp.expense_date,
							category_name: exp.category_name,
							payment_method: exp.payment_method || 'Cash',
							amount: exp.amount,
							description: exp.description || '',
							user_email: userEmail
						}))
					}),
					redirect: 'follow'
				});

				const gasResult = await gasResponse.json();

				if (!gasResponse.ok || gasResult.status === 'error') {
					throw new Error(gasResult.message || `Google Apps Script returned status ${gasResponse.status}`);
				}

				// Mark expenses as uploaded (is_upload = 'Y')
				const syncedIds = userExpenses.map((exp: any) => exp.id);
				await supabase
					.from('expenses')
					.update({ is_upload: 'Y' })
					.in('id', syncedIds);

				totalSynced += syncedIds.length;

				// Update sync log status to success
				if (syncLog) {
					await supabase
						.from('sync_logs')
						.update({
							status: 'success',
							synced_count: syncedIds.length,
							finished_at: new Date().toISOString()
						})
						.eq('id', syncLog.id);
				}
			} catch (err: any) {
				console.error(`Scheduled sync failed for user ${userId}:`, err);
				if (syncLog) {
					await supabase
						.from('sync_logs')
						.update({
							status: 'failed',
							error_message: err.message || 'Scheduled sync failure',
							finished_at: new Date().toISOString()
						})
						.eq('id', syncLog.id);
				}
			}
		}

		return new Response(
			JSON.stringify({
				status: 'success',
				message: `Scheduled sync completed. Synced ${totalSynced} transactions across ${expensesByUser.size} users.`,
				syncedCount: totalSynced
			}),
			{ status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
		);
	} catch (err: any) {
		console.error('Scheduled sync execution error:', err);
		return new Response(
			JSON.stringify({ error: err.message || 'Scheduled sync execution failed' }),
			{ status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
		);
	}
});
