import type { SubscriptionDetailed } from "@streamsdk/typescript";
import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../../error-codes";
import type { StreamPayClient } from "../../types";
import { readSdkErrorFields } from "../../utils/error-envelope";
import { summarizeStreamPayError } from "../../utils/format-error";
import { type ScopedLogger, scopedLogger } from "../../utils/logger";
import { asSessionUser, type StreamPaySessionUser } from "../../utils/session";
import { isUniqueConstraintError } from "../../utils/unique-constraint";
import type {
	StreamPayWebhookData,
	StreamPayWebhookEnvelope,
	StreamPayWebhookPayload,
} from "../../webhooks/events";
import {
	ACTIVATION_EVENT_ID_PREFIX,
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
	applySubscriptionProjection,
	inferPlanFromItems,
	isOlderProviderState,
	lifecycleWriteGuard,
	liveSlotKey,
	parseDate,
	persistReconciledProjection,
	projectPlanFields,
	projectSubscriptionFields,
	reconcileProjectionAgainstExisting,
} from "./reconcile";
import { confirmLatestRenewal, findNextHistoricalRenewal } from "./renewal-evidence";
import { isTerminalSubscriptionStatus, toLocalStatus } from "./status";
import {
	APP_ID_METADATA_KEY,
	PLAN_NAME_METADATA_KEY,
	PLUGIN_METADATA_PREFIX,
	REFERENCE_ID_METADATA_KEY,
	REFERENCE_TYPE_METADATA_KEY,
	type StreamPayPlanLike,
	SUBSCRIPTION_ROW_ID_METADATA_KEY,
	type Subscription,
	type SubscriptionCallbackData,
	type SubscriptionCallbacks,
	type SubscriptionReferenceType,
	type SubscriptionsOptions,
	subscriptionSlotKey,
} from "./types";

export { WebhookEventInProgressError } from "../../webhooks/inbox";
export type { PluginAdapter, SyncContext } from "./adapter";
export { subscriptionItemProductId } from "./reconcile";

const SUBSCRIPTION_MODEL = "subscription";
const RENEWAL_CALLBACK_FAILURE_CODE = "SUBSCRIPTION_RENEWAL_CALLBACK_FAILED";
const DIRECT_ACTIVATION_CALLBACK_FAILURE_CODE = "SUBSCRIPTION_DIRECT_ACTIVATION_CALLBACK_FAILED";
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
	failureCode?: string,
): Promise<void> {
	if (!callback) return;
	try {
		await callback(data);
	} catch (err: unknown) {
		const msg = summarizeStreamPayError(err);
		logger(ctx).error(`subscription callback ${callbackName} failed: ${msg}`);
		if (retryOnError) {
			throw new SubscriptionCallbackDeliveryError(callbackName, err, failureCode);
		}
	}
}

class SubscriptionCallbackDeliveryError extends WebhookProcessingError {
	readonly callbackName: string;

	constructor(callbackName: string, cause: unknown, failureCode?: string) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(
			`Subscription callback ${callbackName} failed: ${message}`,
			failureCode ??
				(callbackName === "onSubscriptionRenewed"
					? RENEWAL_CALLBACK_FAILURE_CODE
					: "SubscriptionCallbackDeliveryError"),
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
	displaceUnpaid = true,
): Promise<void> {
	await yieldReservationToPaidSubscription({
		client,
		adapter: ctx.context.adapter,
		slotKey,
		ownerRowId,
		streampaySubscriptionId,
		displaceUnpaid,
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
	displaceUnpaid = true,
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
		displaceUnpaid,
	);
}

function updateReconciledSubscription(
	ctx: SyncContext,
	client: StreamPayClient,
	existing: Subscription,
	projected: Partial<Subscription>,
	streampaySubscriptionId: string,
	displaceUnpaid = true,
): Promise<Subscription> {
	return persistReconciledProjection(ctx.context.adapter, existing, projected, {
		streampaySubscriptionId,
		takeSlot: (slotKey) =>
			takeSlotFromReservation(
				ctx,
				client,
				slotKey,
				existing.id,
				streampaySubscriptionId,
				displaceUnpaid,
			),
	});
}

export type LinkOptions = Pick<
	SubscriptionsOptions,
	| "appId"
	| "resolveSubscriptionReference"
	| "resolveUnlinkedSubscription"
	| "reconcilePayments"
	| "maxWebhookAttempts"
>;

function linkPolicy(options: LinkOptions, source: LinkPolicy["source"]): LinkPolicy {
	return { ...options, source };
}

/** Only these keep 3.x linking of unverified organization and custom references. */
const CREATION_EVENT_TYPES = new Set(["SUBSCRIPTION_CREATED", "SUBSCRIPTION_ACTIVATED"]);

/** A callback's own failure is retried, whatever status its error carries. */
class LinkCallbackError extends Error {
	constructor(callbackName: string, cause: unknown) {
		super(`${callbackName} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "LinkCallbackError";
	}
}

async function runLinkCallback<T>(callbackName: string, run: () => T | Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		throw new LinkCallbackError(callbackName, err);
	}
}

/** How a subscription without a linked local row may be linked. */
export interface LinkPolicy extends LinkOptions {
	/** Admin links are explicit; creation events keep 3.x behaviour; every other event is strict. */
	source: "creation" | "recovery" | "admin";
}

interface UnlinkedCorrelation {
	referenceId: string;
	referenceType: SubscriptionReferenceType | null;
	planName: string;
	localRowId: string | null;
	appId: string | null;
	/** The app's resolver chose the reference, so metadata ownership checks do not apply. */
	resolved: boolean;
}

async function findUserRow(
	ctx: SyncContext,
	where: Array<{ field: string; value: string }>,
): Promise<(Record<string, unknown> & { id: string; streampayConsumerId?: string | null }) | null> {
	return ctx.context.adapter.findOne({ model: "user", where });
}

/**
 * Plugin checkout metadata names the reference. Without it, the app's resolver may name one, for
 * example for a subscription created in the StreamPay dashboard.
 */
async function resolveUnlinkedCorrelation(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	stream: SubscriptionDetailed,
	plans: ResolvedPlans,
	policy: LinkPolicy,
): Promise<UnlinkedCorrelation | null> {
	const referenceId = readMetadataString(payload.data, REFERENCE_ID_METADATA_KEY);
	const planName =
		readMetadataString(payload.data, PLAN_NAME_METADATA_KEY) ?? inferPlanFromItems(stream, plans);
	if (referenceId && planName) {
		return {
			referenceId,
			referenceType: readReferenceType(payload.data),
			planName,
			localRowId: readMetadataString(payload.data, SUBSCRIPTION_ROW_ID_METADATA_KEY),
			appId: readMetadataString(payload.data, APP_ID_METADATA_KEY),
			resolved: false,
		};
	}
	const metadata = payload.data?.metadata;
	const hasPluginMetadata = Object.keys(metadata ?? {}).some((key) =>
		key.startsWith(PLUGIN_METADATA_PREFIX),
	);
	const resolve = policy.resolveUnlinkedSubscription;
	if (!resolve || hasPluginMetadata) {
		logger(ctx).warn(
			`webhook ${payload.event_type}: cannot link sub=${stream.id} — missing plan_name (${planName}) or reference_id (${referenceId}) metadata.`,
		);
		return null;
	}
	const inferredName = inferPlanFromItems(stream, plans);
	const consumerUser = stream.organization_consumer_id
		? await findUserRow(ctx, [
				{ field: "streampayConsumerId", value: stream.organization_consumer_id },
			])
		: null;
	const resolution = await runLinkCallback("resolveUnlinkedSubscription", () =>
		resolve({
			subscription: stream,
			consumerUser: asSessionUser(consumerUser),
			linkMetadata: metadata && Object.keys(metadata).length > 0 ? metadata : null,
			inferredPlan: inferredName ? (plans.byName.get(inferredName) ?? null) : null,
		}),
	);
	if (!resolution) {
		logger(ctx).info(
			`webhook ${payload.event_type}: resolveUnlinkedSubscription left sub=${stream.id} unlinked.`,
		);
		return null;
	}
	const resolvedPlan = resolution.plan ?? inferredName;
	if (!inferredName || resolvedPlan !== inferredName) {
		throw new SubscriptionCorrelationError(
			`resolveUnlinkedSubscription chose plan "${resolution.plan}" for sub=${stream.id}, but StreamPay bills ${inferredName ? `plan "${inferredName}"` : "no configured plan"}.`,
		);
	}
	return {
		referenceId: resolution.referenceId,
		referenceType: resolution.referenceType,
		planName: resolvedPlan,
		localRowId: null,
		appId: null,
		resolved: true,
	};
}

/**
 * Ownership proof for linking without a local reservation. A StreamPay organization can be shared by
 * several apps or environments, so metadata alone does not prove this app sold the subscription.
 */
async function verifyUnlinkedOwnership(
	ctx: SyncContext,
	stream: SubscriptionDetailed,
	plans: ResolvedPlans,
	policy: LinkPolicy,
	correlation: UnlinkedCorrelation,
): Promise<
	{ plan: StreamPayPlanLike; referenceType: SubscriptionReferenceType } | { refusal: string }
> {
	const inferredName = inferPlanFromItems(stream, plans);
	const plan = inferredName ? plans.byName.get(inferredName) : undefined;
	if (!plan) return { refusal: "StreamPay bills no configured plan product" };
	const { referenceId } = correlation;
	if (correlation.referenceType === null || correlation.referenceType === "user") {
		const user = await findUserRow(ctx, [{ field: "id", value: referenceId }]);
		const consumerMatches =
			correlation.resolved ||
			policy.source === "admin" ||
			!user?.streampayConsumerId ||
			!stream.organization_consumer_id ||
			user.streampayConsumerId === stream.organization_consumer_id;
		if (user && consumerMatches) return { plan, referenceType: "user" };
		if (correlation.referenceType === "user") {
			return {
				refusal: user ? "user belongs to another StreamPay consumer" : "user does not exist",
			};
		}
	}
	const referenceType = correlation.referenceType ?? "custom";
	if (correlation.resolved || policy.source === "admin") {
		return { plan, referenceType };
	}
	if (policy.resolveSubscriptionReference) {
		const resolveReference = policy.resolveSubscriptionReference;
		const accepted = await runLinkCallback("resolveSubscriptionReference", () =>
			resolveReference({ referenceType, referenceId, plan, subscription: stream }),
		);
		return accepted
			? { plan, referenceType }
			: { refusal: `resolveSubscriptionReference rejected ${referenceType} reference` };
	}
	if (policy.source === "recovery") {
		return { refusal: `${referenceType} references need resolveSubscriptionReference` };
	}
	logger(ctx).warn(
		`linking StreamPay sub=${stream.id} to unverified ${referenceType} reference=${referenceId}; configure resolveSubscriptionReference to verify it.`,
	);
	return { plan, referenceType };
}

async function reconcileFromStreamPay(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
	policy: LinkPolicy,
	prefetched?: SubscriptionDetailed,
): Promise<{
	row: Subscription | null;
	stream: SubscriptionDetailed | null;
	previous?: Subscription;
}> {
	const streampaySubscriptionId = payload.entity_id;
	if (!streampaySubscriptionId) {
		logger(ctx).warn(`webhook ${payload.event_type} has no entity_id — cannot reconcile.`);
		return { row: null, stream: null };
	}

	let stream: SubscriptionDetailed;
	try {
		stream = prefetched ?? (await client.getSubscription(streampaySubscriptionId));
	} catch (err: unknown) {
		const msg = summarizeStreamPayError(err);
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
			policy.source !== "admin",
		);
		if (!eventApplies) {
			logger(ctx).info(
				`webhook ${payload.event_type}: ignored stale lifecycle callback for sub=${streampaySubscriptionId}.`,
			);
			return { row: null, stream };
		}
		return { row: updated, stream, previous: existing };
	}

	const correlation = await resolveUnlinkedCorrelation(ctx, payload, stream, plans, policy);
	if (!correlation) return { row: null, stream };
	const { referenceId, referenceType: metadataReferenceType, planName } = correlation;
	const refuse = (reason: string) => {
		logger(ctx).warn(
			`webhook ${payload.event_type}: did not link StreamPay sub=${streampaySubscriptionId}: ${reason}.`,
		);
		return { row: null, stream };
	};
	// Checked before any correlation: a cloned database can hold another app's reservation rows.
	if (correlation.appId && correlation.appId !== policy.appId) {
		return refuse(`checkout link belongs to app "${correlation.appId}"`);
	}
	const displaceUnpaid = policy.source !== "admin";

	const paymentLinkId =
		stream.latest_invoice?.payment_link_id ?? payload.data?.payment_link?.id ?? null;
	const rowMatches = (row: Subscription) =>
		row.referenceId === referenceId &&
		(!metadataReferenceType || (row.referenceType ?? "user") === metadataReferenceType) &&
		row.plan === planName &&
		(!row.streampayConsumerId ||
			!stream.organization_consumer_id ||
			row.streampayConsumerId === stream.organization_consumer_id) &&
		(!row.streampaySubscriptionId || row.streampaySubscriptionId === streampaySubscriptionId) &&
		(!row.streampayPaymentLinkId || !paymentLinkId || row.streampayPaymentLinkId === paymentLinkId);
	const localRowId = correlation.localRowId;
	if (localRowId) {
		const metadataRow = await ctx.context.adapter.findOne<Subscription>({
			model: SUBSCRIPTION_MODEL,
			where: [{ field: "id", value: localRowId }],
		});
		if (!metadataRow) {
			logger(ctx).warn(
				`webhook ${payload.event_type}: referenced subscription row=${localRowId} is missing; rebuilding from signed metadata.`,
			);
		} else if (rowMatches(metadataRow)) {
			const updated = await linkReservedRow(
				ctx,
				client,
				metadataRow,
				projected,
				metadataReferenceType,
				streampaySubscriptionId,
				displaceUnpaid,
			);
			return { row: updated, stream };
		} else {
			logger(ctx).warn(
				`webhook ${payload.event_type}: ignored unsafe subscription row correlation for row=${localRowId}.`,
			);
			throw new SubscriptionCorrelationError(
				`Webhook ${payload.event_type} failed protected subscription correlation for row=${localRowId}.`,
			);
		}
	}
	// The row that owns the checkout link, in any status, is the strongest local correlation left.
	const linkOwner = paymentLinkId
		? await ctx.context.adapter.findOne<Subscription>({
				model: SUBSCRIPTION_MODEL,
				where: [{ field: "streampayPaymentLinkId", value: paymentLinkId }],
			})
		: null;
	if (linkOwner) {
		if (!rowMatches(linkOwner)) {
			throw new SubscriptionCorrelationError(
				`StreamPay sub=${streampaySubscriptionId} was paid through payment link=${paymentLinkId} of row=${linkOwner.id}, which belongs to another reference or plan.`,
			);
		}
		const updated = await linkReservedRow(
			ctx,
			client,
			linkOwner,
			projected,
			metadataReferenceType,
			streampaySubscriptionId,
			displaceUnpaid,
		);
		return { row: updated, stream };
	}

	// An admin link never adopts someone's open checkout; only the reservation owning its link.
	const incomplete = displaceUnpaid
		? await findIncompleteRow(
				ctx,
				referenceId,
				metadataReferenceType,
				planName,
				paymentLinkId,
				stream.organization_consumer_id ?? null,
			)
		: null;
	if (incomplete) {
		const updated = await linkReservedRow(
			ctx,
			client,
			incomplete,
			projected,
			metadataReferenceType,
			streampaySubscriptionId,
			displaceUnpaid,
		);
		return { row: updated, stream };
	}

	const owner = await verifyUnlinkedOwnership(ctx, stream, plans, policy, correlation);
	if ("refusal" in owner) return refuse(owner.refusal);

	const { plan, referenceType } = owner;
	const activeSlotKey = isTerminalSubscriptionStatus(projected.status)
		? null
		: subscriptionSlotKey(referenceType, referenceId, plan.group);
	if (activeSlotKey) {
		await takeSlotFromReservation(
			ctx,
			client,
			activeSlotKey,
			null,
			streampaySubscriptionId,
			displaceUnpaid,
		);
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
			plan: plan.name,
			planVersion: plan.version ?? null,
			productId: plan.productId,
			group: plan.group ?? null,
			billingStatus: "current",
			createdAt: new Date(),
		},
	});
	return { row, stream };
}

interface SubscriptionEventOptions {
	eventId?: string | null;
	retryOnCallbackError: boolean;
	retryingDirectActivationCallback?: boolean;
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
	callbacks: SubscriptionCallbacks & LinkOptions,
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
			options.eventId ?? webhookEventId(payload),
		);
		return;
	}
	const { row, stream, previous } = await reconcileFromStreamPay(
		ctx,
		payload,
		client,
		plans,
		linkPolicy(callbacks, CREATION_EVENT_TYPES.has(payload.event_type) ? "creation" : "recovery"),
	);
	if (!row) return;
	if (
		callbacks.reconcilePayments &&
		callbacks.onSubscriptionActivated &&
		payload.event_type === "SUBSCRIPTION_ACTIVATED" &&
		!options.retryingDirectActivationCallback &&
		initialCheckoutActivation(row, stream, payload, previous)
	) {
		await deliverWebhookEvent(
			ctx,
			initialActivationScope(client, callbacks, options.retryOnCallbackError),
			payload,
			{ rawBody: JSON.stringify(payload), signatureHeader: null },
		);
		return;
	}
	await dispatchSubscriptionCallback(
		ctx,
		payload,
		{
			subscription: row,
			streampaySubscription: stream,
			user: await resolveRowUser(ctx, row),
			event: payload,
		},
		callbacks,
		options.retryOnCallbackError,
		options.eventId ?? webhookEventId(payload),
	);
}

function initialCheckoutActivation(
	row: Subscription,
	stream: SubscriptionDetailed | null,
	payload: StreamPayWebhookPayload,
	previous?: Subscription,
): boolean {
	if (!row.streampayPaymentLinkId || stream?.status !== "ACTIVE") return false;
	const eventAt = parseDate(payload.timestamp);
	if (
		isTerminalSubscriptionStatus(previous?.status) &&
		(!previous?.providerUpdatedAt || !eventAt || eventAt >= previous.providerUpdatedAt)
	) {
		return false;
	}
	if (payload.data?.payment_link?.id === row.streampayPaymentLinkId) return true;
	if ((stream.current_cycle_number ?? 1) > 1) {
		return eventAt !== null && row.periodStart !== null && eventAt < row.periodStart;
	}
	return (
		stream.latest_invoice?.payment_link_id === row.streampayPaymentLinkId &&
		stream.latest_invoice?.status === "COMPLETED"
	);
}

/** The paid checkout's first activation has one receipt across provider delivery and recovery. */
export function initialActivationScope(
	client: StreamPayClient,
	callbacks: SubscriptionCallbacks & LinkOptions,
	retryOnCallbackError: boolean,
): WebhookInboxScope {
	return {
		eventIdPrefix: ACTIVATION_EVENT_ID_PREFIX,
		eventKey: (event) => `checkout:${event.entity_id}`,
		maxAttempts: callbacks.maxWebhookAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS,
		isPermanentFailure: (err) => classifyWebhookFailure(err) === "PERMANENT",
		prepare: (event) => {
			if (event.event_type !== "SUBSCRIPTION_ACTIVATED" || !isSubscriptionSyncEvent(event)) {
				return null;
			}
			return async (ctx) => {
				const row = await findSubscriptionByStreampayId(ctx, event.entity_id);
				if (!row) return;
				const stream = await client.getSubscription(event.entity_id);
				if (stream.id !== event.entity_id || stream.status !== "ACTIVE") return;
				await fireCallback(
					ctx,
					callbacks.onSubscriptionActivated,
					{
						subscription: row,
						streampaySubscription: stream,
						user: await resolveRowUser(ctx, row),
						event,
						idempotencyKey: `subscription:${stream.id}:checkout-activation`,
					},
					"onSubscriptionActivated",
					retryOnCallbackError,
				);
			};
		},
	};
}

/** The inbox scope that reconciles subscription rows from StreamPay events. */
export function subscriptionInboxScope(args: {
	client: StreamPayClient;
	plans: () => Promise<ResolvedPlans>;
	callbacks: SubscriptionCallbacks & LinkOptions;
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
					eventId: attempt.eventId,
					retryOnCallbackError: args.retryOnCallbackError !== false,
					retryingDirectActivationCallback:
						attempt.previousErrorCode === DIRECT_ACTIVATION_CALLBACK_FAILURE_CODE,
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
	callbacks: SubscriptionCallbacks & LinkOptions,
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
	policy: LinkPolicy,
	stream: SubscriptionDetailed,
): Promise<Subscription | null> {
	if (!stream.id) return null;
	const paymentLinkId = stream.latest_invoice?.payment_link_id ?? null;
	const reservation = paymentLinkId
		? await ctx.context.adapter.findOne<Subscription>({
				model: SUBSCRIPTION_MODEL,
				where: [{ field: "streampayPaymentLinkId", value: paymentLinkId }],
			})
		: null;
	// Without a reservation, only a configured plan product can be this app's; others cost no lookup.
	if (!reservation && !inferPlanFromItems(stream, plans)) return null;
	const metadata = paymentLinkId ? await readCheckoutLinkMetadata(client, paymentLinkId) : null;
	const { row } = await reconcileFromStreamPay(
		ctx,
		{
			...payload,
			entity_type: "SUBSCRIPTION",
			entity_id: stream.id,
			data: {
				metadata: metadata ?? {},
				...(paymentLinkId ? { payment_link: { id: paymentLinkId, url: "" } } : {}),
			},
		} as StreamPayWebhookPayload,
		client,
		plans,
		policy,
		stream,
	);
	if (row) {
		logger(ctx).warn(
			`webhook ${payload.event_type}: linked row=${row.id} to StreamPay sub=${stream.id} from renewal evidence.`,
		);
		return row;
	}
	// A creation webhook linked it first; the renewal checks below still apply to that row.
	return findSubscriptionByStreampayId(ctx, stream.id);
}

async function readCheckoutLinkMetadata(
	client: StreamPayClient,
	paymentLinkId: string,
): Promise<Record<string, unknown> | null> {
	try {
		const link = await client.getPaymentLink(paymentLinkId);
		return link?.custom_metadata ?? null;
	} catch (err) {
		if (readSdkErrorFields(err).status === 404) return null;
		throw err;
	}
}

async function handleRenewalEvidence(
	ctx: SyncContext,
	payload: StreamPayWebhookPayload,
	client: StreamPayClient,
	plans: ResolvedPlans,
	callbacks: SubscriptionCallbacks & LinkOptions,
	retryOnCallbackError: boolean,
	retryingRenewalCallback: boolean,
	inboxEnabled: boolean,
	eventId: string | null,
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
			const msg = summarizeStreamPayError(err);
			logger(ctx).error(`${payload.event_type}: getInvoice(${invoiceId}) failed: ${msg}`);
			throw err;
		}
	}

	if (!subscriptionId) return;

	let stream: SubscriptionDetailed;
	try {
		stream = await client.getSubscription(subscriptionId);
	} catch (err: unknown) {
		const msg = summarizeStreamPayError(err);
		logger(ctx).error(`${payload.event_type}: getSubscription(${subscriptionId}) failed: ${msg}`);
		throw err;
	}

	const existing =
		(await findSubscriptionByStreampayId(ctx, subscriptionId)) ??
		(await linkCheckoutFromRenewalEvidence(
			ctx,
			payload,
			client,
			plans,
			linkPolicy(callbacks, "recovery"),
			stream,
		));
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
	const historicalRetry = eventId !== null && existing.renewalCallbackEventId === eventId;
	const baseline = existing.renewedCycleNumber ?? existing.currentCycleNumber;
	let historicalCycle: number | null = null;
	if (
		callbacks.reconcilePayments &&
		!historicalRetry &&
		baseline !== null &&
		(stream.current_cycle_number ?? 0) - baseline > 1
	) {
		if (stream.status !== "ACTIVE" || !evidenceInvoiceId) return;
		const historical = await findNextHistoricalRenewal(client, stream, existing, baseline);
		if (!historical || historical.invoiceId !== evidenceInvoiceId) return;
		historicalCycle = historical.cycle;
	}
	if (
		!historicalRetry &&
		historicalCycle === null &&
		payload.webhook_delivery_id?.startsWith("recovery-renewal:") &&
		!settlesLatestInvoice
	) {
		throw new Error("The provider changed the renewal invoice during reconciliation.");
	}
	if (
		callbacks.reconcilePayments &&
		!historicalRetry &&
		historicalCycle === null &&
		evidenceInvoiceId &&
		stream.latest_invoice?.id &&
		!settlesLatestInvoice
	)
		return;
	const evidenceApplies = historicalCycle !== null || !eventIsStale || settlesLatestInvoice;
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
	const projectedCycle = historicalCycle ?? projected.currentCycleNumber ?? null;
	// Period boundaries drift between cycles, so the provider's cycle counter identifies a renewal.
	const tracksCycles = renewedCycle !== null && projectedCycle !== null;
	const renewalAdvanced = tracksCycles ? projectedCycle > renewedCycle : periodAdvanced;
	if (
		callbacks.reconcilePayments &&
		!historicalRetry &&
		historicalCycle === null &&
		renewalAdvanced
	) {
		const latestInvoiceId = stream.latest_invoice?.id;
		if (
			!settlesLatestInvoice ||
			!latestInvoiceId ||
			stream.status !== "ACTIVE" ||
			!(await confirmLatestRenewal(client, existing, latestInvoiceId))
		)
			return;
	}
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
		historicalCycle === null &&
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
		update: {
			...(pendingCallback
				? {}
				: historicalCycle === null
					? projected
					: { renewedCycleNumber: historicalCycle }),
			renewalCallbackEventId: callbackOwner,
		},
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
			{
				subscription: row,
				streampaySubscription: stream,
				user,
				event: payload,
				idempotencyKey:
					"subscription:" +
					subscriptionId +
					":renewal:" +
					(row.renewedCycleNumber ?? evidenceInvoiceId ?? invoiceId),
			},
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
	callbacks: SubscriptionCallbacks & LinkOptions,
	retryOnCallbackError: boolean,
	eventId: string | null,
): Promise<void> {
	const callbackName = LIFECYCLE_CALLBACKS[payload.event_type];
	if (!callbackName) return;
	await fireCallback(
		ctx,
		callbacks[callbackName],
		{ ...data, ...(eventId ? { idempotencyKey: `${callbackName}:${eventId}` } : {}) },
		callbackName,
		retryOnCallbackError,
		callbackName === "onSubscriptionActivated" && callbacks.reconcilePayments
			? DIRECT_ACTIVATION_CALLBACK_FAILURE_CODE
			: undefined,
	);
}

export interface SubscriptionLinkRequest {
	streampaySubscriptionId: string;
	referenceType: SubscriptionReferenceType;
	referenceId: string;
	/** Defaults to the configured plan whose product StreamPay bills. */
	plan?: string;
}

/**
 * Explicitly links an existing StreamPay subscription to a local reference. It projects provider
 * state only: no lifecycle callback fires, so a later real webhook cannot duplicate provisioning.
 * It never takes a billing slot from another row, not even an unpaid checkout.
 */
export async function linkSubscriptionToReference(
	ctx: SyncContext,
	client: StreamPayClient,
	plans: ResolvedPlans,
	options: LinkOptions,
	request: SubscriptionLinkRequest,
): Promise<{ row: Subscription; reused: boolean }> {
	const { streampaySubscriptionId, referenceType, referenceId } = request;
	const stream = await client.getSubscription(streampaySubscriptionId);
	const sameReference = (row: Subscription) =>
		row.referenceId === referenceId && (row.referenceType ?? "user") === referenceType;
	const reuse = async (row: Subscription) => {
		if (!sameReference(row)) {
			throw new APIError("CONFLICT", {
				code: $ERROR_CODES.SUBSCRIPTION_INVALID_STATE.code,
				message: `StreamPay subscription ${streampaySubscriptionId} is already linked to another reference.`,
			});
		}
		await applySubscriptionProjection(
			ctx.context.adapter,
			stream,
			plans,
			logger(ctx),
			"link subscription",
		);
		return {
			row: (await findSubscriptionByStreampayId(ctx, streampaySubscriptionId)) ?? row,
			reused: true,
		};
	};
	const existing = await findSubscriptionByStreampayId(ctx, streampaySubscriptionId);
	if (existing) return reuse(existing);

	const inferredName = inferPlanFromItems(stream, plans);
	const planName = request.plan ?? inferredName;
	const plan = planName ? plans.byName.get(planName) : undefined;
	if (!plan || planName !== inferredName) {
		throw new APIError("BAD_REQUEST", {
			code: $ERROR_CODES.SUBSCRIPTION_PLAN_NOT_FOUND.code,
			message: inferredName
				? `StreamPay bills plan "${inferredName}", not "${request.plan}".`
				: "StreamPay bills no configured plan product.",
		});
	}
	if (
		referenceType === "user" &&
		!(await findUserRow(ctx, [{ field: "id", value: referenceId }]))
	) {
		throw new APIError("BAD_REQUEST", {
			code: $ERROR_CODES.SUBSCRIPTION_NOT_FOUND.code,
			message: `User ${referenceId} does not exist.`,
		});
	}
	const paymentLinkId = stream.latest_invoice?.payment_link_id ?? null;
	if (!isTerminalSubscriptionStatus(toLocalStatus(stream.status))) {
		const holder = await ctx.context.adapter.findOne<Subscription>({
			model: SUBSCRIPTION_MODEL,
			where: [
				{
					field: "activeSlotKey",
					value: subscriptionSlotKey(referenceType, referenceId, plan.group),
				},
			],
		});
		if (holder && !(paymentLinkId && holder.streampayPaymentLinkId === paymentLinkId)) {
			throw new APIError("CONFLICT", {
				code: $ERROR_CODES.SUBSCRIPTION_ALREADY_ACTIVE.code,
				message: `Row ${holder.id} (${holder.status}) holds this reference's billing slot. Resolve it first.`,
			});
		}
	}
	try {
		const { row } = await reconcileFromStreamPay(
			ctx,
			{
				event_type: "SUBSCRIPTION_CREATED",
				entity_type: "SUBSCRIPTION",
				entity_id: streampaySubscriptionId,
				entity_url: "",
				status: stream.status ?? "",
				timestamp: new Date().toISOString(),
				data: {
					metadata: {
						[PLAN_NAME_METADATA_KEY]: plan.name,
						[REFERENCE_ID_METADATA_KEY]: referenceId,
						[REFERENCE_TYPE_METADATA_KEY]: referenceType,
					},
					...(paymentLinkId ? { payment_link: { id: paymentLinkId, url: "" } } : {}),
				},
			} as StreamPayWebhookPayload,
			client,
			plans,
			linkPolicy(options, "admin"),
			stream,
		);
		if (row && !sameReference(row)) return reuse(row);
		if (row) return { row, reused: false };
	} catch (err) {
		const winner = await findSubscriptionByStreampayId(ctx, streampaySubscriptionId);
		if (winner) return reuse(winner);
		if (err instanceof SubscriptionCorrelationError || isUniqueConstraintError(err)) {
			throw new APIError("CONFLICT", {
				code: $ERROR_CODES.SUBSCRIPTION_INVALID_STATE.code,
				message: err instanceof Error ? err.message : String(err),
			});
		}
		throw err;
	}
	throw new APIError("BAD_REQUEST", {
		code: $ERROR_CODES.SUBSCRIPTION_INVALID_STATE.code,
		message: `StreamPay subscription ${streampaySubscriptionId} could not be linked. See server logs.`,
	});
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
