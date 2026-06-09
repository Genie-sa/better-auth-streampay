import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../../error-codes";
import type { StreamPayOptions } from "../../types";
import { getLogger } from "../../utils/logger";
import type { StreamPayWebhookPayload } from "../../webhooks/events";
import { buildSubscriptionEndpoints } from "./endpoints";
import { createPlanResolver, validatePlansShape } from "./plans";
import { subscriptionTable, webhookEventTable } from "./schema";
import {
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
	Subscription,
	SubscriptionCallback,
	SubscriptionCallbackData,
	SubscriptionCallbacks,
	SubscriptionStatus,
	SubscriptionsOptions,
} from "./types";
export {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
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

/** Subscriptions sub-plugin: plan upgrades, cancellation, feature/limit checks, and webhook-driven subscription sync. */
export function subscriptions(subsOptions: SubscriptionsOptions) {
	if (Array.isArray(subsOptions.plans)) {
		validatePlansShape(subsOptions.plans as readonly StreamPayPlanLike[]);
	} else if (typeof subsOptions.plans !== "function") {
		throw new TypeError("subscriptions(): `plans` must be an array or an async factory function.");
	}

	const flags = subsOptions as {
		enableSubscriptionTable?: boolean;
		enableWebhookEventTable?: boolean;
	};
	if (flags.enableSubscriptionTable === false && flags.enableWebhookEventTable === true) {
		throw new TypeError(
			"subscriptions(): `enableWebhookEventTable: true` requires `enableSubscriptionTable: true` — the event lifecycle table is part of the subscription sync pipeline.",
		);
	}
	const tableEnabled = subsOptions.enableSubscriptionTable !== false;
	const dedupeEnabled = subsOptions.enableWebhookEventTable !== false;

	return (options: StreamPayOptions, registry?: StreamPayPluginRegistry) => {
		const resolvePlans = createPlanResolver(subsOptions.plans);

		if (registry && tableEnabled) {
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

					const payload = JSON.parse(row.rawPayload) as StreamPayWebhookPayload;
					const plans = await resolvePlans();

					try {
						await syncWebhookPayload(syncCtx, payload, options.client, plans, subsOptions, {
							dedupe: false,
						});
						await markWebhookEventCompleted(syncCtx, row.id);
						return { replayed: true, eventId };
					} catch (err) {
						await recordWebhookEventFailure(syncCtx, row.id, null, null, err);
						throw err;
					}
				};
			}
		}

		const schema = {
			...(tableEnabled ? subscriptionTable : {}),
			...(tableEnabled && dedupeEnabled ? webhookEventTable : {}),
		};

		return {
			endpoints: buildSubscriptionEndpoints(options, subsOptions, resolvePlans),
			...(Object.keys(schema).length > 0 ? { schema } : {}),
		};
	};
}
