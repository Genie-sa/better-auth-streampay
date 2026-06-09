import type { SubscriptionDetailed } from "@streamsdk/typescript";
import type { GenericEndpointContext } from "better-auth";
import type { StreamPaySessionUser } from "../../utils/session";
import type { StreamPayWebhookPayload } from "../../webhooks/events";

export type SubscriptionRecurringInterval = NonNullable<SubscriptionDetailed["recurring_interval"]>;
export type StreamPaySubscriptionStatus = NonNullable<SubscriptionDetailed["status"]>;

export type SubscriptionStatus =
	| "incomplete"
	| "active"
	| "inactive"
	| "expired"
	| "canceled"
	| "frozen"
	| "past_due";

export function toLocalStatus(
	status: StreamPaySubscriptionStatus | string | undefined,
): SubscriptionStatus {
	switch (status) {
		case "ACTIVE":
			return "active";
		case "INACTIVE":
			return "inactive";
		case "EXPIRED":
			return "expired";
		case "CANCELED":
			return "canceled";
		case "FROZEN":
			return "frozen";
		default:
			return "incomplete";
	}
}

/** A subscribable plan. `productId` must reference a RECURRING StreamPay product whose interval matches `billingInterval`. */
export interface StreamPayPlan<Limits extends Record<string, unknown> = Record<string, unknown>> {
	name: string;
	productId: string;
	priceHalalat: number;
	billingInterval: SubscriptionRecurringInterval;
	billingIntervalCount?: number;
	group?: string;
	limits?: Limits;
}

export type StreamPayPlanLike = StreamPayPlan<Record<string, unknown>>;
export type PlansInput =
	| readonly StreamPayPlanLike[]
	| (() => Promise<readonly StreamPayPlanLike[]> | readonly StreamPayPlanLike[]);

export interface Subscription {
	id: string;
	referenceId: string;
	streampaySubscriptionId: string | null;
	streampayConsumerId: string | null;
	plan: string;
	group: string | null;
	amountHalalat: number | null;
	currency: string | null;
	billingInterval: SubscriptionRecurringInterval | null;
	billingIntervalCount: number | null;
	status: SubscriptionStatus;
	periodStart: Date | null;
	periodEnd: Date | null;
	cancelAtPeriodEnd: boolean;
	endedAt: Date | null;
	frozenAt: Date | null;
	freezeEndAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface SubscriptionCallbackData {
	subscription: Subscription;
	user: StreamPaySessionUser | null;
	streampaySubscription: SubscriptionDetailed | null;
	event: StreamPayWebhookPayload | null;
}

export type SubscriptionCallback = (data: SubscriptionCallbackData) => Promise<void> | void;

export interface SubscriptionCallbacks {
	onSubscriptionCreated?: SubscriptionCallback;
	onSubscriptionActivated?: SubscriptionCallback;
	onSubscriptionCanceled?: SubscriptionCallback;
	onSubscriptionFrozen?: SubscriptionCallback;
	onSubscriptionResumed?: SubscriptionCallback;
	onSubscriptionRenewed?: SubscriptionCallback;
	onSubscriptionPaymentFailed?: SubscriptionCallback;
}

export interface AuthorizeReferenceContext {
	user: StreamPaySessionUser;
	referenceId: string;
	action: "upgrade" | "cancel" | "freeze" | "unfreeze" | "read" | "change-plan";
}

interface SubscriptionsOptionsBase extends SubscriptionCallbacks {
	plans: PlansInput;

	authorizeReference?: (
		data: AuthorizeReferenceContext,
		ctx: GenericEndpointContext,
	) => boolean | Promise<boolean>;

	maxWebhookAttempts?: number;
}

type WebhookTablingOptions =
	| {
			enableSubscriptionTable?: true;
			enableWebhookEventTable?: boolean;
	  }
	| {
			enableSubscriptionTable: false;
			enableWebhookEventTable?: false;
	  };

/** Options for `subscriptions()`: the `plans` catalog, authorization, webhook dedupe, and lifecycle callbacks. */
export type SubscriptionsOptions = SubscriptionsOptionsBase & WebhookTablingOptions;

export const UPGRADE_IDEMPOTENCY_WINDOW_MS = 15 * 60 * 1000;

export const PLAN_NAME_METADATA_KEY = "streampay_plugin_plan_name";
export const REFERENCE_ID_METADATA_KEY = "streampay_plugin_reference_id";
