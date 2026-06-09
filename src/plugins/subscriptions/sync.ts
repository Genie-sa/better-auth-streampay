import type { SubscriptionDetailed } from "@streamsdk/typescript";
import { z } from "zod";
import type { StreamPayClient } from "../../types";
import { StreamPayAmount } from "../../utils/amount";
import { readSdkErrorFields } from "../../utils/error-envelope";
import { type ScopedLogger, scopedLogger } from "../../utils/logger";
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
		limit?: number;
		offset?: number;
		sortBy?: { field: string; direction: "asc" | "desc" };
	}) => Promise<T[]>;
	delete: (args: {
		model: string;
		where: Array<{ field: string; value: unknown }>;
	}) => Promise<void>;
	count: (args: {
		model: string;
		where?: Array<{ field: string; value: unknown }>;
	}) => Promise<number>;
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
export const WEBHOOK_EVENT_MODEL = "streampayWebhookEvent";

function logger(ctx: SyncContext): ScopedLogger {
	return scopedLogger(ctx.context.logger);
}

export const DEFAULT_MAX_WEBHOOK_ATTEMPTS = 5;

export type WebhookEventStatus = "pending" | "completed" | "dead_letter";

export interface WebhookEventRow {
	id: string;
	eventId: string;
	eventType: string;
	status: WebhookEventStatus;
	attemptCount: number;
	processedAt: Date;
	firstSeenAt: Date | null;
	rawPayload: string | null;
	signatureHeader: string | null;
	lastError: string | null;
}

const MAX_CAUSE_DEPTH = 5;

function matchesUniqueMarker(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	if (/unique/i.test(message) || /duplicate/i.test(message)) return true;
	const code = "code" in err && typeof err.code === "string" ? err.code : "";
	return code === "P2002" || code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE";
}

function isUniqueConstraintError(err: unknown): boolean {
	let current: unknown = err;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
		if (matchesUniqueMarker(current)) return true;
		if (!current || typeof current !== "object" || !("cause" in current)) return false;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

export type ClaimAdvanceResult =
	| { action: "process"; row: WebhookEventRow | null }
	| { action: "skip"; reason: "completed" | "dead_letter" }
	| { action: "dead_letter"; row: WebhookEventRow };

export async function claimOrAdvanceWebhookEvent(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	rawBody: string | null,
	signatureHeader: string | null,
	maxAttempts: number,
): Promise<ClaimAdvanceResult> {
	const eventId = extractEventId(payload);
	if (!eventId) {
		logger(ctx).warn(
			`webhook ${payload.event_type}: missing entity_id/timestamp — processing without dedupe.`,
		);
		return { action: "process", row: null };
	}

	const now = new Date();

	try {
		const inserted = await ctx.context.adapter.create<WebhookEventRow>({
			model: WEBHOOK_EVENT_MODEL,
			data: {
				eventId,
				eventType: payload.event_type,
				status: "pending",
				attemptCount: 1,
				processedAt: now,
				firstSeenAt: now,
			},
		});
		return { action: "process", row: inserted };
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
	}

	const existing = await ctx.context.adapter.findOne<WebhookEventRow>({
		model: WEBHOOK_EVENT_MODEL,
		where: [{ field: "eventId", value: eventId }],
	});
	if (!existing) {
		logger(ctx).warn(
			`webhook ${payload.event_type} (${eventId}): unique conflict but row missing, processing without tracking.`,
		);
		return { action: "process", row: null };
	}

	if (existing.status === "completed") {
		logger(ctx).info(`webhook ${payload.event_type} (${eventId}) already completed — skipping.`);
		return { action: "skip", reason: "completed" };
	}
	if (existing.status === "dead_letter") {
		logger(ctx).warn(
			`webhook ${payload.event_type} (${eventId}) already dead-lettered — skipping (replay manually).`,
		);
		return { action: "skip", reason: "dead_letter" };
	}

	const nextAttempt = (existing.attemptCount ?? 0) + 1;
	if (nextAttempt > maxAttempts) {
		const updated = await ctx.context.adapter.update<WebhookEventRow>({
			model: WEBHOOK_EVENT_MODEL,
			update: {
				status: "dead_letter",
				attemptCount: nextAttempt,
				processedAt: now,
				rawPayload: rawBody,
				signatureHeader,
			},
			where: [{ field: "id", value: existing.id }],
		});
		return { action: "dead_letter", row: updated ?? existing };
	}

	const updated = await ctx.context.adapter.update<WebhookEventRow>({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			attemptCount: nextAttempt,
			processedAt: now,
		},
		where: [{ field: "id", value: existing.id }],
	});
	return { action: "process", row: updated ?? existing };
}

export async function markWebhookEventCompleted(
	ctx: { context: { adapter: PluginAdapter } },
	rowId: string,
): Promise<void> {
	await ctx.context.adapter.update({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			status: "completed",
			processedAt: new Date(),
			rawPayload: null,
			signatureHeader: null,
			lastError: null,
		},
		where: [{ field: "id", value: rowId }],
	});
}

export async function recordWebhookEventFailure(
	ctx: { context: { adapter: PluginAdapter } },
	rowId: string,
	rawBody: string | null,
	signatureHeader: string | null,
	err: unknown,
): Promise<void> {
	const lastError = err instanceof Error ? err.message : String(err);
	await ctx.context.adapter.update({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			processedAt: new Date(),
			lastError,
			...(rawBody !== null ? { rawPayload: rawBody } : {}),
			...(signatureHeader !== null ? { signatureHeader } : {}),
		},
		where: [{ field: "id", value: rowId }],
	});
}

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

export async function applySubscriptionProjection(
	adapter: PluginAdapter,
	stream: SubscriptionDetailed | null | undefined,
	log: { warn: (msg: string) => void },
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
		log.warn(
			`${source}: project for sub=${streampaySubscriptionId} failed (${msg}). Local row will reconcile on next webhook.`,
		);
	}
}

export async function syncSubscriptionFromUpstream(
	client: { getSubscription: (id: string) => Promise<SubscriptionDetailed> },
	adapter: PluginAdapter,
	streampaySubscriptionId: string,
	log: { warn: (msg: string) => void },
	source: string,
): Promise<void> {
	let stream: SubscriptionDetailed;
	try {
		stream = await client.getSubscription(streampaySubscriptionId);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.warn(
			`${source}: getSubscription(${streampaySubscriptionId}) failed (${msg}). Local row will reconcile on next webhook.`,
		);
		return;
	}
	await applySubscriptionProjection(adapter, stream, log, source);
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

export function projectSubscriptionFields(sub: SubscriptionDetailed): Partial<Subscription> {
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
		logger(ctx).error(`subscription callback ${callbackName} failed: ${msg}`);
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
		logger(ctx).warn(`webhook ${payload.event_type} has no entity_id — cannot reconcile.`);
		return { row: null, stream: null };
	}

	let stream: SubscriptionDetailed;
	try {
		stream = await client.getSubscription(streampaySubscriptionId);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger(ctx).error(
			`webhook ${payload.event_type}: getSubscription(${streampaySubscriptionId}) failed: ${msg}`,
		);
		throw err;
	}

	const existing = await findSubscriptionByStreampayId(ctx, streampaySubscriptionId);
	const projected = projectSubscriptionFields(stream);
	if (payload.event_type === "SUBSCRIPTION_CYCLE_RENEWAL_FAILED" && projected.status === "active") {
		projected.status = "past_due";
	}

	if (existing) {
		const updated = await ctx.context.adapter.update<Subscription>({
			model: SUBSCRIPTION_MODEL,
			update: projected,
			where: [{ field: "id", value: existing.id }],
		});
		return { row: updated ?? { ...existing, ...projected }, stream };
	}

	const planName =
		readMetadataString(payload.data, PLAN_NAME_METADATA_KEY) ?? inferPlanFromItems(stream, plans);
	const referenceId = readMetadataString(payload.data, REFERENCE_ID_METADATA_KEY);

	if (!planName || !referenceId) {
		logger(ctx).warn(
			`webhook ${payload.event_type}: cannot link sub=${streampaySubscriptionId} — missing plan_name (${planName}) or reference_id (${referenceId}) metadata.`,
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
			row: updated ?? { ...incomplete, ...projected },
			stream,
		};
	}

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

export function subscriptionItemProductId(item: unknown): string | null {
	const parsed = SubscriptionItemSchema.safeParse(item);
	if (!parsed.success) return null;
	return parsed.data.product?.id ?? parsed.data.product_id ?? null;
}

function inferPlanFromItems(sub: SubscriptionDetailed, plans: ResolvedPlans): string | null {
	const first = Array.isArray(sub.items) ? sub.items[0] : undefined;
	const productId = subscriptionItemProductId(first);
	if (!productId) return null;
	return plans.list.find((plan) => plan.productId === productId)?.name ?? null;
}

export async function syncWebhookPayload(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
	callbacks: SubscriptionCallbacks,
	options: {
		dedupe?: boolean;
		rawBody?: string | null;
		signatureHeader?: string | null;
		maxAttempts?: number;
	} = {},
): Promise<void> {
	if (payload.entity_type !== "SUBSCRIPTION" && payload.event_type !== "INVOICE_COMPLETED") {
		return;
	}

	const dedupe = options.dedupe !== false;
	const rawBody = options.rawBody ?? null;
	const signatureHeader = options.signatureHeader ?? null;
	const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS);

	let claim: ClaimAdvanceResult = { action: "process", row: null };
	if (dedupe) {
		claim = await claimOrAdvanceWebhookEvent(ctx, payload, rawBody, signatureHeader, maxAttempts);
		if (claim.action === "skip") return;
		if (claim.action === "dead_letter") {
			logger(ctx).warn(
				`webhook ${payload.event_type} (${claim.row.eventId}) dead-lettered after ${claim.row.attemptCount} attempts. Replay manually.`,
			);
			return;
		}
	}
	const trackedRowId = claim.row?.id ?? null;

	try {
		if (payload.event_type === "INVOICE_COMPLETED") {
			await handleInvoiceCompleted(ctx, payload, client, plans, callbacks);
		} else {
			const { row, stream } = await reconcileFromStreamPay(ctx, payload, client, plans);
			if (row) {
				const user = await resolveRowUser(ctx, row);
				const data: SubscriptionCallbackData = {
					subscription: row,
					streampaySubscription: stream,
					user,
					event: payload,
				};
				await dispatchSubscriptionCallback(ctx, payload, data, callbacks);
			}
		}

		if (trackedRowId) await markWebhookEventCompleted(ctx, trackedRowId);
	} catch (err) {
		if (trackedRowId) {
			await recordWebhookEventFailure(ctx, trackedRowId, rawBody, signatureHeader, err);
		}
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
		logger(ctx).error(`INVOICE_COMPLETED: getInvoice(${invoiceId}) failed: ${msg}`);
		throw err;
	}

	if (!subscriptionId) return;

	let stream: SubscriptionDetailed;
	try {
		stream = await client.getSubscription(subscriptionId);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger(ctx).error(`INVOICE_COMPLETED: getSubscription(${subscriptionId}) failed: ${msg}`);
		throw err;
	}

	const existing = await findSubscriptionByStreampayId(ctx, subscriptionId);
	if (!existing) return;

	const projected = projectSubscriptionFields(stream);
	const updated = await ctx.context.adapter.update<Subscription>({
		model: SUBSCRIPTION_MODEL,
		update: projected,
		where: [{ field: "id", value: existing.id }],
	});
	const row = updated ?? { ...existing, ...projected };

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

export type WebhookSyncFailure = "PERMANENT" | "TRANSIENT";

export function classifyWebhookFailure(err: unknown): WebhookSyncFailure {
	const { status } = readSdkErrorFields(err);
	if (status === undefined) return "TRANSIENT";
	if (status === 404 || status === 429) return "TRANSIENT";
	if (status >= 400 && status < 500) return "PERMANENT";
	return "TRANSIENT";
}
