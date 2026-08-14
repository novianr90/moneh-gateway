import dotenv from 'dotenv';
dotenv.config();

export const config = {
	port: parseInt(process.env.PORT || '4000', 10),
	host: process.env.HOST || '0.0.0.0',
	supabaseUrl: process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321',
	supabasePublishableKey: process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY || 'placeholder',
	supabaseAnonKey: process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY || 'placeholder',
	clientOrigin: (process.env.CLIENT_ORIGIN || 'http://localhost:3004,http://localhost:5173,https://tracker.novianlabs.my.id').split(','),

	// Feature Flag: Enable/Disable Actual Budget Integration
	useActual: process.env.USE_ACTUAL === 'true',

	// Actual Budget Configuration
	actualServerUrl: process.env.ACTUAL_SERVER_URL || process.env.BUDGET_URL || 'https://budget.novianlabs.my.id',
	actualPassword: process.env.ACTUAL_PASSWORD || process.env.BUDGET_PASSWORD || '',
	actualSyncId: process.env.ACTUAL_SYNC_ID || '',
	actualDataDir: process.env.ACTUAL_DATA_DIR || './budget-data',

	// Reconciliation Configuration
	reconciliationIntervalMs: parseInt(process.env.RECONCILIATION_INTERVAL_MS || '60000', 10),
	reconciliationGracePeriodMs: parseInt(process.env.RECONCILIATION_GRACE_PERIOD_MS || '120000', 10),
	maxReconciliationRetries: parseInt(process.env.MAX_RECONCILIATION_RETRIES || '3', 10)
};
