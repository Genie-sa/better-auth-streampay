import type { SubscriptionDetailed } from "@streamsdk/typescript";
import type { GenericEndpointContext } from "better-auth";
import type { StreamPayOptions } from "../../types";
import { getLogger } from "../../utils/logger";
import type { StreamPayWebhookPayload } from "../../webhooks/events";
import {
	createWebhookInbox,
	deliverWebhookEvent,
	type WebhookInbox,
	type WebhookInboxScope,
} from "../../webhooks/inbox";
import { toSyncContext } from "./adapter";
import { buildSubscriptionEndpoints } from "./endpoints";
import { type ResolvedPlans, resolvePlans, validatePlansShape } from "./plans";
import { applySubscriptionProjection, syncSubscriptionFromUpstream } from "./reconcile";
import { subscriptionTable, webhookEventTable } from "./schema";
import { SUBSCRIPTION_STATUSES } from "./status";
import {
	classifyWebhookFailure,
	linkSubscriptionToReference,
	type SubscriptionLinkRequest,
	subscriptionInboxScope,
	syncWebhookPayload,
	type WebhookReplayOptions,
} from "./sync";
import type { StreamPayPlanLike, Subscription, SubscriptionsOptions } from "./types";

export {
	checkLimit,
	type FeatureKey,
	hasFeature,
	hasSubscriptionAccess,
	type LimitCheckResult,
	type ResolvedPlans,
} from "./plans";
export { type SubscriptionSchema, subscriptionSchema } from "./schema";
export {
	classifyWebhookFailure,
	type PluginAdapter,
	type SyncContext,
	syncWebhookPayload,
	WebhookEventInProgressError,
	type WebhookReplayOptions,
	type WebhookSyncFailure,
} from "./sync";
export type {
	AuthorizeReferenceContext,
	StreamPayPlan,
	StreamPayPlanLike,
	StreamPaySeatBilling,
	Subscription,
	SubscriptionBillingStatus,
	SubscriptionCallback,
	SubscriptionCallbackData,
	SubscriptionCallbacks,
	SubscriptionReferenceContext,
	SubscriptionReferenceType,
	SubscriptionStatus,
	SubscriptionsOptions,
	TrialEligibilityContext,
	UnlinkedSubscriptionContext,
	UnlinkedSubscriptionResolution,
} from "./types";
export {
	APP_ID_METADATA_KEY,
	DEFAULT_ACCESS_STATUSES,
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	REFERENCE_TYPE_METADATA_KEY,
	SUBSCRIPTION_ROW_ID_METADATA_KEY,
	subscriptionSlotKey,
	UPGRADE_IDEMPOTENCY_WINDOW_MS,
} from "./types";

export interface StreamPayPluginRegistry {
	subscriptionWebhookSync?: (
		ctx: GenericEndpointContext,
		payload: StreamPayWebhookPayload,
		meta?: { rawBody?: string; signatureHeader?: string | null },
	) => Promise<void>;

	/** Shared by every plugin that stores events in the webhook inbox table. */
	webhookInbox?: WebhookInbox;

	/**
	 * Re-projects a local subscription row from StreamPay after an out-of-band provider change,
	 * using the configured plan catalog. Never throws: a failed projection reconciles on the next
	 * webhook.
	 */
	refreshSubscriptionProjection?: (
		ctx: GenericEndpointContext,
		subscription: { streampaySubscriptionId: string } | { snapshot: SubscriptionDetailed },
		source: string,
	) => Promise<void>;

	replayWebhookEvent?: (
		ctx: GenericEndpointContext,
		eventId: string,
		options?: WebhookReplayOptions,
	) => Promise<{ replayed: true; eventId: string }>;
	/** @deprecated Use `replayWebhookEvent`; both replay any inbox event. */
	replayWebhookHandler?: NonNullable<StreamPayPluginRegistry["replayWebhookEvent"]>;

	linkSubscription?: (
		ctx: GenericEndpointContext,
		request: SubscriptionLinkRequest,
	) => Promise<{ row: Subscription; reused: boolean }>;
}

export function subscriptions(subsOptions: SubscriptionsOptions) {
	if (Array.isArray(subsOptions.plans)) {
		validatePlansShape(subsOptions.plans as readonly StreamPayPlanLike[]);
	} else if (typeof subsOptions.plans !== "function") {
		throw new TypeError("subscriptions(): `plans` must be an array or an async factory function.");
	}
	if (
		subsOptions.maxWebhookAttempts !== undefined &&
		(!Number.isInteger(subsOptions.maxWebhookAttempts) || subsOptions.maxWebhookAttempts < 1)
	) {
		throw new TypeError("subscriptions(): `maxWebhookAttempts` must be a positive integer.");
	}
	for (const status of subsOptions.accessStatuses ?? []) {
		if (!SUBSCRIPTION_STATUSES.includes(status)) {
			throw new TypeError(`subscriptions(): invalid access status "${status}".`);
		}
	}

	const dedupeEnabled = subsOptions.enableWebhookEventTable !== false;

	return (options: StreamPayOptions, registry?: StreamPayPluginRegistry) => {
		const plansRef = () => resolvePlans(subsOptions.plans);

		if (registry) {
			const scope = subscriptionInboxScope({
				client: options.client,
				plans: plansRef,
				callbacks: subsOptions,
				...(subsOptions.maxWebhookAttempts !== undefined && {
					maxAttempts: subsOptions.maxWebhookAttempts,
				}),
				retryOnCallbackError: subsOptions.retryOnCallbackError !== false,
			});
			// Without its own inbox table the scope still releases renewal owners of rows it stored earlier.
			registerWebhookInboxScope(registry, scope, { replayable: dedupeEnabled });

			registry.refreshSubscriptionProjection = async (ctx, subscription, source) => {
				const log = getLogger(ctx);
				let plans: ResolvedPlans | null = null;
				try {
					plans = await plansRef();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					log.warn(
						`${source}: plan catalog unavailable (${message}); projecting without plan fields.`,
					);
				}
				const adapter = toSyncContext(ctx).context.adapter;
				if ("snapshot" in subscription) {
					await applySubscriptionProjection(adapter, subscription.snapshot, plans, log, source);
					return;
				}
				await syncSubscriptionFromUpstream(
					options.client,
					adapter,
					subscription.streampaySubscriptionId,
					plans,
					log,
					source,
				);
			};

			registry.subscriptionWebhookSync = async (ctx, payload, meta) => {
				const syncCtx = toSyncContext(ctx);
				try {
					if (dedupeEnabled) {
						await deliverWebhookEvent(syncCtx, scope, payload, {
							rawBody: meta?.rawBody ?? null,
							signatureHeader: meta?.signatureHeader ?? null,
						});
					} else {
						await syncWebhookPayload(
							syncCtx,
							payload,
							options.client,
							await plansRef(),
							subsOptions,
							{
								dedupe: false,
								retryOnCallbackError: subsOptions.retryOnCallbackError !== false,
							},
						);
					}
				} catch (err) {
					if (classifyWebhookFailure(err) === "PERMANENT") {
						const msg = err instanceof Error ? err.message : String(err);
						getLogger(ctx).warn(
							`subscription sync: permanent failure on event=${payload.event_type} entity=${payload.entity_id}: ${msg}`,
						);
						return;
					}
					throw err;
				}
			};

			registry.linkSubscription = async (ctx, request) =>
				linkSubscriptionToReference(
					toSyncContext(ctx),
					options.client,
					await plansRef(),
					subsOptions,
					request,
				);
		}

		const schema = {
			...subscriptionTable,
			...(dedupeEnabled ? webhookEventTable : {}),
		};

		return {
			endpoints: buildSubscriptionEndpoints(options, subsOptions, plansRef),
			schema,
		};
	};
}

/** Registers a scope with the shared inbox and exposes replay through the registry. */
export function registerWebhookInboxScope(
	registry: StreamPayPluginRegistry,
	scope: WebhookInboxScope,
	options: { replayable: boolean },
): void {
	registry.webhookInbox ??= createWebhookInbox();
	const inbox = registry.webhookInbox;
	inbox.register(scope, options);
	if (!inbox.isEnabled()) return;
	const replay: NonNullable<StreamPayPluginRegistry["replayWebhookEvent"]> = (
		ctx,
		eventId,
		replayOptions,
	) =>
		inbox.replay(
			toSyncContext(ctx),
			eventId,
			replayOptions?.dueAttemptCount === undefined
				? {}
				: { dueAttemptCount: replayOptions.dueAttemptCount },
		);
	registry.replayWebhookEvent = replay;
	registry.replayWebhookHandler = replay;
}
