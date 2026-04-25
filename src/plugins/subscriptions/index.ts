import type { GenericEndpointContext } from "better-auth";
import type { StreamPayOptions } from "../../types";
import type { StreamPayWebhookPayload } from "../../webhooks/events";
import { buildSubscriptionEndpoints } from "./endpoints";
import { createPlanResolver, validatePlansShape } from "./plans";
import { subscriptionTable, webhookEventTable } from "./schema";
import {
	classifyWebhookFailure,
	syncWebhookPayload,
	type SyncContext,
} from "./sync";
import type { StreamPayPlanLike, SubscriptionsOptions } from "./types";

export type {
	AuthorizeReferenceContext,
	StreamPayPlan,
	StreamPayPlanLike,
	Subscription,
	SubscriptionCallback,
	SubscriptionCallbackData,
	SubscriptionCallbacks,
	SubscriptionsOptions,
	SubscriptionStatus,
} from "./types";
export {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	UPGRADE_IDEMPOTENCY_WINDOW_MS,
} from "./types";
export { hasFeature, checkLimit, type LimitCheckResult, type ResolvedPlans } from "./plans";
export { subscriptionSchema, type SubscriptionSchema } from "./schema";
export {
	classifyWebhookFailure,
	syncWebhookPayload,
	type PluginAdapter,
	type SyncContext,
	type WebhookSyncFailure,
} from "./sync";

/**
 * Shared registry the main `streampay()` plugin hands to each sub-plugin
 * factory. Used by sub-plugins that need request-time communication —
 * e.g. subscriptions sync → webhooks dispatch. Fresh per `streampay()` call.
 */
export interface StreamPayPluginRegistry {
	subscriptionWebhookSync?: (
		ctx: GenericEndpointContext,
		payload: StreamPayWebhookPayload,
	) => Promise<void>;
}

export function subscriptions(subsOptions: SubscriptionsOptions) {
	if (Array.isArray(subsOptions.plans)) {
		validatePlansShape(subsOptions.plans as readonly StreamPayPlanLike[]);
	} else if (typeof subsOptions.plans !== "function") {
		throw new TypeError("subscriptions(): `plans` must be an array or an async factory function.");
	}

	const tableEnabled = subsOptions.enableSubscriptionTable !== false;
	const dedupeEnabled = subsOptions.enableWebhookEventTable !== false;

	return (options: StreamPayOptions, registry?: StreamPayPluginRegistry) => {
		const resolvePlans = createPlanResolver(subsOptions.plans);

		if (registry && tableEnabled) {
			registry.subscriptionWebhookSync = async (
				ctx: GenericEndpointContext,
				payload: StreamPayWebhookPayload,
			) => {
				const syncCtx: SyncContext = {
					context: ctx.context as SyncContext["context"],
				};
				const plans = await resolvePlans();
				try {
					await syncWebhookPayload(syncCtx, payload, options.client, plans, subsOptions, {
						dedupe: dedupeEnabled,
					});
				} catch (err) {
					if (classifyWebhookFailure(err) === "PERMANENT") {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.context.logger.warn(
							`StreamPay subscription sync: permanent failure on event=${payload.event_type} entity=${payload.entity_id}: ${msg}`,
						);
						return;
					}
					throw err;
				}
			};
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
