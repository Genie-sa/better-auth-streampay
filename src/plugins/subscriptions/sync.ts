import type { SubscriptionDetailed } from "@streamsdk/typescript";
import type { StreamPayClient } from "../../types";
import { readSdkErrorFields } from "../../utils/error-envelope";
import { type ScopedLogger, scopedLogger } from "../../utils/logger";
import { asSessionUser, type StreamPaySessionUser } from "../../utils/session";
import type {
	StreamPayWebhookData,
	StreamPayWebhookEnvelope,
	StreamPayWebhookPayload,
} from "../../webhooks/events";
import {
	DEFAULT_MAX_WEBHOOK_ATTEMPTS,
	deliverWebhookEvent,
	WEBHOOK_EVENT_MODEL,
	type WebhookEventRow,
	type WebhookInboxAttempt,
	type WebhookInboxScope,
	WebhookProcessingError,
	webhookEventId,
} from "../../webhooks/inbox";
import type { SyncContext } from "./adapter";
import { yieldReservationToPaidSubscription } from "./checkout-reservation";
import { SubscriptionCorrelationError } from "./correlation-error";
import type { ResolvedPlans } from "./plans";
import {
	inferPlanFromItems,
	isOlderProviderState,
	lifecycleWriteGuard,
	liveSlotKey,
	parseDate,
	persistReconciledProjection,
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

export { WebhookEventInProgressError } from "../../webhooks/inbox";
export type { PluginAdapter, SyncContext } from "./adapter";
export { subscriptionItemProductId } from "./reconcile";

const SUBSCRIPTION_MODEL = "subscription";
const RENEWAL_CALLBACK_FAILURE_CODE = "SUBSCRIPTION_RENEWAL_CALLBACK_FAILED";
/** Rows written before `RENEWAL_CALLBACK_FAILURE_CODE` existed only carry the message. */
const LEGACY_RENEWAL_CALLBACK_FAILURE_PREFIX =
	"Subscription callback onSubscriptionRenewed failed:";

function logger(ctx: SyncContext): ScopedLogger {
	return scopedLogger(ctx.context.logger);
}

export interface WebhookReplayOptions {
	/** @deprecated No effect: a failed replay keeps a pending event retryable until its attempts are spent. */
	retryUntilExhausted?: boolean;
	/**
	 * Replay only if the event is still pending at this attempt and due. Otherwise the replay fails
	 * with `CONFLICT`. `processDueStreampayWebhookEvents` applies this check itself.
	 */
	dueAttemptCount?: number;
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

class SubscriptionCallbackDeliveryError extends WebhookProcessingError {
	readonly callbackName: string;

	constructor(callbackName: string, cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(
			`Subscription callback ${callbackName} failed: ${message}`,
			callbackName === "onSubscriptionRenewed"
				? RENEWAL_CALLBACK_FAILURE_CODE
				: "SubscriptionCallbackDeliveryError",
		);
		this.name = "SubscriptionCallbackDeliveryError";
		this.callbackName = callbackName;
	}
}

/**
 * A stale event (older than the stored provider state) keeps its lifecycle effects when the fresh
 * provider snapshot still shows what the event announced. StreamPay keeps writing to a subscription
 * after emitting an event, so a retried or reordered delivery is routinely older than the stored
 * state without being contradicted by it. Events with no checkable state stay suppressed.
 */
function providerStateConfirmsEvent(eventType: string, stream: SubscriptionDetailed): boolean {
	switch (eventType) {
		case "SUBSCRIPTION_CREATED":
			return true;
		case "SUBSCRIPTION_ACTIVATED":
		case "SUBSCRIPTION_UNFREEZE_NOW":
			return stream.status === "ACTIVE" || stream.status === "TRIALING";
		case "SUBSCRIPTION_CANCELED":
			return stream.status === "CANCELED";
		case "SUBSCRIPTION_INACTIVATED":
			return stream.status === "INACTIVE";
		case "SUBSCRIPTION_CANCEL_AT_PERIOD_END":
			return (
				Boolean(stream.cancel_at_period_end) &&
				!isTerminalSubscriptionStatus(toLocalStatus(stream.status))
			);
		case "SUBSCRIPTION_FROZEN":
		case "SUBSCRIPTION_FREEZE_NOW":
			return stream.status === "FROZEN";
		case "SUBSCRIPTION_PLAN_CHANGE_SCHEDULED":
			return Boolean(stream.pending_change);
		case "SUBSCRIPTION_PLAN_CHANGE_CANCELED":
			return !stream.pending_change;
		default:
			return false;
	}
}

async function takeSlotFromReservation(
	ctx: SyncContext,
	client: StreamPayClient,
	slotKey: string,
	ownerRowId: string | null,
	streampaySubscriptionId: string,
): Promise<void> {
	await yieldReservationToPaidSubscription({
		client,
		adapter: ctx.context.adapter,
		slotKey,
		ownerRowId,
		streampaySubscriptionId,
		log: logger(ctx),
	});
}

async function linkReservedRow(
	ctx: SyncContext,
	client: StreamPayClient,
	row: Subscription,
	projected: Partial<Subscription>,
	metadataReferenceType: SubscriptionReferenceType | null,
	streampaySubscriptionId: string,
): Promise<Subscription> {
	const activeSlotKey =
		projected.activeSlotKey === null
			? null
			: (row.activeSlotKey ??
				subscriptionSlotKey(
					row.referenceType ?? metadataReferenceType ?? "user",
					row.referenceId,
					projected.group === undefined ? row.group : projected.group,
				));
	return updateReconciledSubscription(
		ctx,
		client,
		row,
		{
			...projected,
			billingStatus: row.billingStatus ?? "current",
			...(activeSlotKey === null ? {} : { activeSlotKey }),
		},
		streampaySubscriptionId,
	);
}

function updateReconciledSubscription(
	ctx: SyncContext,
	client: StreamPayClient,
	existing: Subscription,
	projected: Partial<Subscription>,
	streampaySubscriptionId: string,
): Promise<Subscription> {
	return persistReconciledProjection(ctx.context.adapter, existing, projected, {
		streampaySubscriptionId,
		takeSlot: (slotKey) =>
			takeSlotFromReservation(ctx, client, slotKey, existing.id, streampaySubscriptionId),
	});
}

async function reconcileFromStreamPay(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
	prefetched?: SubscriptionDetailed,
): Promise<{ row: Subscription | null; stream: SubscriptionDetailed | null }> {
	const streampaySubscriptionId = payload.entity_id;
	if (!streampaySubscriptionId) {
		logger(ctx).warn(`webhook ${payload.event_type} has no entity_id — cannot reconcile.`);
		return { row: null, stream: null };
	}

	let stream: SubscriptionDetailed;
	try {
		stream = prefetched ?? (await client.getSubscription(streampaySubscriptionId));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger(ctx).error(
			`webhook ${payload.event_type}: getSubscription(${streampaySubscriptionId}) failed: ${msg}`,
		);
		throw err;
	}

	const existing = await findSubscriptionByStreampayId(ctx, streampaySubscriptionId);
	let projected: Partial<Subscription> = {
		...projectSubscriptionFields(stream, existing),
		...projectPlanFields(stream, plans),
	};
	const eventAt = parseDate(payload.timestamp);
	const eventIsStale = Boolean(
		eventAt &&
			existing?.providerUpdatedAt instanceof Date &&
			eventAt.getTime() < existing.providerUpdatedAt.getTime(),
	);
	const eventApplies = !eventIsStale || providerStateConfirmsEvent(payload.event_type, stream);
	if (
		eventApplies &&
		payload.event_type === "SUBSCRIPTION_CYCLE_RENEWAL_FAILED" &&
		projected.status === "active"
	) {
		projected.status = "past_due";
		projected.billingStatus = "past_due";
	}
	const schedulesCancellation =
		eventApplies &&
		payload.event_type === "SUBSCRIPTION_CANCEL_AT_PERIOD_END" &&
		Boolean(stream.cancel_at_period_end);
	if (schedulesCancellation) {
		projected.cancelAt = parseDate(stream.current_period_end);
	}
	const confirmsCancellation =
		eventApplies &&
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
	// The cancel event dates the schedule, even when an earlier-processed event already saw the flag.
	if (
		schedulesCancellation &&
		eventAt &&
		existing?.cancelAtPeriodEnd &&
		!existing.cancelScheduledAt
	) {
		projected.cancelScheduledAt = eventAt;
	}

	if (existing) {
		const slotKey = liveSlotKey(existing, projected);
		if (slotKey && existing.activeSlotKey !== slotKey) {
			projected.activeSlotKey = slotKey;
		}
		const updated = await updateReconciledSubscription(
			ctx,
			client,
			existing,
			projected,
			streampaySubscriptionId,
		);
		if (!eventApplies) {
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
			const updated = await linkReservedRow(
				ctx,
				client,
				metadataRow,
				projected,
				metadataReferenceType,
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
		const updated = await linkReservedRow(
			ctx,
			client,
			incomplete,
			projected,
			metadataReferenceType,
			streampaySubscriptionId,
		);
		return { row: updated, stream };
	}

	const plan = plans.byName.get(planName);
	const referenceType = metadataReferenceType ?? "custom";
	const activeSlotKey = isTerminalSubscriptionStatus(projected.status)
		? null
		: subscriptionSlotKey(referenceType, referenceId, plan?.group);
	if (activeSlotKey) {
		await takeSlotFromReservation(ctx, client, activeSlotKey, null, streampaySubscriptionId);
	}
	const row = await ctx.context.adapter.create<Subscription>({
		model: SUBSCRIPTION_MODEL,
		data: {
			cancelScheduledAt: null,
			canceledAt: null,
			...projected,
			referenceId,
			referenceType,
			activeSlotKey,
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

interface SubscriptionEventOptions {
	retryOnCallbackError: boolean;
	retryingRenewalCallback: boolean;
	/** The inbox table exists, so a renewal lock whose event already completed can be released. */
	inboxEnabled: boolean;
}

function isRenewalCallbackRetry(attempt: WebhookInboxAttempt): boolean {
	return (
		attempt.previousErrorCode === RENEWAL_CALLBACK_FAILURE_CODE ||
		attempt.previousError?.startsWith(LEGACY_RENEWAL_CALLBACK_FAILURE_PREFIX) === true
	);
}

/**
 * Sync reconciles from StreamPay's current state rather than from the event, so subscription
 * event types added after this release are reconciled too and only fire no callback.
 */
function isSubscriptionSyncEvent(
	payload: StreamPayWebhookEnvelope,
): payload is StreamPayWebhookPayload {
	return payload.entity_type === "SUBSCRIPTION" || payload.event_type === "INVOICE_COMPLETED";
}

async function processSubscriptionEvent(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
	callbacks: SubscriptionCallbacks,
	options: SubscriptionEventOptions,
): Promise<void> {
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
			options.retryOnCallbackError,
			options.retryingRenewalCallback,
			options.inboxEnabled,
		);
		return;
	}
	const { row, stream } = await reconcileFromStreamPay(ctx, payload, client, plans);
	if (!row) return;
	const user = await resolveRowUser(ctx, row);
	await dispatchSubscriptionCallback(
		ctx,
		payload,
		{ subscription: row, streampaySubscription: stream, user, event: payload },
		callbacks,
		options.retryOnCallbackError,
	);
}

/** The inbox scope that reconciles subscription rows from StreamPay events. */
export function subscriptionInboxScope(args: {
	client: StreamPayClient;
	plans: () => Promise<ResolvedPlans>;
	callbacks: SubscriptionCallbacks;
	maxAttempts?: number;
	retryOnCallbackError?: boolean;
	retryingRenewalCallback?: boolean;
	/** Defaults to true: the scope runs inside the inbox, so its table exists. */
	inboxEnabled?: boolean;
}): WebhookInboxScope {
	return {
		eventIdPrefix: null,
		maxAttempts: Math.max(1, args.maxAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS),
		isPermanentFailure: (err) => classifyWebhookFailure(err) === "PERMANENT",
		prepare: (payload) => {
			if (!isSubscriptionSyncEvent(payload)) return null;
			return async (ctx, attempt) =>
				processSubscriptionEvent(ctx, payload, args.client, await args.plans(), args.callbacks, {
					retryOnCallbackError: args.retryOnCallbackError !== false,
					retryingRenewalCallback:
						args.retryingRenewalCallback === true || isRenewalCallbackRetry(attempt),
					inboxEnabled: args.inboxEnabled !== false,
				});
		},
		onDiscard: releaseRenewalCallbackOwner,
	};
}

/** A discarded renewal event can never deliver its callback, so it must stop blocking the next cycle. */
async function releaseRenewalCallbackOwner(
	ctx: SyncContext,
	row: { eventId: string; eventType: string },
): Promise<void> {
	if (
		row.eventType !== "INVOICE_COMPLETED" &&
		row.eventType !== "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY"
	) {
		return;
	}
	const owner = await ctx.context.adapter.findOne<Subscription>({
		model: SUBSCRIPTION_MODEL,
		where: [{ field: "renewalCallbackEventId", value: row.eventId }],
	});
	if (!owner) return;
	await ctx.context.adapter.update({
		model: SUBSCRIPTION_MODEL,
		update: { renewalCallbackEventId: null },
		where: [
			{ field: "id", value: owner.id },
			{ field: "renewalCallbackEventId", value: row.eventId },
		],
	});
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
		/** The inbox table exists. Defaults to `dedupe`; replay processes without dedupe but has an inbox. */
		inboxEnabled?: boolean;
	} = {},
): Promise<void> {
	if (!isSubscriptionSyncEvent(payload)) return;
	if (options.dedupe === false) {
		await processSubscriptionEvent(ctx, payload, client, plans, callbacks, {
			retryOnCallbackError: options.retryOnCallbackError !== false,
			retryingRenewalCallback: options.retryingRenewalCallback === true,
			inboxEnabled: options.inboxEnabled === true,
		});
		return;
	}
	const scope = subscriptionInboxScope({
		client,
		plans: async () => plans,
		callbacks,
		...(options.maxAttempts !== undefined && { maxAttempts: options.maxAttempts }),
		...(options.retryOnCallbackError !== undefined && {
			retryOnCallbackError: options.retryOnCallbackError,
		}),
		...(options.retryingRenewalCallback !== undefined && {
			retryingRenewalCallback: options.retryingRenewalCallback,
		}),
		...(options.inboxEnabled !== undefined && { inboxEnabled: options.inboxEnabled }),
	});
	await deliverWebhookEvent(ctx, scope, payload, {
		rawBody: options.rawBody ?? null,
		signatureHeader: options.signatureHeader ?? null,
	});
}

/**
 * A lock whose event is already completed can never deliver its callback (for example after an admin
 * discard that stopped before clearing it), so it is released for the next renewal evidence.
 */
async function releaseLockOfCompletedRenewal(
	ctx: SyncContext,
	subscriptionRowId: string,
	lockEventId: string,
): Promise<boolean> {
	const owner = await ctx.context.adapter.findOne<WebhookEventRow>({
		model: WEBHOOK_EVENT_MODEL,
		where: [{ field: "eventId", value: lockEventId }],
	});
	if (owner?.status !== "completed") return false;
	const released = await ctx.context.adapter.update<Subscription>({
		model: SUBSCRIPTION_MODEL,
		update: { renewalCallbackEventId: null },
		where: [
			{ field: "id", value: subscriptionRowId },
			{ field: "renewalCallbackEventId", value: lockEventId },
		],
	});
	if (released) {
		logger(ctx).warn(
			`released renewal callback lock of completed event ${lockEventId} for row=${subscriptionRowId}.`,
		);
	}
	return released !== null;
}

/**
 * Renewal evidence can arrive before the creation webhooks, or after they failed for good. StreamPay
 * bills every cycle through the checkout link, so a local reservation that owns that link is linked
 * here, through the same signed-metadata correlation as the creation webhooks, instead of dropping
 * the renewal. Subscriptions the plugin did not check out are left alone.
 */
async function linkCheckoutFromRenewalEvidence(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
	stream: SubscriptionDetailed,
): Promise<Subscription | null> {
	const paymentLinkId = stream.latest_invoice?.payment_link_id;
	if (!paymentLinkId || !stream.id) return null;
	const reservation = await ctx.context.adapter.findOne<Subscription>({
		model: SUBSCRIPTION_MODEL,
		where: [{ field: "streampayPaymentLinkId", value: paymentLinkId }],
	});
	if (!reservation) return null;
	const link = await client.getPaymentLink(paymentLinkId);
	const { row } = await reconcileFromStreamPay(
		ctx,
		{
			...payload,
			entity_type: "SUBSCRIPTION",
			entity_id: stream.id,
			data: {
				metadata: link.custom_metadata ?? {},
				payment_link: { id: paymentLinkId, url: "" },
			},
		} as StreamPayWebhookPayload,
		client,
		plans,
		stream,
	);
	if (row) {
		logger(ctx).warn(
			`webhook ${payload.event_type}: linked checkout row=${row.id} to StreamPay sub=${stream.id} from renewal evidence.`,
		);
		return row;
	}
	// A creation webhook linked it first; the renewal checks below still apply to that row.
	return findSubscriptionByStreampayId(ctx, stream.id);
}

async function handleRenewalEvidence(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
	callbacks: SubscriptionCallbacks,
	retryOnCallbackError: boolean,
	retryingRenewalCallback: boolean,
	inboxEnabled: boolean,
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

	const existing =
		(await findSubscriptionByStreampayId(ctx, subscriptionId)) ??
		(await linkCheckoutFromRenewalEvidence(ctx, payload, client, plans, stream));
	if (!existing) return;

	const eventAt = parseDate(payload.timestamp);
	const eventIsStale = Boolean(
		eventAt &&
			existing.providerUpdatedAt instanceof Date &&
			eventAt.getTime() < existing.providerUpdatedAt.getTime(),
	);
	const evidenceInvoiceId =
		payload.data?.invoice?.id ?? (payload.entity_type === "INVOICE" ? payload.entity_id : null);
	// A renewal-success event names no invoice, so the paid latest invoice is its evidence.
	const settlesLatestInvoice =
		stream.latest_invoice?.status === "COMPLETED" &&
		(evidenceInvoiceId === null || stream.latest_invoice.id === evidenceInvoiceId);
	const evidenceApplies = !eventIsStale || settlesLatestInvoice;
	const projected: Partial<Subscription> = {
		...projectSubscriptionFields(stream, existing),
		...projectPlanFields(stream, plans),
		...(evidenceApplies
			? { billingStatus: "current" }
			: existing.billingStatus === "past_due" && toLocalStatus(stream.status) === "active"
				? { status: "past_due", billingStatus: "past_due" }
				: {}),
	};
	const slotKey = liveSlotKey(existing, projected);
	if (slotKey && existing.activeSlotKey !== slotKey) {
		projected.activeSlotKey = slotKey;
	}
	const previousPeriodEnd = existing.periodEnd?.getTime() ?? null;
	const projectedPeriodEnd = projected.periodEnd?.getTime() ?? null;
	const periodAdvanced =
		previousPeriodEnd !== null &&
		projectedPeriodEnd !== null &&
		projectedPeriodEnd > previousPeriodEnd;
	const renewedCycle = existing.renewedCycleNumber ?? existing.currentCycleNumber ?? null;
	const projectedCycle = projected.currentCycleNumber ?? null;
	// Period boundaries drift between cycles, so the provider's cycle counter identifies a renewal.
	const tracksCycles = renewedCycle !== null && projectedCycle !== null;
	const renewalAdvanced = tracksCycles ? projectedCycle > renewedCycle : periodAdvanced;
	const eventId = webhookEventId(payload);
	let pendingCallback = existing.renewalCallbackEventId ?? null;
	if (pendingCallback && pendingCallback !== eventId) {
		const released =
			inboxEnabled && (await releaseLockOfCompletedRenewal(ctx, existing.id, pendingCallback));
		if (!released) {
			throw new Error(
				`Subscription renewal callback ${pendingCallback} is pending; retry delivery.`,
			);
		}
		pendingCallback = null;
	}
	if (!pendingCallback && isOlderProviderState(existing, projected)) {
		throw new Error(
			`StreamPay returned stale subscription state for sub=${subscriptionId}; retry delivery.`,
		);
	}
	if (
		!pendingCallback &&
		projected.activeSlotKey &&
		projected.activeSlotKey !== existing.activeSlotKey
	) {
		await takeSlotFromReservation(
			ctx,
			client,
			projected.activeSlotKey,
			existing.id,
			subscriptionId,
		);
	}
	const deliverCallback =
		(pendingCallback === eventId && pendingCallback !== null) ||
		(evidenceApplies && (renewalAdvanced || retryingRenewalCallback));
	const callbackOwner = deliverCallback && callbacks.onSubscriptionRenewed ? eventId : null;
	if (deliverCallback && renewalAdvanced && projectedCycle !== null) {
		projected.renewedCycleNumber = projectedCycle;
	}
	const updated = await ctx.context.adapter.update<Subscription>({
		model: SUBSCRIPTION_MODEL,
		// Recovery must retain the pending cycle, even if Stream has already advanced again.
		update: pendingCallback
			? { renewalCallbackEventId: callbackOwner }
			: { ...projected, renewalCallbackEventId: callbackOwner },
		where: [
			...lifecycleWriteGuard(existing),
			{ field: "periodEnd", value: existing.periodEnd ?? null },
			{ field: "currentCycleNumber", value: existing.currentCycleNumber ?? null },
			{ field: "renewalCallbackEventId", value: pendingCallback },
		],
	});
	if (!updated) {
		if (pendingCallback && pendingCallback === eventId) {
			throw new Error(`Subscription cycle changed during callback recovery; retry delivery.`);
		}
		const latest = await findSubscriptionByStreampayId(ctx, subscriptionId);
		const anotherCallbackOwner = latest?.renewalCallbackEventId;
		const renewalClaimedElsewhere =
			renewalAdvanced &&
			(tracksCycles
				? (latest?.renewedCycleNumber ?? 0) >= projectedCycle
				: (latest?.periodEnd?.getTime() ?? 0) >= (projectedPeriodEnd ?? 0));
		if (anotherCallbackOwner && anotherCallbackOwner !== eventId && renewalClaimedElsewhere) return;
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

const LIFECYCLE_CALLBACKS: Partial<
	Record<StreamPayWebhookPayload["event_type"], keyof SubscriptionCallbacks>
> = {
	SUBSCRIPTION_CREATED: "onSubscriptionCreated",
	SUBSCRIPTION_ACTIVATED: "onSubscriptionActivated",
	SUBSCRIPTION_CANCELED: "onSubscriptionCanceled",
	SUBSCRIPTION_INACTIVATED: "onSubscriptionInactivated",
	SUBSCRIPTION_CANCEL_AT_PERIOD_END: "onSubscriptionCancelScheduled",
	SUBSCRIPTION_FROZEN: "onSubscriptionFrozen",
	SUBSCRIPTION_FREEZE_NOW: "onSubscriptionFrozen",
	SUBSCRIPTION_UNFREEZE_NOW: "onSubscriptionResumed",
	SUBSCRIPTION_UNFREEZE_FUTURE: "onSubscriptionUnfreezeScheduled",
	SUBSCRIPTION_FREEZE_CANCEL: "onSubscriptionFreezeCanceled",
	SUBSCRIPTION_CYCLE_RENEWAL_FAILED: "onSubscriptionPaymentFailed",
	SUBSCRIPTION_PLAN_CHANGE_SCHEDULED: "onSubscriptionPlanChangeScheduled",
	SUBSCRIPTION_PLAN_CHANGE_CANCELED: "onSubscriptionPlanChangeCanceled",
	SUBSCRIPTION_PLAN_CHANGED: "onSubscriptionPlanChanged",
	SUBSCRIPTION_PLAN_CHANGE_INVOICE_REISSUED: "onSubscriptionPlanChangeInvoiceReissued",
	SUBSCRIPTION_PLAN_UPDATED: "onSubscriptionPlanUpdated",
};

async function dispatchSubscriptionCallback(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	data: SubscriptionCallbackData,
	callbacks: SubscriptionCallbacks,
	retryOnCallbackError: boolean,
): Promise<void> {
	const callbackName = LIFECYCLE_CALLBACKS[payload.event_type];
	if (!callbackName) return;
	await fireCallback(ctx, callbacks[callbackName], data, callbackName, retryOnCallbackError);
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
