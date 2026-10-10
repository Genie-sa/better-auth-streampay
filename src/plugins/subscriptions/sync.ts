import { randomUUID } from "node:crypto";
import type { SubscriptionDetailed } from "@streamsdk/typescript";
import type { StreamPayClient } from "../../types";
import { readEnvelope, readSdkErrorFields } from "../../utils/error-envelope";
import { type ScopedLogger, scopedLogger } from "../../utils/logger";
import { asSessionUser, type StreamPaySessionUser } from "../../utils/session";
import type {
	StreamPayWebhookData,
	StreamPayWebhookEnvelope,
	StreamPayWebhookPayload,
} from "../../webhooks/events";
import type { PluginAdapter } from "./adapter";
import type { ResolvedPlans } from "./plans";
import {
	inferPlanFromItems,
	parseDate,
	projectPlanFields,
	projectSubscriptionFields,
	reconcileProjectionAgainstExisting,
	subscriptionItemProductId,
} from "./reconcile";
import { isTerminalSubscriptionStatus, toLocalStatus } from "./status";
import {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	REFERENCE_TYPE_METADATA_KEY,
	SUBSCRIPTION_ROW_ID_METADATA_KEY,
	type Subscription,
	type SubscriptionCallbackData,
	type SubscriptionCallbacks,
	type SubscriptionReferenceType,
	subscriptionSlotKey,
} from "./types";

export type { PluginAdapter } from "./adapter";
export {
	applySubscriptionProjection,
	projectSubscriptionFields,
	subscriptionItemProductId,
	syncSubscriptionFromUpstream,
} from "./reconcile";

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
	receivedAt: Date;
	lastAttemptAt: Date | null;
	nextAttemptAt: Date | null;
	completedAt: Date | null;
	deadLetteredAt: Date | null;
	lockedAt: Date | null;
	lockedBy: string | null;
	rawPayload: string | null;
	signatureHeader: string | null;
	lastError: string | null;
	lastErrorCode: string | null;
}

const MAX_CAUSE_DEPTH = 5;

function matchesUniqueMarker(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	if (/unique/i.test(message) || /duplicate/i.test(message)) return true;
	const code = "code" in err && typeof err.code === "string" ? err.code : "";
	return code === "P2002" || code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE";
}

export function isUniqueConstraintError(err: unknown): boolean {
	let current: unknown = err;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
		if (matchesUniqueMarker(current)) return true;
		if (!current || typeof current !== "object" || !("cause" in current)) return false;
		current = current.cause;
	}
	return false;
}

export type ClaimAdvanceResult =
	| { action: "process"; row: WebhookEventRow | null }
	| { action: "skip"; reason: "completed" | "dead_letter" | "in_progress" }
	| { action: "dead_letter"; row: WebhookEventRow };

export const WEBHOOK_PROCESSING_LEASE_MS = 2 * 60 * 1000;
const WEBHOOK_RETRY_DELAYS_MS = [5, 30, 120, 360, 720].map((minutes) => minutes * 60 * 1000);

export async function claimOrAdvanceWebhookEvent(
	ctx: SyncContext,
	payload: StreamPayWebhookEnvelope,
	rawBody: string | null,
	signatureHeader: string | null,
	maxAttempts: number,
	scope?: string,
): Promise<ClaimAdvanceResult> {
	const sourceEventId = extractEventId(payload);
	const eventId = sourceEventId && (scope ? `${scope}:${sourceEventId}` : sourceEventId);
	if (!eventId) {
		logger(ctx).warn(
			`webhook ${payload.event_type}: missing entity_id/timestamp — processing without dedupe.`,
		);
		return { action: "process", row: null };
	}

	const now = new Date();
	const lockId = randomUUID();

	try {
		const inserted = await ctx.context.adapter.create<WebhookEventRow>({
			model: WEBHOOK_EVENT_MODEL,
			data: {
				eventId,
				eventType: payload.event_type,
				status: "pending",
				attemptCount: 1,
				receivedAt: now,
				lastAttemptAt: now,
				lockedAt: now,
				lockedBy: lockId,
				rawPayload: rawBody,
				signatureHeader,
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
		throw new Error(
			`Webhook inbox row missing after unique conflict for ${eventId}; retry delivery.`,
		);
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
	if (
		existing.lockedAt instanceof Date &&
		now.getTime() - existing.lockedAt.getTime() < WEBHOOK_PROCESSING_LEASE_MS
	) {
		logger(ctx).info(
			`webhook ${payload.event_type} (${eventId}) is already being processed — skipping concurrent delivery.`,
		);
		return { action: "skip", reason: "in_progress" };
	}

	const nextAttempt = (existing.attemptCount ?? 0) + 1;
	if (nextAttempt > maxAttempts) {
		const updated = await ctx.context.adapter.update<WebhookEventRow>({
			model: WEBHOOK_EVENT_MODEL,
			update: {
				status: "dead_letter",
				attemptCount: nextAttempt,
				lastAttemptAt: now,
				deadLetteredAt: now,
				nextAttemptAt: null,
				rawPayload: rawBody,
				signatureHeader,
				lockedAt: null,
				lockedBy: null,
			},
			where: [
				{ field: "id", value: existing.id },
				{ field: "status", value: "pending" },
				{ field: "lockedAt", value: existing.lockedAt ?? null },
			],
		});
		return updated
			? { action: "dead_letter", row: updated }
			: { action: "skip", reason: "in_progress" };
	}

	const updated = await ctx.context.adapter.update<WebhookEventRow>({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			attemptCount: nextAttempt,
			lastAttemptAt: now,
			nextAttemptAt: null,
			lockedAt: now,
			lockedBy: lockId,
		},
		where: [
			{ field: "id", value: existing.id },
			{ field: "status", value: "pending" },
			{ field: "lockedAt", value: existing.lockedAt ?? null },
		],
	});
	return updated ? { action: "process", row: updated } : { action: "skip", reason: "in_progress" };
}

export async function claimWebhookEventForReplay(
	ctx: SyncContext,
	row: WebhookEventRow,
): Promise<WebhookEventRow | null> {
	const now = new Date();
	if (
		row.lockedAt instanceof Date &&
		now.getTime() - row.lockedAt.getTime() < WEBHOOK_PROCESSING_LEASE_MS
	) {
		return null;
	}
	return ctx.context.adapter.update<WebhookEventRow>({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			status: "pending",
			attemptCount: (row.attemptCount ?? 0) + 1,
			lastAttemptAt: now,
			nextAttemptAt: null,
			completedAt: null,
			deadLetteredAt: null,
			lockedAt: now,
			lockedBy: randomUUID(),
		},
		where: [
			{ field: "id", value: row.id },
			{ field: "status", value: row.status },
			{ field: "lockedAt", value: row.lockedAt ?? null },
		],
	});
}

export async function markWebhookEventCompleted(
	ctx: { context: { adapter: PluginAdapter } },
	rowId: string,
	lockId?: string,
): Promise<void> {
	await ctx.context.adapter.update({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			status: "completed",
			completedAt: new Date(),
			nextAttemptAt: null,
			lockedAt: null,
			lockedBy: null,
			rawPayload: null,
			signatureHeader: null,
			lastError: null,
			lastErrorCode: null,
		},
		where: [
			{ field: "id", value: rowId },
			...(lockId ? [{ field: "lockedBy", value: lockId }] : []),
		],
	});
}

export async function recordWebhookEventFailure(
	ctx: { context: { adapter: PluginAdapter } },
	rowId: string,
	rawBody: string | null,
	signatureHeader: string | null,
	err: unknown,
	lockId?: string,
	deadLetter = false,
): Promise<void> {
	const lastError = err instanceof Error ? err.message : String(err);
	const sdkError = readSdkErrorFields(err);
	const lastErrorCode =
		readEnvelope(sdkError.body)?.code ??
		(sdkError.status !== undefined
			? `HTTP_${sdkError.status}`
			: err instanceof Error
				? err.name
				: "UNKNOWN");
	const row = await ctx.context.adapter.findOne<WebhookEventRow>({
		model: WEBHOOK_EVENT_MODEL,
		where: [
			{ field: "id", value: rowId },
			...(lockId ? [{ field: "lockedBy", value: lockId }] : []),
		],
	});
	const attemptCount = row?.attemptCount ?? 1;
	const retryDelay =
		WEBHOOK_RETRY_DELAYS_MS[Math.min(attemptCount - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)];
	const now = new Date();
	await ctx.context.adapter.update({
		model: WEBHOOK_EVENT_MODEL,
		update: {
			...(deadLetter ? { status: "dead_letter", deadLetteredAt: now } : {}),
			lastAttemptAt: now,
			nextAttemptAt:
				deadLetter || retryDelay === undefined ? null : new Date(now.getTime() + retryDelay),
			lockedAt: null,
			lockedBy: null,
			lastError,
			lastErrorCode,
			...(rawBody !== null ? { rawPayload: rawBody } : {}),
			...(signatureHeader !== null ? { signatureHeader } : {}),
		},
		where: [
			{ field: "id", value: rowId },
			...(lockId ? [{ field: "lockedBy", value: lockId }] : []),
		],
	});
}

function extractEventId(payload: StreamPayWebhookEnvelope): string | null {
	if (!payload.timestamp || !payload.entity_id) return null;
	return `${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
}

function readMetadataString(data: StreamPayWebhookData | undefined, key: string): string | null {
	if (!data?.metadata || typeof data.metadata !== "object") return null;
	const value = data.metadata[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readReferenceType(
	data: StreamPayWebhookData | undefined,
): SubscriptionReferenceType | null {
	const value = readMetadataString(data, REFERENCE_TYPE_METADATA_KEY);
	return value === "user" || value === "organization" || value === "custom" ? value : null;
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

async function findIncompleteRow(
	ctx: SyncContext,
	referenceId: string,
	referenceType: SubscriptionReferenceType | null,
	plan: string,
	paymentLinkId: string | null,
	consumerId: string | null,
): Promise<Subscription | null> {
	const candidates = await ctx.context.adapter.findMany<Subscription>({
		model: SUBSCRIPTION_MODEL,
		where: [
			{ field: "referenceId", value: referenceId },
			{ field: "plan", value: plan },
			{ field: "status", value: "incomplete" },
		],
	});
	const scopedCandidates = candidates.filter(
		(candidate) =>
			(!referenceType || (candidate.referenceType ?? "user") === referenceType) &&
			(!consumerId ||
				!candidate.streampayConsumerId ||
				candidate.streampayConsumerId === consumerId),
	);
	if (scopedCandidates.length === 0) return null;
	if (paymentLinkId) {
		const exact = scopedCandidates.find(
			(candidate) => candidate.streampayPaymentLinkId === paymentLinkId,
		);
		return exact ?? null;
	}
	if (
		!referenceType &&
		new Set(scopedCandidates.map((candidate) => candidate.referenceType ?? "user")).size > 1
	) {
		return null;
	}
	return scopedCandidates.reduce((newest, candidate) => {
		const candidateTime = candidate.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
		const newestTime = newest.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
		return candidateTime > newestTime ? candidate : newest;
	});
}

async function resolveRowUser(
	ctx: SyncContext,
	row: Subscription,
): Promise<StreamPaySessionUser | null> {
	if ((row.referenceType ?? "user") !== "user") return null;
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
	retryOnError: boolean,
): Promise<void> {
	if (!callback) return;
	try {
		await callback(data);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger(ctx).error(`subscription callback ${callbackName} failed: ${msg}`);
		if (retryOnError) {
			throw new SubscriptionCallbackDeliveryError(callbackName, err);
		}
	}
}

class SubscriptionCallbackDeliveryError extends Error {
	readonly callbackName: string;

	constructor(callbackName: string, cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Subscription callback ${callbackName} failed: ${message}`);
		this.name = "SubscriptionCallbackDeliveryError";
		this.callbackName = callbackName;
	}
}

class SubscriptionCorrelationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubscriptionCorrelationError";
	}
}

async function updateReconciledSubscription(
	ctx: SyncContext,
	existing: Subscription,
	projected: Partial<Subscription>,
	streampaySubscriptionId: string,
): Promise<Subscription> {
	if (
		existing.providerUpdatedAt instanceof Date &&
		projected.providerUpdatedAt instanceof Date &&
		projected.providerUpdatedAt.getTime() < existing.providerUpdatedAt.getTime()
	) {
		throw new Error(
			`StreamPay returned stale subscription state for sub=${streampaySubscriptionId}. Retry reconciliation.`,
		);
	}
	const updated = await ctx.context.adapter.update<Subscription>({
		model: SUBSCRIPTION_MODEL,
		update: projected,
		where: [
			{ field: "id", value: existing.id },
			{ field: "providerUpdatedAt", value: existing.providerUpdatedAt ?? null },
			{ field: "streampaySubscriptionId", value: existing.streampaySubscriptionId ?? null },
			{ field: "streampayConsumerId", value: existing.streampayConsumerId ?? null },
			{ field: "status", value: existing.status },
			{ field: "billingStatus", value: existing.billingStatus },
		],
	});
	if (!updated) {
		throw new Error(
			`Subscription state changed during reconciliation for sub=${streampaySubscriptionId}. Retry delivery.`,
		);
	}
	return updated;
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
	let projected: Partial<Subscription> = {
		...projectSubscriptionFields(stream),
		...projectPlanFields(stream, plans),
	};
	const eventAt = parseDate(payload.timestamp);
	const eventIsStale = Boolean(
		eventAt &&
			existing?.providerUpdatedAt instanceof Date &&
			eventAt.getTime() < existing.providerUpdatedAt.getTime(),
	);
	if (
		!eventIsStale &&
		payload.event_type === "SUBSCRIPTION_CYCLE_RENEWAL_FAILED" &&
		projected.status === "active"
	) {
		projected.status = "past_due";
		projected.billingStatus = "past_due";
	}
	const schedulesCancellation =
		!eventIsStale &&
		payload.event_type === "SUBSCRIPTION_CANCEL_AT_PERIOD_END" &&
		Boolean(stream.cancel_at_period_end);
	if (schedulesCancellation) {
		projected.cancelAt = parseDate(stream.current_period_end);
	}
	const confirmsCancellation =
		!eventIsStale &&
		payload.event_type === "SUBSCRIPTION_CANCELED" &&
		projected.status === "canceled";
	if (confirmsCancellation) {
		projected.activeSlotKey = null;
	}
	projected = reconcileProjectionAgainstExisting(existing, projected, {
		lifecycleAt: eventAt,
		stampCancelScheduled: schedulesCancellation,
		stampCanceled: confirmsCancellation,
	});

	if (existing) {
		const projectedStatus = projected.status ?? existing.status;
		if (!isTerminalSubscriptionStatus(projectedStatus)) {
			const desiredSlotKey = subscriptionSlotKey(
				existing.referenceType ?? "user",
				existing.referenceId,
				projected.group === undefined ? existing.group : projected.group,
			);
			if (existing.activeSlotKey !== desiredSlotKey) {
				projected.activeSlotKey = desiredSlotKey;
			}
		}
		const updated = await updateReconciledSubscription(
			ctx,
			existing,
			projected,
			streampaySubscriptionId,
		);
		if (eventIsStale) {
			logger(ctx).info(
				`webhook ${payload.event_type}: ignored stale lifecycle callback for sub=${streampaySubscriptionId}.`,
			);
			return { row: null, stream };
		}
		return { row: updated, stream };
	}

	const planName =
		readMetadataString(payload.data, PLAN_NAME_METADATA_KEY) ?? inferPlanFromItems(stream, plans);
	const referenceId = readMetadataString(payload.data, REFERENCE_ID_METADATA_KEY);
	const metadataReferenceType = readReferenceType(payload.data);

	if (!planName || !referenceId) {
		logger(ctx).warn(
			`webhook ${payload.event_type}: cannot link sub=${streampaySubscriptionId} — missing plan_name (${planName}) or reference_id (${referenceId}) metadata.`,
		);
		return { row: null, stream };
	}

	const paymentLinkId =
		stream.latest_invoice?.payment_link_id ?? payload.data?.payment_link?.id ?? null;
	const localRowId = readMetadataString(payload.data, SUBSCRIPTION_ROW_ID_METADATA_KEY);
	if (localRowId) {
		const metadataRow = await ctx.context.adapter.findOne<Subscription>({
			model: SUBSCRIPTION_MODEL,
			where: [{ field: "id", value: localRowId }],
		});
		if (!metadataRow) {
			logger(ctx).warn(
				`webhook ${payload.event_type}: referenced subscription row=${localRowId} is missing; rebuilding from signed metadata.`,
			);
		} else if (
			metadataRow.referenceId === referenceId &&
			(!metadataReferenceType || (metadataRow.referenceType ?? "user") === metadataReferenceType) &&
			metadataRow.plan === planName &&
			(!metadataRow.streampayConsumerId ||
				!stream.organization_consumer_id ||
				metadataRow.streampayConsumerId === stream.organization_consumer_id) &&
			(!metadataRow.streampaySubscriptionId ||
				metadataRow.streampaySubscriptionId === streampaySubscriptionId) &&
			(!metadataRow.streampayPaymentLinkId ||
				!paymentLinkId ||
				metadataRow.streampayPaymentLinkId === paymentLinkId)
		) {
			const projectedWithSlot = {
				...projected,
				billingStatus: metadataRow.billingStatus ?? "current",
				...(projected.activeSlotKey === null
					? {}
					: {
							activeSlotKey:
								metadataRow.activeSlotKey ??
								subscriptionSlotKey(
									metadataRow.referenceType ?? metadataReferenceType ?? "user",
									metadataRow.referenceId,
									projected.group === undefined ? metadataRow.group : projected.group,
								),
						}),
			};
			const updated = await updateReconciledSubscription(
				ctx,
				metadataRow,
				projectedWithSlot,
				streampaySubscriptionId,
			);
			return { row: updated, stream };
		}
		if (metadataRow) {
			logger(ctx).warn(
				`webhook ${payload.event_type}: ignored unsafe subscription row correlation for row=${localRowId}.`,
			);
			throw new SubscriptionCorrelationError(
				`Webhook ${payload.event_type} failed protected subscription correlation for row=${localRowId}.`,
			);
		}
	}
	const incomplete = await findIncompleteRow(
		ctx,
		referenceId,
		metadataReferenceType,
		planName,
		paymentLinkId,
		stream.organization_consumer_id ?? null,
	);
	if (incomplete) {
		const projectedWithSlot = {
			...projected,
			billingStatus: incomplete.billingStatus ?? "current",
			...(projected.activeSlotKey === null
				? {}
				: {
						activeSlotKey:
							incomplete.activeSlotKey ??
							subscriptionSlotKey(
								incomplete.referenceType ?? metadataReferenceType ?? "user",
								incomplete.referenceId,
								projected.group === undefined ? incomplete.group : projected.group,
							),
					}),
		};
		const updated = await updateReconciledSubscription(
			ctx,
			incomplete,
			projectedWithSlot,
			streampaySubscriptionId,
		);
		return {
			row: updated,
			stream,
		};
	}

	const plan = plans.byName.get(planName);
	const referenceType = metadataReferenceType ?? "custom";
	const row = await ctx.context.adapter.create<Subscription>({
		model: SUBSCRIPTION_MODEL,
		data: {
			cancelScheduledAt: null,
			canceledAt: null,
			...projected,
			referenceId,
			referenceType,
			activeSlotKey: isTerminalSubscriptionStatus(projected.status)
				? null
				: subscriptionSlotKey(referenceType, referenceId, plan?.group),
			streampayPaymentLinkId: paymentLinkId,
			plan: planName,
			planVersion: plan?.version ?? null,
			productId: plan?.productId ?? subscriptionItemProductId(stream.items?.[0]),
			group: plan?.group ?? null,
			billingStatus: "current",
			createdAt: new Date(),
		},
	});
	return { row, stream };
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
		retryOnCallbackError?: boolean;
		retryingRenewalCallback?: boolean;
	} = {},
): Promise<void> {
	if (payload.entity_type !== "SUBSCRIPTION" && payload.event_type !== "INVOICE_COMPLETED") {
		return;
	}

	const dedupe = options.dedupe !== false;
	const rawBody = options.rawBody ?? null;
	const signatureHeader = options.signatureHeader ?? null;
	const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS);
	const retryOnCallbackError = options.retryOnCallbackError !== false;

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
	const trackedLockId = claim.row?.lockedBy ?? undefined;

	try {
		if (
			payload.event_type === "INVOICE_COMPLETED" ||
			payload.event_type === "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY"
		) {
			await handleRenewalEvidence(
				ctx,
				payload,
				client,
				plans,
				callbacks,
				retryOnCallbackError,
				options.retryingRenewalCallback === true ||
					claim.row?.lastError?.startsWith(
						"Subscription callback onSubscriptionRenewed failed:",
					) === true,
			);
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
				await dispatchSubscriptionCallback(ctx, payload, data, callbacks, retryOnCallbackError);
			}
		}

		if (trackedRowId) await markWebhookEventCompleted(ctx, trackedRowId, trackedLockId);
	} catch (err) {
		if (trackedRowId) {
			const deadLetter =
				classifyWebhookFailure(err) === "PERMANENT" ||
				(claim.row?.attemptCount ?? 0) >= maxAttempts;
			await recordWebhookEventFailure(
				ctx,
				trackedRowId,
				rawBody,
				signatureHeader,
				err,
				trackedLockId,
				deadLetter,
			);
		}
		throw err;
	}
}

async function handleRenewalEvidence(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
	callbacks: SubscriptionCallbacks,
	retryOnCallbackError: boolean,
	retryingRenewalCallback: boolean,
): Promise<void> {
	const invoiceId = payload.data?.invoice?.id ?? payload.entity_id;
	if (!invoiceId) return;
	let subscriptionId: string | null =
		payload.entity_type === "SUBSCRIPTION" ? payload.entity_id : null;
	if (!subscriptionId) {
		try {
			const invoice = await client.getInvoice(invoiceId);
			if (invoice && typeof invoice === "object" && "subscription_id" in invoice) {
				const subId = invoice.subscription_id;
				if (typeof subId === "string" && subId.length > 0) subscriptionId = subId;
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			logger(ctx).error(`${payload.event_type}: getInvoice(${invoiceId}) failed: ${msg}`);
			throw err;
		}
	}

	if (!subscriptionId) return;

	let stream: SubscriptionDetailed;
	try {
		stream = await client.getSubscription(subscriptionId);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger(ctx).error(`${payload.event_type}: getSubscription(${subscriptionId}) failed: ${msg}`);
		throw err;
	}

	const existing = await findSubscriptionByStreampayId(ctx, subscriptionId);
	if (!existing) return;

	const eventAt = parseDate(payload.timestamp);
	const eventIsStale = Boolean(
		eventAt &&
			existing.providerUpdatedAt instanceof Date &&
			eventAt.getTime() < existing.providerUpdatedAt.getTime(),
	);
	const projected: Partial<Subscription> = {
		...projectSubscriptionFields(stream),
		...projectPlanFields(stream, plans),
		...(eventIsStale
			? existing.billingStatus === "past_due" && toLocalStatus(stream.status) === "active"
				? { status: "past_due", billingStatus: "past_due" }
				: {}
			: { billingStatus: "current" }),
	};
	const previousPeriodEnd = existing.periodEnd?.getTime() ?? null;
	const projectedPeriodEnd = projected.periodEnd?.getTime() ?? null;
	const periodAdvanced =
		previousPeriodEnd !== null &&
		projectedPeriodEnd !== null &&
		projectedPeriodEnd > previousPeriodEnd;
	const cycleAdvanced =
		existing.currentCycleNumber !== null &&
		existing.currentCycleNumber !== undefined &&
		projected.currentCycleNumber !== null &&
		projected.currentCycleNumber !== undefined &&
		projected.currentCycleNumber > existing.currentCycleNumber;
	const eventId = extractEventId(payload);
	const pendingCallback = existing.renewalCallbackEventId ?? null;
	if (
		!pendingCallback &&
		existing.providerUpdatedAt instanceof Date &&
		projected.providerUpdatedAt instanceof Date &&
		projected.providerUpdatedAt.getTime() < existing.providerUpdatedAt.getTime()
	) {
		throw new Error(
			`StreamPay returned stale subscription state for sub=${subscriptionId}; retry delivery.`,
		);
	}
	if (pendingCallback && pendingCallback !== eventId) {
		throw new Error(`Subscription renewal callback ${pendingCallback} is pending; retry delivery.`);
	}
	const deliverCallback =
		(pendingCallback === eventId && pendingCallback !== null) ||
		(!eventIsStale && (periodAdvanced || cycleAdvanced || retryingRenewalCallback));
	const callbackOwner = deliverCallback && callbacks.onSubscriptionRenewed ? eventId : null;
	const updated = await ctx.context.adapter.update<Subscription>({
		model: SUBSCRIPTION_MODEL,
		// Recovery must retain the pending cycle, even if Stream has already advanced again.
		update: pendingCallback
			? { renewalCallbackEventId: callbackOwner }
			: { ...projected, renewalCallbackEventId: callbackOwner },
		where: [
			{ field: "id", value: existing.id },
			{ field: "periodEnd", value: existing.periodEnd ?? null },
			{ field: "currentCycleNumber", value: existing.currentCycleNumber ?? null },
			{ field: "renewalCallbackEventId", value: pendingCallback },
			{ field: "providerUpdatedAt", value: existing.providerUpdatedAt ?? null },
			{ field: "status", value: existing.status },
			{ field: "billingStatus", value: existing.billingStatus },
		],
	});
	if (!updated) {
		if (pendingCallback && pendingCallback === eventId) {
			throw new Error(`Subscription cycle changed during callback recovery; retry delivery.`);
		}
		const latest = await findSubscriptionByStreampayId(ctx, subscriptionId);
		const anotherCallbackOwner = latest?.renewalCallbackEventId;
		const desiredCycleAdvanced =
			(periodAdvanced || cycleAdvanced) &&
			(!periodAdvanced || (latest?.periodEnd?.getTime() ?? 0) >= (projectedPeriodEnd ?? 0)) &&
			(!cycleAdvanced || (latest?.currentCycleNumber ?? 0) >= (projected.currentCycleNumber ?? 0));
		if (anotherCallbackOwner && anotherCallbackOwner !== eventId && desiredCycleAdvanced) return;
		throw new Error(`Subscription changed during renewal reconciliation; retry delivery.`);
	}
	const row = updated;

	const user = await resolveRowUser(ctx, row);
	if (deliverCallback) {
		await fireCallback(
			ctx,
			callbacks.onSubscriptionRenewed,
			{ subscription: row, streampaySubscription: stream, user, event: payload },
			"onSubscriptionRenewed",
			retryOnCallbackError,
		);
		if (callbackOwner) {
			await ctx.context.adapter.update({
				model: SUBSCRIPTION_MODEL,
				update: { renewalCallbackEventId: null },
				where: [
					{ field: "id", value: row.id },
					{ field: "renewalCallbackEventId", value: callbackOwner },
				],
			});
		}
	}
}

async function dispatchSubscriptionCallback(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	data: SubscriptionCallbackData,
	callbacks: SubscriptionCallbacks,
	retryOnCallbackError: boolean,
): Promise<void> {
	switch (payload.event_type) {
		case "SUBSCRIPTION_CREATED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionCreated,
				data,
				"onSubscriptionCreated",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_ACTIVATED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionActivated,
				data,
				"onSubscriptionActivated",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_CANCELED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionCanceled,
				data,
				"onSubscriptionCanceled",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_INACTIVATED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionInactivated,
				data,
				"onSubscriptionInactivated",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_CANCEL_AT_PERIOD_END":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionCancelScheduled,
				data,
				"onSubscriptionCancelScheduled",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_FROZEN":
		case "SUBSCRIPTION_FREEZE_NOW":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionFrozen,
				data,
				"onSubscriptionFrozen",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_UNFREEZE_NOW":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionResumed,
				data,
				"onSubscriptionResumed",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_UNFREEZE_FUTURE":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionUnfreezeScheduled,
				data,
				"onSubscriptionUnfreezeScheduled",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_FREEZE_CANCEL":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionFreezeCanceled,
				data,
				"onSubscriptionFreezeCanceled",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_CYCLE_RENEWAL_FAILED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionPaymentFailed,
				data,
				"onSubscriptionPaymentFailed",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_PLAN_CHANGE_SCHEDULED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionPlanChangeScheduled,
				data,
				"onSubscriptionPlanChangeScheduled",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_PLAN_CHANGE_CANCELED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionPlanChangeCanceled,
				data,
				"onSubscriptionPlanChangeCanceled",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_PLAN_CHANGED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionPlanChanged,
				data,
				"onSubscriptionPlanChanged",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_PLAN_CHANGE_INVOICE_REISSUED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionPlanChangeInvoiceReissued,
				data,
				"onSubscriptionPlanChangeInvoiceReissued",
				retryOnCallbackError,
			);
			return;
		case "SUBSCRIPTION_PLAN_UPDATED":
			await fireCallback(
				ctx,
				callbacks.onSubscriptionPlanUpdated,
				data,
				"onSubscriptionPlanUpdated",
				retryOnCallbackError,
			);
			return;
		default:
			return;
	}
}

export type WebhookSyncFailure = "PERMANENT" | "TRANSIENT";

export function classifyWebhookFailure(err: unknown): WebhookSyncFailure {
	if (err instanceof SubscriptionCorrelationError) return "PERMANENT";
	const { status } = readSdkErrorFields(err);
	if (status === undefined) return "TRANSIENT";
	if (status === 404 || status === 429) return "TRANSIENT";
	if (status >= 400 && status < 500) return "PERMANENT";
	return "TRANSIENT";
}
