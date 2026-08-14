import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.8';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
	if (req.method === 'OPTIONS') {
		return new Response('ok', { headers: corsHeaders });
	}

	const authHeader = req.headers.get('Authorization');
	if (!authHeader) {
		return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
			status: 401,
			headers: { ...corsHeaders, 'Content-Type': 'application/json' },
		});
	}

	const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
	const supabaseAnonKey =
		Deno.env.get('SUPABASE_ANON_KEY') ||
		Deno.env.get('PUBLIC_SUPABASE_ANON_KEY') ||
		Deno.env.get('PUBLIC_SUPABASE_PUBLISHABLE_KEY') ||
		'';

	if (!supabaseUrl || !supabaseAnonKey) {
		return new Response(
			JSON.stringify({ error: 'Supabase URL or Anon Key configuration missing in Edge Function environment.' }),
			{
				status: 500,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
			}
		);
	}

	const supabase = createClient(supabaseUrl, supabaseAnonKey, {
		global: { headers: { Authorization: authHeader } },
	});

	const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
	const dbClient = serviceRoleKey ? createClient(supabaseUrl, serviceRoleKey) : supabase;

	// Verify User
	const { data: { user }, error: userError } = await supabase.auth.getUser();
	if (userError || !user) {
		return new Response(JSON.stringify({ error: 'Unauthorized user session' }), {
			status: 401,
			headers: { ...corsHeaders, 'Content-Type': 'application/json' },
		});
	}

	// Create Sync Log Entry (in_progress)
	const { data: syncLog, error: logError } = await dbClient
		.from('sync_logs')
		.insert({
			user_id: user.id,
			status: 'in_progress',
			started_at: new Date().toISOString()
		})
		.select()
		.single();

	if (logError) {
		console.error('Failed to create sync log:', logError);
	}

	try {
		// Fetch Pending (Un-uploaded) User Expenses (is_upload is null or 'N' / not 'Y')
		const { data: expenses, error: expenseError } = await supabase
			.from('recent_expenses')
			.select('*')
			.eq('user_id', user.id)
			.neq('is_upload', 'Y');

		if (expenseError) throw expenseError;

		const count = expenses?.length || 0;

		const googleScriptUrl = Deno.env.get('GOOGLE_SCRIPT_URL');
		const spreadsheetApiKey = Deno.env.get('SPREADSHEET_API_KEY');

		let syncDetails = { syncedCount: count };

		if (count === 0) {
			console.log('No pending transactions to upload.');
		} else if (googleScriptUrl && spreadsheetApiKey) {
			// Call Google Apps Script Web App
			const gasResponse = await fetch(googleScriptUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					apiKey: spreadsheetApiKey,
					action: 'syncExpenses',
					data: (expenses || []).map((exp: any) => ({
						id: exp.id,
						expense_date: exp.expense_date,
						category_name: exp.category_name,
						payment_method: exp.payment_method || 'Cash',
						amount: exp.amount,
						description: exp.description || '',
						user_email: user.email
					}))
				}),
				redirect: 'follow'
			});

			const gasResult = await gasResponse.json();

			if (!gasResponse.ok || gasResult.status === 'error') {
				throw new Error(gasResult.message || `Google Apps Script returned status ${gasResponse.status}`);
			}

			// Update synced expenses set is_upload = 'Y'
			const syncedIds = (expenses || []).map((exp: any) => exp.id);
			if (syncedIds.length > 0) {
				const { error: updateError } = await dbClient
					.from('expenses')
					.update({ is_upload: 'Y' })
					.in('id', syncedIds);

				if (updateError) {
					console.error('Failed setting is_upload=Y for synced expenses:', updateError);
					throw new Error(`Database update failed: ${updateError.message}`);
				}
			}

			syncDetails = { ...syncDetails, ...gasResult };
		} else {
			console.warn('GOOGLE_SCRIPT_URL or SPREADSHEET_API_KEY missing. Execution logged in dry-run mode.');
		}

		const finishedAt = new Date().toISOString();

		if (syncLog) {
			const { error: logUpdateErr } = await dbClient
				.from('sync_logs')
				.update({
					status: 'success',
					synced_count: count,
					finished_at: finishedAt
				})
				.eq('id', syncLog.id);

			if (logUpdateErr) {
				console.error('Failed updating sync_log status to success:', logUpdateErr);
			}
		}

		return new Response(
			JSON.stringify({
				status: 'success',
				syncedCount: count,
				finishedAt,
				details: syncDetails
			}),
			{
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				status: 200,
			}
		);
	} catch (err: any) {
		console.error('Sync execution failed:', err);

		if (syncLog) {
			await dbClient
				.from('sync_logs')
				.update({
					status: 'failed',
					error_message: err.message || 'Unknown execution failure',
					finished_at: new Date().toISOString()
				})
				.eq('id', syncLog.id);
		}

		return new Response(
			JSON.stringify({ error: err.message || 'Sync execution failed' }),
			{
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				status: 500,
			}
		);
	}
});
