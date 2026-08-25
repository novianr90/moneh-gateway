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

	public async ensureConnected(): Promise<void> {
		if (this.initialized) return;

		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = (async () => {
			if (!config.actualServerUrl || !config.actualPassword || !config.actualSyncId) {
				throw new Error('ACT001: Actual Budget environment configuration is missing (ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID)');
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

			await actualApi.downloadBudget(config.actualSyncId);
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

	public async resolveAccountId(paymentMethodName: string): Promise<string> {
		await this.ensureConnected();
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

	public async resolveOrCreatePayee(payeeName: string): Promise<string> {
		await this.ensureConnected();
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

	public async getPayees(): Promise<string[]> {
		try {
			await this.ensureConnected();
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

	public async resolveCategoryId(categoryName?: string): Promise<string | undefined> {
		if (!categoryName) return undefined;
		await this.ensureConnected();
		
		const categories: ActualCategory[] = await actualApi.getCategories();
		const targetName = categoryName.trim().toLowerCase();

		const matched = categories.find(
			(c) => !c.is_income && c.name.trim().toLowerCase() === targetName
		);

		return matched?.id;
	}

	public async createTransaction(input: ActualTransactionInput): Promise<ActualTransactionResult> {
		await this.ensureConnected();

		const accountId = await this.resolveAccountId(input.account_name);
		const payeeId = await this.resolveOrCreatePayee(input.payee_name);
		const categoryId = await this.resolveCategoryId(input.category_name);

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

		const result = await actualApi.addTransactions(accountId, [transactionPayload]);

		let actualTxId = '';
		if (Array.isArray(result) && result.length > 0) {
			actualTxId = typeof result[0] === 'string' ? result[0] : (result[0] as any).id || String(result[0]);
		} else if (typeof result === 'string') {
			actualTxId = result;
		}

		if (!actualTxId || actualTxId === 'ok') {
			const correlated = await this.findTransactionByCorrelation(
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

	public async updateTransaction(actualTxId: string, input: Partial<ActualTransactionInput>): Promise<void> {
		await this.ensureConnected();

		const payload: any = {};

		if (input.account_name !== undefined) {
			payload.account = await this.resolveAccountId(input.account_name);
		}
		if (input.payee_name !== undefined) {
			payload.payee = await this.resolveOrCreatePayee(input.payee_name);
		}
		if (input.category_name !== undefined) {
			payload.category = await this.resolveCategoryId(input.category_name);
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

	public async deleteTransaction(actualTxId: string): Promise<void> {
		await this.ensureConnected();
		await (actualApi as any).deleteTransaction(actualTxId);
	}

	public async findTransactionByCorrelation(
		paymentMethodName: string,
		expenseId: string,
		idempotencyKey: string,
		expenseDate?: string
	): Promise<{ id: string; notes?: string } | null> {
		await this.ensureConnected();

		try {
			const accountId = await this.resolveAccountId(paymentMethodName);
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
		userId: string
	): Promise<MasterDataSyncReport> {
		await this.ensureConnected();

		await actualApi.downloadBudget(config.actualSyncId);

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
