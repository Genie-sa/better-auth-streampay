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
	STREAMPAY_CONSUMER_LINK_CONFLICT: "This StreamPay consumer is already linked to another account.",
	STREAMPAY_CONSUMER_LINK_WRITE_FAILED: "The StreamPay consumer link could not be saved.",
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
	CHECKOUT_CLIENT_FIELDS_FORBIDDEN: "Checkout fields must be resolved by the server.",
	SUBSCRIPTION_NOT_FOUND: "The subscription does not exist.",
	SUBSCRIPTION_PLAN_NOT_FOUND: "The requested subscription plan is not configured.",
	SUBSCRIPTION_ALREADY_ACTIVE: "An active subscription already exists for this plan group.",
	SUBSCRIPTION_CHECKOUT_IN_PROGRESS:
		"A subscription checkout is already being created for this plan group.",
	SUBSCRIPTION_ALREADY_CANCELED: "The subscription is already canceled.",
	SUBSCRIPTION_ALREADY_FROZEN: "The subscription is already frozen.",
	SUBSCRIPTION_EXPIRED: "The subscription has expired.",
	SUBSCRIPTION_ALREADY_SCHEDULED_CANCEL:
		"The subscription is already scheduled to cancel at period end.",
	SUBSCRIPTION_ALREADY_ON_PLAN: "The subscription is already on the requested plan.",
	SUBSCRIPTION_SEAT_COUNT_INVALID: "The requested seat count is invalid for this plan.",
	SUBSCRIPTION_SEAT_CHANGE_ALREADY_SCHEDULED:
		"A different subscription change is already scheduled.",
	SUBSCRIPTION_IMMEDIATE_CANCEL_UNSUPPORTED:
		"StreamPay does not support immediate cancellation for active subscriptions.",
	SUBSCRIPTION_PERIOD_END_CANCEL_UNSUPPORTED:
		"StreamPay only supports period-end cancellation for active subscriptions.",
	SUBSCRIPTION_PLAN_GROUP_MISMATCH:
		"Subscription plan changes must stay within the same configured plan group.",
	SUBSCRIPTION_PLAN_CHANGE_ALREADY_SCHEDULED:
		"A different plan change is already scheduled for this subscription.",
	SUBSCRIPTION_INVALID_STATE: "The subscription is in a state that forbids this action.",
	SUBSCRIPTION_FREEZE_NOT_ACTIVE: "No active freeze period was found for this subscription.",
	SUBSCRIPTION_REFERENCE_NOT_AUTHORIZED:
		"You are not authorized to act on this subscription reference.",
	WEBHOOK_REPLAY_IN_PROGRESS: "This webhook event is already being replayed.",
	UNKNOWN: "An unexpected error occurred.",
});

export type StreamPayErrorCode = keyof typeof $ERROR_CODES;

const RAW_CODE_MAP: Record<string, StreamPayErrorCode> = {
	INVALID_PARAMETERS: "VALIDATION_ERROR",

	PERMISSION_FORBIDDEN: "FORBIDDEN",
	BRANCH_ACCESS_DENIED: "FORBIDDEN",
	BRANCH_NOT_FOUND: "NOT_FOUND",

	DUPLICATE_CONSUMER: "CONSUMER_DUPLICATE",
	DUPLICATE_CARD_TOKEN: "CONSUMER_DUPLICATE",
	CONSUMER_HAS_ONGOING_INVOICES: "CONSUMER_HAS_ONGOING_ACTIVITY",
	CONSUMER_HAS_ONGOING_SUBSCRIPTIONS: "CONSUMER_HAS_ONGOING_ACTIVITY",

	INVOICE_FINALISED: "INVOICE_INVALID_STATE",
	INVOICE_INVALID_STATUS: "INVOICE_INVALID_STATE",
	INVOICE_CONSENT_CONSUMED: "INVOICE_INVALID_STATE",
	INVOICE_CONSENT_EXPIRED: "INVOICE_INVALID_STATE",
	INVOICE_TOTAL_MISMATCH_PAYMENT_AMOUNT_SUM: "INVOICE_INVALID_STATE",
	INVOICE_PAYMENT_COUNT_NOT_MATCHED: "INVOICE_INVALID_STATE",

	DUPLICATE_PAYMENT: "PAYMENT_DUPLICATE",
	PAYMENT_IN_PROGRESS: "PAYMENT_INVALID_STATE",
	PAYMENT_FINALIZED: "PAYMENT_INVALID_STATE",
	PAYMEND_UNPAID: "PAYMENT_INVALID_STATE",
	INVALID_STATUS: "PAYMENT_INVALID_STATE",

	PAYMENT_REFUNDED_ALREADY: "PAYMENT_ALREADY_REFUNDED",
	PAYMENT_REFUNDED_FAILED: "PAYMENT_REFUND_FAILED",

	PAYMENT_GATEWAY_DECLINED: "PAYMENT_GATEWAY_DECLINED",
	INSUFFICIENT_FUNDS: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_PAYMENT_INFO_MISMATCH: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_BAD_REQUEST: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_UNAUTHORIZED: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_FORBIDDEN: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_NOT_FOUND: "PAYMENT_GATEWAY_DECLINED",
	MOYASAR_METHOD_NOT_ALLOWED: "PAYMENT_GATEWAY_DECLINED",

	MOYASAR_TIMEOUT: "PAYMENT_GATEWAY_UNAVAILABLE",
	MOYASAR_TOO_MANY_REQUESTS: "PAYMENT_GATEWAY_UNAVAILABLE",
	MOYASAR_INTERNAL_SERVER_ERROR: "PAYMENT_GATEWAY_UNAVAILABLE",
	MOYASAR_SERVICE_UNAVAILABLE: "PAYMENT_GATEWAY_UNAVAILABLE",

	MOYASAR_INVALID_CARD_TOKEN: "PAYMENT_METHOD_INVALID",
	MANUAL_INVOICE_CARD_ID: "PAYMENT_METHOD_INVALID",
	ONE_OFF_INVALID_PAYMENT_FLOW: "PAYMENT_METHOD_INVALID",
	ONE_OFF_CARD_ID: "PAYMENT_METHOD_INVALID",
	AUTO_INVOICE_MISSING_CARD_ID: "PAYMENT_METHOD_INVALID",
	PAYMENT_FLOW_NOT_ALLOWED: "PAYMENT_METHOD_INVALID",

	PRODUCT_USED_IN_FINALIZED_INVOICE: "PRODUCT_LOCKED",
	COUPON_USED_IN_FINALIZED_INVOICE: "COUPON_LOCKED",

	SUBSCRIPTION_ALREADY_ACTIVE: "SUBSCRIPTION_ALREADY_ACTIVE",
	SUBSCRIPTION_NOT_FOUND: "SUBSCRIPTION_NOT_FOUND",
	SUBSCRIPTION_ALREADY_CANCELED: "SUBSCRIPTION_ALREADY_CANCELED",
	SUBSCRIPTION_ALREADY_FROZEN: "SUBSCRIPTION_ALREADY_FROZEN",
	SUBSCRIPTION_NOT_FROZEN: "SUBSCRIPTION_FREEZE_NOT_ACTIVE",
	SUBSCRIPTION_EXPIRED: "SUBSCRIPTION_EXPIRED",
};

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
