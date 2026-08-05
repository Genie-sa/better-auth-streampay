import { createHash } from "node:crypto";
import type {
	CreatePaymentLinkDto,
	CurrencyCode,
	SubscriptionDetailed,
} from "@streamsdk/typescript";
import type { GenericEndpointContext } from "better-auth";
import type { StreamPaySessionUser } from "../../utils/session";
import type { StreamPayWebhookPayload } from "../../webhooks/events";
import type { StreamPaySubscriptionStatus, SubscriptionStatus } from "./status";

export type { StreamPaySubscriptionStatus, SubscriptionStatus } from "./status";
export {
	DEFAULT_ACCESS_STATUSES,
	toLocalStatus,
} from "./status";

export type SubscriptionRecurringInterval = NonNullable<SubscriptionDetailed["recurring_interval"]>;

export type SubscriptionBillingStatus = "current" | "past_due";
export type SubscriptionReferenceType = "user" | "organization" | "custom";

/** Controls per-seat checkout without conflating billed seats with entitlement limits. */
export interface StreamPaySeatBilling {
	/** Initial quantity when an upgrade request omits `seats`. Defaults to `minimum`, then 1. */
	default?: number;
	/** Smallest allowed seat count. Defaults to 1. */
	minimum?: number;
	/** Largest allowed seat count. Omit for no application-level maximum. */
	maximum?: number;
	/** Lets the customer edit quantity on StreamPay's hosted checkout. Defaults to false. */
	customerEditable?: boolean;
}

/** `productId` must reference a recurring StreamPay product matching `billingInterval`. */
export interface StreamPayPlan<Limits extends Record<string, unknown> = Record<string, unknown>> {
	name: string;
	productId: string;
	/** Price for one seat/item in the currency's smallest unit. */
	priceInSmallestUnit: number;
	currency?: CreatePaymentLinkDto["currency"];
	version?: string;
	billingInterval: SubscriptionRecurringInterval;
	billingIntervalCount?: number;
	trialPeriodDays?: number;
	group?: string;
	seatBilling?: StreamPaySeatBilling;
	limits?: Limits;
}

export type StreamPayPlanLike = StreamPayPlan<Record<string, unknown>>;
export type PlansInput =
	| readonly StreamPayPlanLike[]
	| (() => Promise<readonly StreamPayPlanLike[]> | readonly StreamPayPlanLike[]);

export interface Subscription {
	id: string;
	referenceId: string;
	referenceType: SubscriptionReferenceType;
	activeSlotKey: string | null;
	streampaySubscriptionId: string | null;
	streampayConsumerId: string | null;
	streampayPaymentLinkId: string | null;
	plan: string;
	planVersion: string | null;
	productId: string | null;
	group: string | null;
	/** Authoritative quantity for the configured plan product. Legacy rows default to 1. */
	seats: number;
	amountInSmallestUnit: number | null;
	originalAmountInSmallestUnit: number | null;
	currency: CurrencyCode | null;
	billingInterval: SubscriptionRecurringInterval | null;
	billingIntervalCount: number | null;
	status: SubscriptionStatus;
	providerStatus: StreamPaySubscriptionStatus | null;
	billingStatus: SubscriptionBillingStatus;
	periodStart: Date | null;
	periodEnd: Date | null;
	currentCycleNumber: number | null;
	trialStart: Date | null;
	trialEnd: Date | null;
	cancelAtPeriodEnd: boolean;
	cancelAt: Date | null;
	cancelScheduledAt: Date | null;
	canceledAt: Date | null;
	pendingPlan: string | null;
	pendingProductId: string | null;
	pendingPlanEffectiveAt: Date | null;
	/** Seat count that StreamPay will apply with the pending change, if any. */
	pendingSeats: number | null;
	pendingSeatsEffectiveAt: Date | null;
	endedAt: Date | null;
	frozenAt: Date | null;
	freezeEndAt: Date | null;
	providerUpdatedAt: Date | null;
	syncedAt: Date | null;
	createdAt: Date | null;
	updatedAt: Date | null;
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
	onSubscriptionUnfreezeScheduled?: SubscriptionCallback;
	onSubscriptionFreezeCanceled?: SubscriptionCallback;
	onSubscriptionRenewed?: SubscriptionCallback;
	onSubscriptionPaymentFailed?: SubscriptionCallback;
	onSubscriptionInactivated?: SubscriptionCallback;
	onSubscriptionCancelScheduled?: SubscriptionCallback;
	onSubscriptionPlanChangeScheduled?: SubscriptionCallback;
	onSubscriptionPlanChangeCanceled?: SubscriptionCallback;
	onSubscriptionPlanChanged?: SubscriptionCallback;
	onSubscriptionPlanChangeInvoiceReissued?: SubscriptionCallback;
	onSubscriptionPlanUpdated?: SubscriptionCallback;
}

export interface AuthorizeReferenceContext {
	user: StreamPaySessionUser;
	referenceId: string;
	referenceType: SubscriptionReferenceType;
	action:
		| "upgrade"
		| "cancel"
		| "uncancel"
		| "freeze"
		| "unfreeze"
		| "cancel-freeze"
		| "read"
		| "change-plan"
		| "update-seats"
		| "cancel-plan-change";
}

export interface TrialEligibilityContext {
	user: StreamPaySessionUser;
	referenceId: string;
	referenceType: SubscriptionReferenceType;
	plan: StreamPayPlanLike;
	previousSubscriptions: readonly Subscription[];
	/** False after a trial is recorded for the same reference and plan group. */
	defaultEligible: boolean;
}

export function subscriptionSlotKey(
	referenceType: SubscriptionReferenceType,
	referenceId: string,
	group: string | null | undefined,
): string {
	const tuple = JSON.stringify([referenceType, referenceId, group ?? null]);
	return `sp_slot_v1_${createHash("sha256").update(tuple).digest("hex")}`;
}

interface SubscriptionsOptionsBase extends SubscriptionCallbacks {
	plans: PlansInput;

	authorizeReference?: (
		data: AuthorizeReferenceContext,
		ctx: GenericEndpointContext,
	) => boolean | Promise<boolean>;

	/** StreamPay makes the final trial decision even when this overrides local eligibility. */
	isTrialEligible?: (
		data: TrialEligibilityContext,
		ctx: GenericEndpointContext,
	) => boolean | Promise<boolean>;

	maxWebhookAttempts?: number;

	/** Enabled by default, so lifecycle callbacks must tolerate repeated delivery. */
	retryOnCallbackError?: boolean;

	/** Defaults to active, trialing, frozen, and past_due; changes affect access control. */
	accessStatuses?: readonly SubscriptionStatus[];

	/** Disabling this removes persisted webhook deduplication and replay. */
	enableWebhookEventTable?: boolean;
}

export type SubscriptionsOptions = SubscriptionsOptionsBase;

export const UPGRADE_IDEMPOTENCY_WINDOW_MS = 15 * 60 * 1000;

export const PLAN_NAME_METADATA_KEY = "streampay_plugin_plan_name";
export const REFERENCE_ID_METADATA_KEY = "streampay_plugin_reference_id";
export const REFERENCE_TYPE_METADATA_KEY = "streampay_plugin_reference_type";
export const SUBSCRIPTION_ROW_ID_METADATA_KEY = "streampay_plugin_subscription_row_id";
