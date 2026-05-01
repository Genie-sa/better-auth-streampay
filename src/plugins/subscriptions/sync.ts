import type { SubscriptionDetailed } from "@streamsdk/typescript";
import { z } from "zod";
import type { StreamPayClient } from "../../types";
import { StreamPayAmount } from "../../utils/amount";
import { readSdkErrorFields } from "../../utils/error-envelope";
import { asSessionUser, type StreamPaySessionUser } from "../../utils/session";
import type { StreamPayWebhookData, StreamPayWebhookPayload } from "../../webhooks/events";
import type { ResolvedPlans } from "./plans";
import {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	type Subscription,
	type SubscriptionCallbackData,
	type SubscriptionCallbacks,
	toLocalStatus,
} from "./types";

/** Subset of Better Auth's `context.adapter` this plugin calls. */
export interface PluginAdapter {
	create: <T = unknown, D extends object = Record<string, unknown>>(args: {
		model: string;
		data: D;
	}) => Promise<T>;
	update: <T = unknown, D extends object = Record<string, unknown>>(args: {
		model: string;
		update: D;
		where: Array<{ field: string; value: unknown }>;
	}) => Promise<T>;
	findOne: <T = unknown>(args: {
		model: string;
		where: Array<{ field: string; value: unknown }>;
	}) => Promise<T | null>;
	findMany: <T = unknown>(args: {
		model: string;
		where?: Array<{ field: string; value: unknown }>;
	}) => Promise<T[]>;
	delete: (args: {
		model: string;
		where: Array<{ field: string; value: unknown }>;
	}) => Promise<void>;
}

export interface SyncContext {
	context: {
		adapter: PluginAdapter;
		logger: {
			error: (msg: string) => void;
			warn: (msg: string) => void;
			info: (msg: string) => void;
			debug: (msg: string) => void;
		};
		session?: { user?: unknown };
		internalAdapter?: {
			findUserById?: (userId: string) => Promise<unknown>;
		};
	};
}

const SUBSCRIPTION_MODEL = "subscription";
const WEBHOOK_EVENT_MODEL = "streampayWebhookEvent";

// Adapters emit different shapes: Prisma P2002, Postgres 23505,
// better-sqlite3 SQLITE_CONSTRAINT_UNIQUE. Check a few known markers.
function isUniqueConstraintError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	if (/unique/i.test(message) || /duplicate/i.test(message)) return true;
	const code = "code" in err && typeof err.code === "string" ? err.code : "";
	return code === "P2002" || code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE";
}

/**
 * Claim a webhook event id via unique insert into the dedupe table.
 * Returns `true` if the claim succeeded (first delivery), `false` if
 * already processed. Protects every sync path — not just subscription-
 * row mutations — so events like INVOICE_COMPLETED can't double-fire.
 */
export async function claimWebhookEvent(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
): Promise<boolean> {
	const eventId = extractEventId(payload);
	// No composite key available — process without dedupe. Caller logs.
	if (!eventId) return true;
	try {
		await ctx.context.adapter.create({
			model: WEBHOOK_EVENT_MODEL,
			data: {
				eventId,
				eventType: payload.event_type,
				processedAt: new Date(),
			},
		});
		return true;
	} catch (err: unknown) {
		if (isUniqueConstraintError(err)) {
			ctx.context.logger.info(
				`StreamPay webhook ${payload.event_type} (${eventId}) already processed — skipping.`,
			);
			return false;
		}
		throw err;
	}
}

/** Inverse of `claimWebhookEvent`. Best-effort: a failed delete is
 *  logged loudly so the operator knows a stranded row will silently
 *  swallow the next retry. */
export async function releaseWebhookEvent(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
): Promise<void> {
	const eventId = extractEventId(payload);
	if (!eventId) return;
	try {
		await ctx.context.adapter.delete({
			model: WEBHOOK_EVENT_MODEL,
			where: [{ field: "eventId", value: eventId }],
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.context.logger.error(
			`StreamPay webhook ${payload.event_type} (${eventId}): failed to release dedupe claim after sync error — retry will be skipped: ${msg}`,
		);
	}
}

// StreamPay doesn't guarantee a top-level id on the envelope, so we
// derive a composite from fields that always exist.
function extractEventId(payload: StreamPayWebhookPayload): string | null {
	if (!payload.timestamp || !payload.entity_id) return null;
	return `${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
}

function readMetadataString(data: StreamPayWebhookData | undefined, key: string): string | null {
	if (!data?.metadata || typeof data.metadata !== "object") return null;
	const value = data.metadata[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

async function findSubscriptionByStreampayId(
	ctx: SyncContext,
	streampaySubscriptionId: string,
): Promise<Subscription | null> {
	return ctx.context.adapter.findOne<Subscription>({
		model: SUBSCRIPTION_MODEL,
		where: [{ field: "streampaySubscriptionId", value: streampaySubscriptionId }],
	});
}

/**
 * Project an already-fetched subscription onto the local row keyed by
 * `streampaySubscriptionId`. No-op + log on missing local row (mutate
 * targeted a sub we don't track) or DB failure (webhook reconciles).
 */
export async function applySubscriptionProjection(
	adapter: PluginAdapter,
	stream: SubscriptionDetailed | null | undefined,
	logger: { warn: (msg: string) => void },
	source: string,
): Promise<void> {
	const streampaySubscriptionId = stream?.id;
	if (!stream || !streampaySubscriptionId) return;
	try {
		const existing = await adapter.findOne<Subscription>({
			model: SUBSCRIPTION_MODEL,
			where: [{ field: "streampaySubscriptionId", value: streampaySubscriptionId }],
		});
		if (!existing) return;
		await adapter.update({
			model: SUBSCRIPTION_MODEL,
			update: projectSubscriptionFields(stream),
			where: [{ field: "id", value: existing.id }],
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn(
			`StreamPay ${source}: project for sub=${streampaySubscriptionId} failed (${msg}). Local row will reconcile on next webhook.`,
		);
	}
}

/** Refetch upstream then `applySubscriptionProjection`. Use when the
 *  caller doesn't already hold a fresh `SubscriptionDetailed`.  */
export async function syncSubscriptionFromUpstream(
	client: { getSubscription: (id: string) => Promise<SubscriptionDetailed> },
	adapter: PluginAdapter,
	streampaySubscriptionId: string,
	logger: { warn: (msg: string) => void },
	source: string,
): Promise<void> {
	let stream: SubscriptionDetailed;
	try {
		stream = await client.getSubscription(streampaySubscriptionId);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn(
			`StreamPay ${source}: getSubscription(${streampaySubscriptionId}) failed (${msg}). Local row will reconcile on next webhook.`,
		);
		return;
	}
	await applySubscriptionProjection(adapter, stream, logger, source);
}

async function findIncompleteRow(
	ctx: SyncContext,
	referenceId: string,
	plan: string,
): Promise<Subscription | null> {
	const candidates = await ctx.context.adapter.findMany<Subscription>({
		model: SUBSCRIPTION_MODEL,
		where: [
			{ field: "referenceId", value: referenceId },
			{ field: "plan", value: plan },
			{ field: "status", value: "incomplete" },
		],
	});
	if (candidates.length === 0) return null;
	return candidates.reduce((newest, candidate) =>
		candidate.createdAt > newest.createdAt ? candidate : newest,
	);
}

/**
 * Project live StreamPay fields onto our table columns. Never touches
 * `referenceId`, `plan`, or `group` — those are set at /upgrade and
 * must not drift.
 */
export function projectSubscriptionFields(sub: SubscriptionDetailed): Record<string, unknown> {
	return {
		streampaySubscriptionId: sub.id ?? null,
		streampayConsumerId: sub.organization_consumer_id ?? null,
		amountHalalat: amountToHalalat(sub.amount),
		currency: sub.currency ?? null,
		billingInterval: sub.recurring_interval ?? null,
		billingIntervalCount: sub.recurring_interval_count ?? null,
		status: toLocalStatus(sub.status),
		periodStart: parseDate(sub.current_period_start),
		periodEnd: parseDate(sub.current_period_end),
		cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
		endedAt: parseDate(sub.ended_at),
		frozenAt: sub.status === "FROZEN" ? parseDate(sub.latest_freeze?.freeze_start_datetime) : null,
		freezeEndAt: sub.status === "FROZEN" ? parseDate(sub.latest_freeze?.freeze_end_datetime) : null,
		updatedAt: new Date(),
	};
}

function parseDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

// StreamPay returns amounts as decimal SAR strings ("10.50"). Store
// as integer halalat to avoid float drift across reads.
function amountToHalalat(value: string | null | undefined): number | null {
	if (!value) return null;
	try {
		return StreamPayAmount.toHalalat(value);
	} catch {
		return null;
	}
}

async function resolveRowUser(
	ctx: SyncContext,
	row: Subscription,
): Promise<StreamPaySessionUser | null> {
	const findUserById = ctx.context.internalAdapter?.findUserById;
	if (!findUserById) return null;
	try {
		const user = await findUserById(row.referenceId);
		return asSessionUser(user);
	} catch {
		return null;
	}
}

// Swallow userland errors — dedupe protects against re-fire on retry.
async function fireCallback(
	ctx: SyncContext,
	callback: SubscriptionCallbacks[keyof SubscriptionCallbacks] | undefined,
	data: SubscriptionCallbackData,
	callbackName: string,
): Promise<void> {
	if (!callback) return;
	try {
		await callback(data);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.context.logger.error(`StreamPay subscription callback ${callbackName} failed: ${msg}`);
	}
}

async function reconcileFromStreamPay(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
): Promise<{ row: Subscription | null; stream: SubscriptionDetailed | null }> {
	const streampaySubscriptionId = payload.entity_id;
	if (!streampaySubscriptionId) {
		ctx.context.logger.warn(
			`StreamPay webhook ${payload.event_type} has no entity_id — cannot reconcile.`,
		);
		return { row: null, stream: null };
	}

	let stream: SubscriptionDetailed;
	try {
		stream = await client.getSubscription(streampaySubscriptionId);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.context.logger.error(
			`StreamPay webhook ${payload.event_type}: getSubscription(${streampaySubscriptionId}) failed: ${msg}`,
		);
		// Throw → 500 → StreamPay retries with backoff. Permanent 404s
		// stay in the retry loop; operators flag via logs.
		throw err;
	}

	const existing = await findSubscriptionByStreampayId(ctx, streampaySubscriptionId);
	const projected = projectSubscriptionFields(stream);

	if (existing) {
		const updated = await ctx.context.adapter.update<Subscription>({
			model: SUBSCRIPTION_MODEL,
			update: projected,
			where: [{ field: "id", value: existing.id }],
		});
		return { row: updated ?? { ...existing, ...(projected as Partial<Subscription>) }, stream };
	}

	// No row keyed by streampaySubscriptionId yet. Fall back to the
	// incomplete row pre-created at /upgrade if metadata is present.
	const planName =
		readMetadataString(payload.data, PLAN_NAME_METADATA_KEY) ?? inferPlanFromItems(stream, plans);
	const referenceId = readMetadataString(payload.data, REFERENCE_ID_METADATA_KEY);

	if (!planName || !referenceId) {
		ctx.context.logger.warn(
			`StreamPay webhook ${payload.event_type}: cannot link sub=${streampaySubscriptionId} — missing plan_name (${planName}) or reference_id (${referenceId}) metadata.`,
		);
		return { row: null, stream };
	}

	const incomplete = await findIncompleteRow(ctx, referenceId, planName);
	if (incomplete) {
		const updated = await ctx.context.adapter.update<Subscription>({
			model: SUBSCRIPTION_MODEL,
			update: projected,
			where: [{ field: "id", value: incomplete.id }],
		});
		return {
			row: updated ?? { ...incomplete, ...(projected as Partial<Subscription>) },
			stream,
		};
	}

	// Dashboard-created subscription (outside our /upgrade flow).
	const plan = plans.byName.get(planName);
	const row = await ctx.context.adapter.create<Subscription>({
		model: SUBSCRIPTION_MODEL,
		data: {
			...projected,
			referenceId,
			plan: planName,
			group: plan?.group ?? null,
			createdAt: new Date(),
		},
	});
	return { row, stream };
}

const SubscriptionItemSchema = z
	.object({
		product: z.object({ id: z.string() }).passthrough().optional(),
		product_id: z.string().optional(),
	})
	.passthrough();

// Best-effort fallback when metadata is missing; relies on plans
// declaring distinct productIds.
function inferPlanFromItems(sub: SubscriptionDetailed, plans: ResolvedPlans): string | null {
	const first = Array.isArray(sub.items) ? sub.items[0] : undefined;
	const parsed = SubscriptionItemSchema.safeParse(first);
	if (!parsed.success) return null;
	const productId = parsed.data.product?.id ?? parsed.data.product_id;
	if (!productId) return null;
	return plans.list.find((plan) => plan.productId === productId)?.name ?? null;
}

/**
 * Webhook sync entry. Called before userland handlers for every
 * payload. Must be idempotent. Only throws on transient failures —
 * permanent bad-data modes log and return so StreamPay stops retrying.
 */
export async function syncWebhookPayload(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
	callbacks: SubscriptionCallbacks,
	options: { dedupe?: boolean } = {},
): Promise<void> {
	if (payload.entity_type !== "SUBSCRIPTION" && payload.event_type !== "INVOICE_COMPLETED") {
		return;
	}

	const dedupe = options.dedupe !== false;
	if (dedupe) {
		const claimed = await claimWebhookEvent(ctx, payload);
		if (!claimed) return;
	}

	try {
		// INVOICE_COMPLETED → renewal inference (no native SUBSCRIPTION_RENEWED event).
		if (payload.event_type === "INVOICE_COMPLETED") {
			await handleInvoiceCompleted(ctx, payload, client, plans, callbacks);
			return;
		}

		const { row, stream } = await reconcileFromStreamPay(ctx, payload, client, plans);
		if (!row) return;

		const user = await resolveRowUser(ctx, row);
		const data: SubscriptionCallbackData = {
			subscription: row,
			streampaySubscription: stream,
			user,
			event: payload,
		};

		await dispatchSubscriptionCallback(ctx, payload, data, callbacks);
	} catch (err) {
		if (dedupe) await releaseWebhookEvent(ctx, payload);
		throw err;
	}
}

async function handleInvoiceCompleted(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	_plans: ResolvedPlans,
	callbacks: SubscriptionCallbacks,
): Promise<void> {
	const invoiceId = payload.data?.invoice?.id ?? payload.entity_id;
	if (!invoiceId) return;
	let subscriptionId: string | null = null;
	try {
		const invoice = await client.getInvoice(invoiceId);
		if (invoice && typeof invoice === "object" && "subscription_id" in invoice) {
			const subId = invoice.subscription_id;
			if (typeof subId === "string" && subId.length > 0) subscriptionId = subId;
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.context.logger.error(
			`StreamPay INVOICE_COMPLETED: getInvoice(${invoiceId}) failed: ${msg}`,
		);
		throw err;
	}

	if (!subscriptionId) return;

	let stream: SubscriptionDetailed;
	try {
		stream = await client.getSubscription(subscriptionId);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.context.logger.error(
			`StreamPay INVOICE_COMPLETED: getSubscription(${subscriptionId}) failed: ${msg}`,
		);
		throw err;
	}

	const existing = await findSubscriptionByStreampayId(ctx, subscriptionId);
	if (!existing) return;

	const updated = await ctx.context.adapter.update<Subscription>({
		model: SUBSCRIPTION_MODEL,
		update: projectSubscriptionFields(stream),
		where: [{ field: "id", value: existing.id }],
	});
	const row =
		updated ?? ({ ...existing, ...projectSubscriptionFields(stream) } as unknown as Subscription);

	const user = await resolveRowUser(ctx, row);
	await fireCallback(
		ctx,
		callbacks.onSubscriptionRenewed,
		{ subscription: row, streampaySubscription: stream, user, event: payload },
		"onSubscriptionRenewed",
	);
}

async function dispatchSubscriptionCallback(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	data: SubscriptionCallbackData,
	callbacks: SubscriptionCallbacks,
): Promise<void> {
	switch (payload.event_type) {
		case "SUBSCRIPTION_CREATED":
			await fireCallback(ctx, callbacks.onSubscriptionCreated, data, "onSubscriptionCreated");
			return;
		case "SUBSCRIPTION_ACTIVATED":
			await fireCallback(ctx, callbacks.onSubscriptionActivated, data, "onSubscriptionActivated");
			return;
		case "SUBSCRIPTION_CANCELED":
			await fireCallback(ctx, callbacks.onSubscriptionCanceled, data, "onSubscriptionCanceled");
			return;
		case "SUBSCRIPTION_FROZEN":
		case "SUBSCRIPTION_FREEZE_NOW":
			await fireCallback(ctx, callbacks.onSubscriptionFrozen, data, "onSubscriptionFrozen");
			return;
		case "SUBSCRIPTION_UNFREEZE_NOW":
		case "SUBSCRIPTION_FREEZE_CANCEL":
			await fireCallback(ctx, callbacks.onSubscriptionResumed, data, "onSubscriptionResumed");
			return;
		case "SUBSCRIPTION_CYCLE_RENEWAL_FAILED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionPaymentFailed,
				data,
				"onSubscriptionPaymentFailed",
			);
			return;
		default:
			return;
	}
}

/** Permanent → 400 (stop retry). Transient → 500 (retry with backoff). */
export type WebhookSyncFailure = "PERMANENT" | "TRANSIENT";

export function classifyWebhookFailure(err: unknown): WebhookSyncFailure {
	const { status } = readSdkErrorFields(err);
	if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
		return "PERMANENT";
	}
	return "TRANSIENT";
}
