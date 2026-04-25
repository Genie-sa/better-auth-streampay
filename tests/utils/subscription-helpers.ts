import { vi } from "vitest";
import type {
	PluginAdapter,
	Subscription,
	SubscriptionStatus,
	SyncContext,
} from "../../src/plugins/subscriptions";
import type { StreamPayWebhookPayload } from "../../src/webhooks/events";

let nextId = 0;

/**
 * In-memory Better Auth adapter stub. Stores rows keyed by `model`
 * name, supports find/findMany/create/update/delete with the query
 * predicate shape our plugin actually uses. Throws a unique-
 * constraint-shaped error on duplicate inserts into columns that the
 * real schema marks as `unique`, mirroring how Drizzle/Prisma behave.
 */
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
		subscription: ["streampaySubscriptionId"],
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

	function assertUnique(model: string, data: Record<string, unknown>): void {
		const uniques = uniqueByModel[model];
		if (!uniques || !tables[model]) return;
		for (const field of uniques) {
			const value = data[field];
			if (value === undefined || value === null) continue;
			const clash = tables[model].find((row) => row[field] === value);
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
		}): Promise<T> {
			const table = tables[args.model] ?? [];
			const row = table.find((r) => matches(r, args.where));
			if (!row) throw new Error(`no row in ${args.model} for ${JSON.stringify(args.where)}`);
			Object.assign(row, args.update as Record<string, unknown>, { updatedAt: new Date() });
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
		}): Promise<T[]> {
			const table = tables[args.model] ?? [];
			if (!args.where || args.where.length === 0) return [...(table as T[])];
			return table.filter((r) => matches(r, args.where ?? [])) as T[];
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

/**
 * Build a minimal `SyncContext` — just an adapter + a logger. Used by
 * direct-unit tests of `syncWebhookPayload` that bypass the HTTP
 * endpoint entirely.
 */
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

/**
 * Build a local `subscription` row with sensible defaults. Every
 * field is overridable via the partial arg.
 */
export function createMockSubscriptionRow(overrides: Partial<Subscription> = {}): Subscription {
	const now = new Date();
	return {
		id: overrides.id ?? `sub_row_${++nextId}`,
		referenceId: overrides.referenceId ?? "user-123",
		streampaySubscriptionId: overrides.streampaySubscriptionId ?? null,
		streampayConsumerId: overrides.streampayConsumerId ?? "cons_mocked",
		plan: overrides.plan ?? "pro",
		group: overrides.group ?? null,
		amountHalalat: overrides.amountHalalat ?? 9900,
		currency: overrides.currency ?? "SAR",
		billingInterval: overrides.billingInterval ?? "MONTH",
		billingIntervalCount: overrides.billingIntervalCount ?? 1,
		status: (overrides.status ?? "incomplete") as SubscriptionStatus,
		periodStart: overrides.periodStart ?? null,
		periodEnd: overrides.periodEnd ?? null,
		cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
		endedAt: overrides.endedAt ?? null,
		frozenAt: overrides.frozenAt ?? null,
		freezeEndAt: overrides.freezeEndAt ?? null,
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
}

/**
 * Build a webhook payload — defaults to a SUBSCRIPTION_CREATED event.
 * Override `event_type`, `entity_id`, and `data.metadata` to target
 * specific sync paths.
 */
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

/**
 * Silence the reference to `nextId` being otherwise used only for id
 * generation — keeps the bundler happy without an `_unused` prefix.
 */
export const __nextId = () => nextId;

/**
 * Convenience assertion builder — produces a `vi.fn` wrapper that
 * records call order without requiring tests to thread counters.
 */
export function trackedCallback<T extends (...args: unknown[]) => unknown>(impl?: T) {
	return vi.fn(impl ?? (() => undefined));
}
