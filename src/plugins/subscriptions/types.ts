import type { SubscriptionDetailed } from "@streamsdk/typescript";
import type { GenericEndpointContext } from "better-auth";
import type { StreamPaySessionUser } from "../../utils/session";
import type { StreamPayWebhookPayload } from "../../webhooks/events";

// Enums live in the SDK's internal schemas namespace, not the barrel.
// Derive via property inference rather than `as` casts.
export type SubscriptionRecurringInterval = NonNullable<SubscriptionDetailed["recurring_interval"]>;
export type StreamPaySubscriptionStatus = NonNullable<SubscriptionDetailed["status"]>;

/**
 * Local status — a superset of StreamPay's native
 * `INACTIVE | ACTIVE | EXPIRED | CANCELED | FROZEN`:
 *   - `incomplete` — row pre-created at /upgrade; webhook not yet confirmed.
 *   - `past_due`   — renewal failed. StreamPay keeps `ACTIVE` during
 *                    dunning, which would misrepresent billing health.
 */
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

/**
 * App-declared plan. `Limits` is generic so `hasFeature` / `checkLimit`
 * narrow the feature-name argument to the literal keys the app declared —
 * typos fail at compile time. `productId` must refer to a RECURRING
 * product whose `recurring_interval` matches `billingInterval`.
 */
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

/**
 * Row shape of the local `subscription` table. Nullable columns use
 * `T | null` (not `T | undefined`) to match Better Auth adapter semantics.
 */
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
	// `null` when the callback fires from the /success fallback path.
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
	/**
	 * Subscribable plans — static array or async factory. Shape is
	 * validated at plugin init; productId existence is checked on first
	 * /upgrade call (lazy, needs the SDK client).
	 */
	plans: PlansInput;

	/**
	 * Additional authorization check per subscription endpoint. Fires
	 * when the caller's `referenceId` matches their own session id, and
	 * on every cross-account mutation.
	 */
	authorizeReference?: (
		data: AuthorizeReferenceContext,
		ctx: GenericEndpointContext,
	) => boolean | Promise<boolean>;

	/**
	 * Per-event delivery attempt cap before the row is parked as
	 * `dead_letter` and StreamPay is told to stop retrying. Default 10,
	 * minimum 1 (values <1 are clamped). Tune lower for faster
	 * surfacing of persistent bugs, higher to absorb longer transient
	 * outages.
	 */
	maxWebhookAttempts?: number;
}

/** `enableWebhookEventTable: true` requires `enableSubscriptionTable: true`. */
type WebhookTablingOptions =
	| {
			/** Default `true`. Set `false` to BYO state via `webhooks({ on* })`. */
			enableSubscriptionTable?: true;
			/** Default `true`. Set `false` if you handle webhook idempotency yourself
			 *  (Redis SETNX, etc.). StreamPay retries — you MUST dedupe externally. */
			enableWebhookEventTable?: boolean;
	  }
	| {
			enableSubscriptionTable: false;
			enableWebhookEventTable?: false;
	  };

export type SubscriptionsOptions = SubscriptionsOptionsBase & WebhookTablingOptions;

// Window during which a duplicate /upgrade reuses the existing `incomplete`
// row instead of creating a new payment link. Guards against double-clicks.
export const UPGRADE_IDEMPOTENCY_WINDOW_MS = 15 * 60 * 1000;

// Written into StreamPay's `custom_metadata` on the payment link — the
// webhook payload doesn't otherwise carry our plan identifier.
export const PLAN_NAME_METADATA_KEY = "streampay_plugin_plan_name";
export const REFERENCE_ID_METADATA_KEY = "streampay_plugin_reference_id";
