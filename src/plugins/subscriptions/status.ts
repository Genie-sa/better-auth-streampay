import type { SubscriptionDetailed } from "@streamsdk/typescript";

export const SUBSCRIPTION_STATUSES = [
	"incomplete",
	"incomplete_expired",
	"trial_pending",
	"trialing",
	"active",
	"inactive",
	"expired",
	"canceled",
	"frozen",
	"past_due",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type StreamPaySubscriptionStatus = NonNullable<SubscriptionDetailed["status"]>;

export const DEFAULT_ACCESS_STATUSES = ["active", "trialing", "frozen", "past_due"] as const;

const MANAGEABLE_STATUSES = new Set<SubscriptionStatus>([
	"active",
	"trial_pending",
	"trialing",
	"frozen",
	"past_due",
]);

const TERMINAL_STATUSES = new Set<SubscriptionStatus>([
	"incomplete_expired",
	"inactive",
	"expired",
	"canceled",
]);

const CHECKOUT_SUCCESS_STATUSES = new Set<StreamPaySubscriptionStatus>([
	"ACTIVE",
	"TRIALING",
	"TRIAL_PENDING",
	"FROZEN",
]);

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
		case "TRIALING":
			return "trialing";
		case "TRIAL_PENDING":
			return "trial_pending";
		default:
			return "incomplete";
	}
}

export function isManageableSubscriptionStatus(status: SubscriptionStatus): boolean {
	return MANAGEABLE_STATUSES.has(status);
}

export function isTerminalSubscriptionStatus(status: SubscriptionStatus | undefined): boolean {
	return status !== undefined && TERMINAL_STATUSES.has(status);
}

export function isCheckoutSuccessStatus(status: StreamPaySubscriptionStatus | undefined): boolean {
	return status !== undefined && CHECKOUT_SUCCESS_STATUSES.has(status);
}
