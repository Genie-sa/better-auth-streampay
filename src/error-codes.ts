/**
 * Plugin-level error taxonomy. Collapses StreamPay's raw 63-code enum
 * into billing-focused buckets callers can branch on stably. Raw
 * non-billing codes (MFA_*, SAUDI_ID_*, ORGANIZATION_*, …) fall through
 * to UNKNOWN — they originate from flows this plugin doesn't exercise.
 *
 * Shape follows Better Auth's `defineErrorCodes` so client-side error
 * reflections match the built-in plugins.
 *
 * Raw codes: https://stream-app-service.streampay.sa/openapi.json#/components/schemas/StreamErrorCodes
 */

export interface ErrorCodeEntry<K extends string> {
	code: K;
	message: string;
	toString: () => K;
}

function defineErrorCodes<const Codes extends Record<string, string>>(
	codes: Codes,
): { [K in keyof Codes & string]: ErrorCodeEntry<K> } {
	const out = {} as { [K in keyof Codes & string]: ErrorCodeEntry<K> };
	for (const key of Object.keys(codes) as (keyof Codes & string)[]) {
		out[key] = {
			code: key,
			message: codes[key] as Codes[typeof key],
			toString: () => key,
		};
	}
	return out;
}

export const $ERROR_CODES = defineErrorCodes({
	VALIDATION_ERROR: "Request input is not valid.",
	UNAUTHORIZED: "Missing or invalid API credentials.",
	FORBIDDEN: "You do not have permission to perform this action.",
	NOT_FOUND: "The requested resource was not found.",
	CONSUMER_DUPLICATE: "A consumer with one of the provided identifiers already exists.",
	CONSUMER_HAS_ONGOING_ACTIVITY:
		"The consumer has ongoing invoices or active subscriptions and cannot be modified.",
	INVOICE_INVALID_STATE: "The invoice is in a state that forbids this action.",
	PAYMENT_DUPLICATE: "A payment with the same information already exists.",
	PAYMENT_INVALID_STATE: "The payment is in a state that forbids this action.",
	PAYMENT_ALREADY_REFUNDED: "This payment has already been refunded.",
	PAYMENT_REFUND_FAILED: "The payment processor rejected the refund.",
	PAYMENT_GATEWAY_DECLINED: "The payment was declined by the gateway.",
	PAYMENT_GATEWAY_UNAVAILABLE: "The payment gateway is temporarily unavailable. Try again later.",
	PAYMENT_METHOD_INVALID: "The supplied payment method is invalid for this flow.",
	PRODUCT_LOCKED: "The product is referenced by a finalized invoice and cannot be modified.",
	COUPON_LOCKED: "The coupon is referenced by a finalized invoice and cannot be modified.",
	SUBSCRIPTION_NOT_FOUND: "The subscription does not exist.",
	SUBSCRIPTION_PLAN_NOT_FOUND: "The requested subscription plan is not configured.",
	SUBSCRIPTION_ALREADY_ACTIVE:
		"An active subscription already exists for this plan group.",
	SUBSCRIPTION_INVALID_STATE:
		"The subscription is in a state that forbids this action.",
	SUBSCRIPTION_FREEZE_NOT_ACTIVE:
		"No active freeze period was found for this subscription.",
	SUBSCRIPTION_REFERENCE_NOT_AUTHORIZED:
		"You are not authorized to act on this subscription reference.",
	UNKNOWN: "An unexpected error occurred.",
});

export type StreamPayErrorCode = keyof typeof $ERROR_CODES;

// Raw-code → bucket map. Codes missing here fall through to the
// status-based classifier and ultimately UNKNOWN.
const RAW_CODE_MAP: Record<string, StreamPayErrorCode> = {
	// Validation
	INVALID_PARAMETERS: "VALIDATION_ERROR",

	// Permissions
	PERMISSION_FORBIDDEN: "FORBIDDEN",
	BRANCH_ACCESS_DENIED: "FORBIDDEN",
	BRANCH_NOT_FOUND: "NOT_FOUND",

	// Consumer
	DUPLICATE_CONSUMER: "CONSUMER_DUPLICATE",
	DUPLICATE_CARD_TOKEN: "CONSUMER_DUPLICATE",
	CONSUMER_HAS_ONGOING_INVOICES: "CONSUMER_HAS_ONGOING_ACTIVITY",
	CONSUMER_HAS_ONGOING_SUBSCRIPTIONS: "CONSUMER_HAS_ONGOING_ACTIVITY",

	// Invoice state
	INVOICE_FINALISED: "INVOICE_INVALID_STATE",
	INVOICE_INVALID_STATUS: "INVOICE_INVALID_STATE",
	INVOICE_CONSENT_CONSUMED: "INVOICE_INVALID_STATE",
	INVOICE_CONSENT_EXPIRED: "INVOICE_INVALID_STATE",
	INVOICE_TOTAL_MISMATCH_PAYMENT_AMOUNT_SUM: "INVOICE_INVALID_STATE",
	INVOICE_PAYMENT_COUNT_NOT_MATCHED: "INVOICE_INVALID_STATE",

	// Payment state / duplicates
	DUPLICATE_PAYMENT: "PAYMENT_DUPLICATE",
	PAYMENT_IN_PROGRESS: "PAYMENT_INVALID_STATE",
	PAYMENT_FINALIZED: "PAYMENT_INVALID_STATE",
	PAYMEND_UNPAID: "PAYMENT_INVALID_STATE", // sic — upstream typo we inherit
	INVALID_STATUS: "PAYMENT_INVALID_STATE",

	// Refund outcomes
	PAYMENT_REFUNDED_ALREADY: "PAYMENT_ALREADY_REFUNDED",
	PAYMENT_REFUNDED_FAILED: "PAYMENT_REFUND_FAILED",

	// Gateway — declined (do not auto-retry; user must take action)
	PAYMENT_GATEWAY_DECLINED: "PAYMENT_GATEWAY_DECLINED",
	INSUFFICIENT_FUNDS: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_PAYMENT_INFO_MISMATCH: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_BAD_REQUEST: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_UNAUTHORIZED: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_FORBIDDEN: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_NOT_FOUND: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_METHOD_NOT_ALLOWED: "PAYMENT_GATEWAY_DECLINED",

	// Gateway — transient (safe to retry with backoff)
	MOYASAR_TIMEOUT: "PAYMENT_GATEWAY_UNAVAILABLE",
	MOYASAR_TOO_MANY_REQUESTS: "PAYMENT_GATEWAY_UNAVAILABLE",
	MOYASAR_INTERNAL_SERVER_ERROR: "PAYMENT_GATEWAY_UNAVAILABLE",
	MOYASAR_SERVICE_UNAVAILABLE: "PAYMENT_GATEWAY_UNAVAILABLE",

	// Payment method identity
	MOYASAR_INVALID_CARD_TOKEN: "PAYMENT_METHOD_INVALID",
	MANUAL_INVOICE_CARD_ID: "PAYMENT_METHOD_INVALID",
	ONE_OFF_INVALID_PAYMENT_FLOW: "PAYMENT_METHOD_INVALID",
	ONE_OFF_CARD_ID: "PAYMENT_METHOD_INVALID",
	AUTO_INVOICE_MISSING_CARD_ID: "PAYMENT_METHOD_INVALID",
	PAYMENT_FLOW_NOT_ALLOWED: "PAYMENT_METHOD_INVALID",

	// Catalog
	PRODUCT_USED_IN_FINALIZED_INVOICE: "PRODUCT_LOCKED",
	COUPON_USED_IN_FINALIZED_INVOICE: "COUPON_LOCKED",

	// Subscription state — these fire from the upstream API when the
	// caller attempts an action the current subscription state forbids.
	SUBSCRIPTION_ALREADY_ACTIVE: "SUBSCRIPTION_ALREADY_ACTIVE",
	SUBSCRIPTION_NOT_FOUND: "SUBSCRIPTION_NOT_FOUND",
	SUBSCRIPTION_ALREADY_CANCELED: "SUBSCRIPTION_INVALID_STATE",
	SUBSCRIPTION_ALREADY_FROZEN: "SUBSCRIPTION_INVALID_STATE",
	SUBSCRIPTION_NOT_FROZEN: "SUBSCRIPTION_FREEZE_NOT_ACTIVE",
	SUBSCRIPTION_EXPIRED: "SUBSCRIPTION_INVALID_STATE",
};

/** Priority: RAW_CODE_MAP → status classifier (401/403/404/422) → UNKNOWN. */
export function mapToErrorCode(
	rawCode: string | undefined,
	status: number | undefined,
): StreamPayErrorCode {
	if (rawCode && rawCode in RAW_CODE_MAP) {
		const mapped = RAW_CODE_MAP[rawCode];
		if (mapped) return mapped;
	}
	if (status === 401) return "UNAUTHORIZED";
	if (status === 403) return "FORBIDDEN";
	if (status === 404) return "NOT_FOUND";
	if (status === 422) return "VALIDATION_ERROR";
	return "UNKNOWN";
}
