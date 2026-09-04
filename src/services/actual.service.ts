import * as actualApi from '@actual-app/api';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../lib/types/database.types.js';
import { config } from '../config/env.js';
import fs from 'fs';
import path from 'path';

export interface ActualAccount {
	id: string;
	name: string;
	offbudget?: boolean;
	closed?: boolean;
}

export interface ActualPayee {
	id: string;
	name: string;
}

export interface ActualCategory {
	id: string;
	name: string;
	cat_group?: string;
	is_income?: boolean;
}

export interface ActualTransactionInput {
	expense_id: string;
	idempotency_key: string;
	account_name: string;
	payee_name: string;
	category_name?: string;
	amount: number;
	expense_date: string;
	notes?: string;
}

export interface ActualTransactionResult {
	actual_transaction_id: string;
}

export interface MasterDataSyncReport {
	accountsSynced: number;
	categoriesSynced: number;
	newAccounts: string[];
	newCategories: string[];
}

class ActualService {
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	// Sync id of the budget currently downloaded/active in the actual-app/api SDK session.
	// The SDK only supports one active budget per process, so switching users means
	// re-downloading their budget before the operation runs.
	private activeSyncId: string | null = null;
	private downloadPromise: Promise<void> | null = null;
	// Per-actualSyncId serialization for budget read-then-write (issue #7): setBudgetAmount
	// overwrites an absolute value, so concurrent adjustNextMonthBudget calls for the same
	// user must not interleave their get/set pair.
	private budgetMutexes: Map<string, Promise<unknown>> = new Map();

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) return;

		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = (async () => {
			if (!config.actualServerUrl || !config.actualPassword) {
				throw new Error('ACT001: Actual Budget environment configuration is missing (ACTUAL_SERVER_URL, ACTUAL_PASSWORD)');
			}

			const dataDir = path.resolve(process.cwd(), config.actualDataDir);
			if (!fs.existsSync(dataDir)) {
				fs.mkdirSync(dataDir, { recursive: true });
			}

			await actualApi.init({
				dataDir,
				serverURL: config.actualServerUrl,
				password: config.actualPassword
			});

			this.initialized = true;
		})();

		try {
			await this.initPromise;
		} catch (err) {
			this.initPromise = null;
			this.initialized = false;
			throw err;
		}
	}

	/**
	 * Ensures the SDK is initialized AND the given user's budget is the active one.
	 * `actualSyncId` is resolved per-request from `users_configurations` (see issue #2) -
	 * there is no longer a single gateway-wide budget.
	 */
	public async ensureConnected(actualSyncId: string): Promise<void> {
		if (!actualSyncId) {
			throw new Error('ACT001: Actual sync id is missing for this user');
		}

		await this.ensureInitialized();

		if (this.activeSyncId === actualSyncId) return;

		if (this.downloadPromise) {
			await this.downloadPromise;
			if (this.activeSyncId === actualSyncId) return;
		}

		this.downloadPromise = (async () => {
			await actualApi.downloadBudget(actualSyncId);
			this.activeSyncId = actualSyncId;
		})();

		try {
			await this.downloadPromise;
		} finally {
			this.downloadPromise = null;
		}
	}

	private async withBudgetMutex<T>(actualSyncId: string, fn: () => Promise<T>): Promise<T> {
		const prior = this.budgetMutexes.get(actualSyncId) ?? Promise.resolve();
		const run = prior.catch(() => undefined).then(fn);
		this.budgetMutexes.set(actualSyncId, run.catch(() => undefined));
		return run;
	}

	private getNextBudgetMonth(expenseDate: string): string {
		// expense_date is a plain 'YYYY-MM-DD' string; anchor to UTC midnight so shifting the
		// month never rolls over to a different day because of local timezone offset.
		const anchor = new Date(`${expenseDate}T00:00:00Z`);
		anchor.setUTCMonth(anchor.getUTCMonth() + 1);
		const year = anchor.getUTCFullYear();
		const month = String(anchor.getUTCMonth() + 1).padStart(2, '0');
		return `${year}-${month}`;
	}

	/**
	 * Increases next month's budgeted amount for `categoryName` by `amount` (issue #7).
	 * Used when a transaction is created against a credit-card/paylater-flagged account,
	 * so the upcoming bill payment is already reflected in next month's budget.
	 * No validation on the resulting value, per spec - works even when current budgeted is 0.
	 */
	public async adjustNextMonthBudget(
		actualSyncId: string,
		categoryName: string,
		amount: number,
		expenseDate: string
	): Promise<void> {
		await this.ensureConnected(actualSyncId);

		const categoryId = await this.resolveCategoryId(actualSyncId, categoryName);
		if (!categoryId) {
			throw new Error(`ACT008: Bills category '${categoryName}' not found in Actual Budget`);
		}

		const nextMonth = this.getNextBudgetMonth(expenseDate);

		await this.withBudgetMutex(actualSyncId, () =>
			actualApi.batchBudgetUpdates(async () => {
				const budgetMonth = await actualApi.getBudgetMonth(nextMonth);

				let currentBudgeted = 0;
				for (const group of budgetMonth.categoryGroups || []) {
					const match = (group.categories || []).find((c: any) => c.id === categoryId);
					if (match) {
						currentBudgeted = Number((match as any).budgeted) || 0;
						break;
					}
				}

				const newBudgeted = currentBudgeted + Math.round(amount * 100);
				await actualApi.setBudgetAmount(nextMonth, categoryId, newBudgeted);
			})
		);
	}

	public formatNotes(notes: string | undefined, expenseId: string, idempotencyKey: string): string {
		const correlationTag = `[moneh_expense_id: ${expenseId}] [moneh_idempotency_key: ${idempotencyKey}]`;
		if (!notes || notes.trim() === '') {
			return correlationTag;
		}
		return `${notes.trim()} ${correlationTag}`;
	}

	public parseCorrelationNotes(notes: string | null | undefined): { expenseId?: string; idempotencyKey?: string } {
		if (!notes) return {};
		const expenseMatch = notes.match(/\[moneh_expense_id:\s*([^\]]+)\]/);
		const idempotencyMatch = notes.match(/\[moneh_idempotency_key:\s*([^\]]+)\]/);

		return {
			expenseId: expenseMatch ? expenseMatch[1].trim() : undefined,
			idempotencyKey: idempotencyMatch ? idempotencyMatch[1].trim() : undefined
		};
	}

	public async resolveAccountId(actualSyncId: string, paymentMethodName: string): Promise<string> {
		await this.ensureConnected(actualSyncId);
		const accounts: ActualAccount[] = await actualApi.getAccounts();

		const targetName = (paymentMethodName || 'Cash').trim().toLowerCase();
		let matched = accounts.find((acc) => !acc.closed && acc.name.trim().toLowerCase() === targetName);

		if (!matched) {
			matched = accounts.find((acc) => !acc.closed);
		}

		if (!matched) {
			throw new Error(`ACT002: No active Actual Budget account found matching payment method '${paymentMethodName}'`);
		}

		return matched.id;
  }

  public async resolveTransferPayee(actualSyncId: string, payeeName: string): Promise<string | undefined> {
      await this.ensureConnected(actualSyncId);

      const targetName = (payeeName || '').trim().toLowerCase();
      if (!targetName) return undefined;

      const [accounts, payees] = await Promise.all([
          actualApi.getAccounts(),
          actualApi.getPayees()
      ]);

      const offBudgetAccountIds = new Set(
          accounts
              .filter((account) => !account.closed && account.offbudget === true)
              .map((account) => account.id)
      );

      const transferPayee = payees.find(
          (payee: any) =>
              payee.transfer_acct &&
              offBudgetAccountIds.has(payee.transfer_acct) &&
              payee.name.trim().toLowerCase() === targetName
      );

      return transferPayee?.id;
  }

	public async resolveOrCreatePayee(actualSyncId: string, payeeName: string): Promise<string> {
		await this.ensureConnected(actualSyncId);
		const trimmedName = (payeeName || 'General').trim();
		const payees: ActualPayee[] = await actualApi.getPayees();

		const existing = payees.find(
			(p) => p.name.trim().toLowerCase() === trimmedName.toLowerCase()
		);

		if (existing) {
			return existing.id;
		}

		const newPayeeId = await actualApi.createPayee({ name: trimmedName });
		return newPayeeId;
	}

	public async getPayees(actualSyncId: string): Promise<string[]> {
		try {
			await this.ensureConnected(actualSyncId);
			const payees: ActualPayee[] = await actualApi.getPayees();
			return payees
				.map((p) => p.name?.trim())
				.filter((name) => Boolean(name))
				.sort((a, b) => a.localeCompare(b));
		} catch (e: any) {
			console.warn('Could not fetch payees from Actual Budget:', e?.message);
			return [];
		}
	}

	public async resolveCategoryId(actualSyncId: string, categoryName?: string): Promise<string | undefined> {
		if (!categoryName) return undefined;
		await this.ensureConnected(actualSyncId);

		const categories: ActualCategory[] = await actualApi.getCategories();
		const targetName = categoryName.trim().toLowerCase();

		const matched = categories.find(
			(c) => !c.is_income && c.name.trim().toLowerCase() === targetName
		);

		return matched?.id;
	}

	public async createTransaction(actualSyncId: string, input: ActualTransactionInput): Promise<ActualTransactionResult> {
		await this.ensureConnected(actualSyncId);

		const accountId = await this.resolveAccountId(actualSyncId, input.account_name);
		const transferPayeeId = await this.resolveTransferPayee(actualSyncId, input.payee_name);
		const payeeId = transferPayeeId ?? await this.resolveOrCreatePayee(actualSyncId, input.payee_name);
		const categoryId = await this.resolveCategoryId(actualSyncId, input.category_name);

		const formattedNotes = this.formatNotes(
			input.notes,
			input.expense_id,
			input.idempotency_key
		);

		const outflowAmount = -Math.abs(Math.round(input.amount * 100));

		const transactionPayload = {
			account: accountId,
			date: input.expense_date,
			amount: outflowAmount,
			payee: payeeId,
			category: categoryId,
			notes: formattedNotes,
			cleared: true
		};

		// Added true so if payee is account, actual do transfer to the account instead of know it as standard transactions
    const result = await actualApi.addTransactions(
      accountId,
      [transactionPayload],
      {
        runTransfers: true
      }
    );

		let actualTxId = '';
		if (Array.isArray(result) && result.length > 0) {
			actualTxId = typeof result[0] === 'string' ? result[0] : (result[0] as any).id || String(result[0]);
		} else if (typeof result === 'string') {
			actualTxId = result;
		}

		if (!actualTxId || actualTxId === 'ok') {
			const correlated = await this.findTransactionByCorrelation(
				actualSyncId,
				input.account_name,
				input.expense_id,
				input.idempotency_key,
				input.expense_date
			);
			if (correlated?.id) {
				actualTxId = correlated.id;
			}
		}

		if (!actualTxId) {
			throw new Error('ACT003: Actual Budget did not return a valid transaction ID');
		}

		return { actual_transaction_id: actualTxId };
	}

	public async updateTransaction(actualSyncId: string, actualTxId: string, input: Partial<ActualTransactionInput>): Promise<void> {
		await this.ensureConnected(actualSyncId);

		const payload: any = {};

		if (input.account_name !== undefined) {
			payload.account = await this.resolveAccountId(actualSyncId, input.account_name);
		}
		if (input.payee_name !== undefined) {
			payload.payee = await this.resolveOrCreatePayee(actualSyncId, input.payee_name);
		}
		if (input.category_name !== undefined) {
			payload.category = await this.resolveCategoryId(actualSyncId, input.category_name);
		}
		if (input.amount !== undefined) {
			payload.amount = -Math.abs(Math.round(input.amount * 100));
		}
		if (input.expense_date !== undefined) {
			payload.date = input.expense_date;
		}
		if (input.notes !== undefined && input.expense_id && input.idempotency_key) {
			payload.notes = this.formatNotes(
				input.notes,
				input.expense_id,
				input.idempotency_key
			);
		}

		await (actualApi as any).updateTransaction(actualTxId, payload);
	}

	public async deleteTransaction(actualSyncId: string, actualTxId: string): Promise<void> {
		await this.ensureConnected(actualSyncId);
		await (actualApi as any).deleteTransaction(actualTxId);
	}

	public async findTransactionByCorrelation(
		actualSyncId: string,
		paymentMethodName: string,
		expenseId: string,
		idempotencyKey: string,
		expenseDate?: string
	): Promise<{ id: string; notes?: string } | null> {
		await this.ensureConnected(actualSyncId);

		try {
			const accountId = await this.resolveAccountId(actualSyncId, paymentMethodName);
			let startDate: string | undefined = undefined;
			let endDate: string | undefined = undefined;

			if (expenseDate) {
				const dateObj = new Date(expenseDate);
				const prevDate = new Date(dateObj);
				prevDate.setDate(prevDate.getDate() - 7);
				const nextDate = new Date(dateObj);
				nextDate.setDate(nextDate.getDate() + 7);

				startDate = prevDate.toISOString().split('T')[0];
				endDate = nextDate.toISOString().split('T')[0];
			}

			const transactions = await (actualApi as any).getTransactions(accountId, startDate, endDate);

			for (const tx of transactions) {
				const parsed = this.parseCorrelationNotes(tx.notes);
				if (
					(parsed.expenseId && parsed.expenseId === expenseId) ||
					(parsed.idempotencyKey && parsed.idempotencyKey === idempotencyKey)
				) {
					return { id: tx.id, notes: tx.notes };
				}
			}

			return null;
		} catch (err) {
			console.error('Error in findTransactionByCorrelation:', err);
			return null;
		}
	}

	public async syncMasterDataToSupabase(
		client: SupabaseClient<Database>,
		userId: string,
		actualSyncId: string
	): Promise<MasterDataSyncReport> {
		// Force a fresh download (not just ensureConnected) so master data sync always
		// reflects the latest state of this user's budget, even if it was already active.
		await this.ensureInitialized();
		await actualApi.downloadBudget(actualSyncId);
		this.activeSyncId = actualSyncId;

		const actualAccounts: ActualAccount[] = await actualApi.getAccounts();
		const activeAccounts = actualAccounts.filter((a) => !a.closed);
		const activeAccountNames = new Set(activeAccounts.map((a) => a.name.trim().toLowerCase()));

		const { data: existingPMs } = await (client
			.from('payment_methods') as any)
			.select('id, name, is_active')
			.eq('user_id', userId);

		const existingPMMap = new Map<string, { id: string; name: string; is_active: boolean }>(
			(existingPMs || []).map((p: any) => [p.name.trim().toLowerCase(), p])
		);
		const newAccounts: string[] = [];

		for (const acc of activeAccounts) {
			const cleanName = acc.name.trim();
			const lower = cleanName.toLowerCase();
			const existing = existingPMMap.get(lower);
			if (!existing) {
				await (client.from('payment_methods') as any).insert({
					user_id: userId,
					name: cleanName,
					is_active: true
				});
				newAccounts.push(cleanName);
			} else if (!existing.is_active) {
				await (client.from('payment_methods') as any)
					.update({ is_active: true })
					.eq('id', existing.id);
			}
		}

		for (const [lowerName, pm] of existingPMMap.entries()) {
			if (!activeAccountNames.has(lowerName) && pm.is_active) {
				await (client.from('payment_methods') as any)
					.update({ is_active: false })
					.eq('id', pm.id);
			}
		}

		const actualCategories: ActualCategory[] = await actualApi.getCategories();
		const expenseCategories = actualCategories.filter((c) => !c.is_income);
		const activeCategoryNames = new Set(expenseCategories.map((c) => c.name.trim().toLowerCase()));

		const { data: existingCats } = await (client
			.from('categories') as any)
			.select('id, name, is_active')
			.eq('user_id', userId);

		const existingCatMap = new Map<string, { id: string; name: string; is_active: boolean }>(
			(existingCats || []).map((c: any) => [c.name.trim().toLowerCase(), c])
		);
		const newCategories: string[] = [];

		const colorPalette = [
			'#ef4444', '#f97316', '#f59e0b', '#10b981', '#06b6d4',
			'#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#64748b'
		];

		let colorIdx = 0;
		for (const cat of expenseCategories) {
			const cleanName = cat.name.trim();
			const lower = cleanName.toLowerCase();
			const existing = existingCatMap.get(lower);
			if (!existing) {
				const assignedColor = colorPalette[colorIdx % colorPalette.length];
				colorIdx++;

				await (client.from('categories') as any).insert({
					user_id: userId,
					name: cleanName,
					icon: 'tag',
					color: assignedColor,
					is_active: true
				});
				newCategories.push(cleanName);
			} else if (!existing.is_active) {
				await (client.from('categories') as any)
					.update({ is_active: true })
					.eq('id', existing.id);
			}
		}

		for (const [lowerName, cat] of existingCatMap.entries()) {
			if (!activeCategoryNames.has(lowerName) && cat.is_active) {
				await (client.from('categories') as any)
					.update({ is_active: false })
					.eq('id', cat.id);
			}
		}

		return {
			accountsSynced: activeAccounts.length,
			categoriesSynced: expenseCategories.length,
			newAccounts,
			newCategories
		};
	}

	public async shutdown(): Promise<void> {
		if (this.initialized) {
			try {
				await actualApi.shutdown();
			} catch (err) {
				console.error('Error shutting down Actual Budget SDK:', err);
			} finally {
				this.initialized = false;
				this.initPromise = null;
			}
		}
	}
}

export const actualService = new ActualService();
