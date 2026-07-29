import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../../error-codes";
import type { StreamPayOptions } from "../../types";
import { getLogger } from "../../utils/logger";
import type { StreamPayWebhookPayload } from "../../webhooks/events";
import { isKnownStreamPayWebhookPayload, isStreamPayWebhookEnvelope } from "../../webhooks/events";
import { buildSubscriptionEndpoints } from "./endpoints";
import { createPlanResolver, validatePlansShape } from "./plans";
import { subscriptionTable, webhookEventTable } from "./schema";
import { SUBSCRIPTION_STATUSES } from "./status";
import {
	claimWebhookEventForReplay,
	classifyWebhookFailure,
	markWebhookEventCompleted,
	recordWebhookEventFailure,
	type SyncContext,
	syncWebhookPayload,
	WEBHOOK_EVENT_MODEL,
	type WebhookEventRow,
} from "./sync";
import type { StreamPayPlanLike, SubscriptionsOptions } from "./types";

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
	SubscriptionReferenceType,
	SubscriptionStatus,
	SubscriptionsOptions,
	TrialEligibilityContext,
} from "./types";
export {
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

	replayWebhookEvent?: (
		ctx: GenericEndpointContext,
		eventId: string,
	) => Promise<{ replayed: true; eventId: string }>;
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
		const resolvePlans = createPlanResolver(subsOptions.plans);

		if (registry) {
			registry.subscriptionWebhookSync = async (
				ctx: GenericEndpointContext,
				payload: StreamPayWebhookPayload,
				meta?: { rawBody?: string; signatureHeader?: string | null },
			) => {
				const syncCtx: SyncContext = {
					context: ctx.context as SyncContext["context"],
				};
				const plans = await resolvePlans();
				try {
					await syncWebhookPayload(syncCtx, payload, options.client, plans, subsOptions, {
						dedupe: dedupeEnabled,
						rawBody: meta?.rawBody ?? null,
						signatureHeader: meta?.signatureHeader ?? null,
						...(subsOptions.maxWebhookAttempts !== undefined && {
							maxAttempts: subsOptions.maxWebhookAttempts,
						}),
						retryOnCallbackError: subsOptions.retryOnCallbackError !== false,
					});
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

			if (dedupeEnabled) {
				registry.replayWebhookEvent = async (ctx, eventId) => {
					const syncCtx: SyncContext = {
						context: ctx.context as SyncContext["context"],
					};
					const row = await syncCtx.context.adapter.findOne<WebhookEventRow>({
						model: WEBHOOK_EVENT_MODEL,
						where: [{ field: "eventId", value: eventId }],
					});
					if (!row) {
						throw new APIError("NOT_FOUND", {
							code: $ERROR_CODES.NOT_FOUND.code,
							message: `Webhook event ${eventId} not found.`,
						});
					}
					if (!row.rawPayload) {
						throw new APIError("BAD_REQUEST", {
							message: `Webhook event ${eventId} has no rawPayload — nothing to replay (already completed cleanly?).`,
						});
					}

					let parsedPayload: unknown;
					try {
						parsedPayload = JSON.parse(row.rawPayload);
					} catch {
						throw new APIError("BAD_REQUEST", {
							message: `Webhook event ${eventId} has malformed stored JSON.`,
						});
					}
					if (
						!isStreamPayWebhookEnvelope(parsedPayload) ||
						!isKnownStreamPayWebhookPayload(parsedPayload)
					) {
						throw new APIError("BAD_REQUEST", {
							message: `Webhook event ${eventId} has an invalid stored payload.`,
						});
					}
					const payload = parsedPayload;
					const plans = await resolvePlans();
					const claimed = await claimWebhookEventForReplay(syncCtx, row);
					if (!claimed?.lockedBy) {
						throw new APIError("CONFLICT", {
							code: $ERROR_CODES.WEBHOOK_REPLAY_IN_PROGRESS.code,
							message: `Webhook event ${eventId} is already being replayed.`,
						});
					}

					try {
						await syncWebhookPayload(syncCtx, payload, options.client, plans, subsOptions, {
							dedupe: false,
							retryingRenewalCallback:
								claimed.lastError?.startsWith(
									"Subscription callback onSubscriptionRenewed failed:",
								) === true,
						});
						await markWebhookEventCompleted(syncCtx, claimed.id, claimed.lockedBy);
						return { replayed: true, eventId };
					} catch (err) {
						await recordWebhookEventFailure(
							syncCtx,
							claimed.id,
							null,
							null,
							err,
							claimed.lockedBy,
							true,
						);
						throw err;
					}
				};
			}
		}

		const schema = {
			...subscriptionTable,
			...(dedupeEnabled ? webhookEventTable : {}),
		};

		return {
			endpoints: buildSubscriptionEndpoints(options, subsOptions, resolvePlans),
			schema,
		};
	};
}
