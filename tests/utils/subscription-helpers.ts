import { vi } from "vitest";
import type { PluginAdapter, Subscription, SyncContext } from "../../src/plugins/subscriptions";
import type { StreamPayWebhookPayload } from "../../src/webhooks/events";

let nextId = 0;

export function createMockAdapter(): PluginAdapter & {
	tables: Record<string, Record<string, unknown>[]>;
	resetIdCounter: (seed?: number) => void;
} {
	const tables: Record<string, Record<string, unknown>[]> = {
		subscription: [],
		streampayWebhookEvent: [],
		user: [],
	};

	const uniqueByModel: Record<string, readonly string[]> = {
		subscription: ["activeSlotKey", "streampaySubscriptionId", "streampayPaymentLinkId"],
		streampayWebhookEvent: ["eventId"],
	};

	function matches(
		row: Record<string, unknown>,
		where: Array<{ field: string; value: unknown }>,
	): boolean {
		for (const clause of where) {
			if (row[clause.field] !== clause.value) return false;
		}
		return true;
	}

	function assertUnique(
		model: string,
		data: Record<string, unknown>,
		exclude?: Record<string, unknown>,
	): void {
		const uniques = uniqueByModel[model];
		if (!uniques || !tables[model]) return;
		for (const field of uniques) {
			const value = data[field];
			if (value === undefined || value === null) continue;
			const clash = tables[model].find((row) => row !== exclude && row[field] === value);
			if (clash) {
				const err = new Error(`UNIQUE constraint failed: ${model}.${field}`) as Error & {
					code?: string;
				};
				err.code = "SQLITE_CONSTRAINT_UNIQUE";
				throw err;
			}
		}
	}

	return {
		tables,
		resetIdCounter(seed = 0) {
			nextId = seed;
		},
		async create<T, D extends object = Record<string, unknown>>(args: {
			model: string;
			data: D;
		}): Promise<T> {
			const table = tables[args.model] ?? [];
			tables[args.model] = table;
			const data = args.data as Record<string, unknown>;
			assertUnique(args.model, data);
			const row = {
				id: typeof data.id === "string" ? data.id : `row_${++nextId}`,
				createdAt: data.createdAt instanceof Date ? data.createdAt : new Date(),
				updatedAt: data.updatedAt instanceof Date ? data.updatedAt : new Date(),
				...data,
			};
			table.push(row);
			return row as T;
		},
		async update<T, D extends object = Record<string, unknown>>(args: {
			model: string;
			update: D;
			where: Array<{ field: string; value: unknown }>;
		}): Promise<T | null> {
			const table = tables[args.model] ?? [];
			const row = table.find((r) => matches(r, args.where));
			if (!row) return null;
			const update = args.update as Record<string, unknown>;
			assertUnique(args.model, { ...row, ...update }, row);
			Object.assign(row, update, { updatedAt: new Date() });
			return row as T;
		},
		async findOne<T>(args: {
			model: string;
			where: Array<{ field: string; value: unknown }>;
		}): Promise<T | null> {
			const table = tables[args.model] ?? [];
			return (table.find((r) => matches(r, args.where)) as T | undefined) ?? null;
		},
		async findMany<T>(args: {
			model: string;
			where?: Array<{ field: string; value: unknown }>;
			limit?: number;
			offset?: number;
			sortBy?: { field: string; direction: "asc" | "desc" };
		}): Promise<T[]> {
			const table = tables[args.model] ?? [];
			let rows: Record<string, unknown>[] =
				!args.where || args.where.length === 0
					? [...table]
					: table.filter((r) => matches(r, args.where ?? []));
			if (args.sortBy) {
				const { field, direction } = args.sortBy;
				const sign = direction === "asc" ? 1 : -1;
				rows = [...rows].sort((a, b) => {
					const av = a[field] as number | string | Date;
					const bv = b[field] as number | string | Date;
					if (av === bv) return 0;
					return av > bv ? sign : -sign;
				});
			}
			const start = args.offset ?? 0;
			const end = args.limit !== undefined ? start + args.limit : undefined;
			return rows.slice(start, end) as T[];
		},
		async count(args: {
			model: string;
			where?: Array<{ field: string; value: unknown }>;
		}): Promise<number> {
			const table = tables[args.model] ?? [];
			if (!args.where || args.where.length === 0) return table.length;
			return table.filter((r) => matches(r, args.where ?? [])).length;
		},
		async delete(args: {
			model: string;
			where: Array<{ field: string; value: unknown }>;
		}): Promise<void> {
			const table = tables[args.model] ?? [];
			const idx = table.findIndex((r) => matches(r, args.where));
			if (idx >= 0) table.splice(idx, 1);
		},
	};
}

export function createMockSyncContext<
	A extends PluginAdapter = ReturnType<typeof createMockAdapter>,
>(
	adapter: A = createMockAdapter() as unknown as A,
): SyncContext & {
	adapter: A;
	logs: { error: string[]; warn: string[]; info: string[]; debug: string[] };
} {
	const logs = {
		error: [] as string[],
		warn: [] as string[],
		info: [] as string[],
		debug: [] as string[],
	};
	return {
		adapter,
		logs,
		context: {
			adapter,
			logger: {
				error: (msg: string) => logs.error.push(msg),
				warn: (msg: string) => logs.warn.push(msg),
				info: (msg: string) => logs.info.push(msg),
				debug: (msg: string) => logs.debug.push(msg),
			},
		},
	};
}

export function createMockSubscriptionRow(overrides: Partial<Subscription> = {}): Subscription {
	const now = new Date();
	return {
		id: overrides.id ?? `sub_row_${++nextId}`,
		referenceId: overrides.referenceId ?? "user-123",
		referenceType: overrides.referenceType ?? "user",
		activeSlotKey: overrides.activeSlotKey ?? null,
		streampaySubscriptionId: overrides.streampaySubscriptionId ?? null,
		streampayConsumerId: overrides.streampayConsumerId ?? "cons_mocked",
		streampayPaymentLinkId: overrides.streampayPaymentLinkId ?? null,
		plan: overrides.plan ?? "pro",
		planVersion: overrides.planVersion ?? null,
		productId: overrides.productId ?? "prod_pro",
		group: overrides.group ?? null,
		amountInSmallestUnit: overrides.amountInSmallestUnit ?? 9900,
		originalAmountInSmallestUnit: overrides.originalAmountInSmallestUnit ?? 9900,
		currency: overrides.currency ?? "SAR",
		billingInterval: overrides.billingInterval ?? "MONTH",
		billingIntervalCount: overrides.billingIntervalCount ?? 1,
		status: overrides.status ?? "incomplete",
		providerStatus: overrides.providerStatus ?? null,
		billingStatus: overrides.billingStatus ?? "current",
		periodStart: overrides.periodStart ?? null,
		periodEnd: overrides.periodEnd ?? null,
		currentCycleNumber: overrides.currentCycleNumber ?? null,
		trialStart: overrides.trialStart ?? null,
		trialEnd: overrides.trialEnd ?? null,
		cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
		cancelAt: overrides.cancelAt ?? null,
		cancelScheduledAt: overrides.cancelScheduledAt ?? null,
		canceledAt: overrides.canceledAt ?? null,
		pendingPlan: overrides.pendingPlan ?? null,
		pendingProductId: overrides.pendingProductId ?? null,
		pendingPlanEffectiveAt: overrides.pendingPlanEffectiveAt ?? null,
		endedAt: overrides.endedAt ?? null,
		frozenAt: overrides.frozenAt ?? null,
		freezeEndAt: overrides.freezeEndAt ?? null,
		providerUpdatedAt: overrides.providerUpdatedAt ?? null,
		syncedAt: overrides.syncedAt ?? null,
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
}

export function createMockWebhookPayload<E extends StreamPayWebhookPayload["event_type"]>(
	overrides: {
		event_type?: E;
		entity_type?: StreamPayWebhookPayload["entity_type"];
		entity_id?: string;
		entity_url?: string;
		status?: string;
		timestamp?: string;
		data?: StreamPayWebhookPayload["data"];
	} = {},
): StreamPayWebhookPayload {
	return {
		event_type: (overrides.event_type ?? "SUBSCRIPTION_CREATED") as never,
		entity_type: (overrides.entity_type ?? "SUBSCRIPTION") as never,
		entity_id: overrides.entity_id ?? "sub_abc123",
		entity_url: overrides.entity_url ?? "https://stream-app-service.streampay.sa/entity",
		status: overrides.status ?? "ACTIVE",
		timestamp: overrides.timestamp ?? "2026-01-01T00:00:00.000Z",
		data: overrides.data ?? {},
	};
}

export const __nextId = () => nextId;

export function trackedCallback<T extends (...args: unknown[]) => unknown>(impl?: T) {
	return vi.fn(impl ?? (() => undefined));
}
