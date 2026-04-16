/**
 * Canonical StreamPay webhook event type list. Kept as a string union
 * rather than an enum so downstream code stays ergonomic.
 *
 * Source: https://docs.streampay.sa/webhooks
 */
export const STREAMPAY_EVENT_TYPES = [
	// Payment
	"PAYMENT_SUCCEEDED",
	"PAYMENT_FAILED",
	"PAYMENT_CANCELED",
	"PAYMENT_REFUNDED",
	"PAYMENT_MARKED_AS_PAID",
	// Invoice
	"INVOICE_CREATED",
	"INVOICE_SENT",
	"INVOICE_ACCEPTED",
	"INVOICE_REJECTED",
	"INVOICE_COMPLETED",
	"INVOICE_CANCELED",
	"INVOICE_UPDATED",
	// Subscription
	"SUBSCRIPTION_CREATED",
	"SUBSCRIPTION_ACTIVATED",
	"SUBSCRIPTION_INACTIVATED",
	"SUBSCRIPTION_CANCELED",
	"SUBSCRIPTION_FROZEN",
	"SUBSCRIPTION_CYCLE_RENEWAL_FAILED",
	"SUBSCRIPTION_CANCEL_AT_PERIOD_END",
	"SUBSCRIPTION_FREEZE_NOW",
	"SUBSCRIPTION_UNFREEZE_NOW",
	"SUBSCRIPTION_UNFREEZE_FUTURE",
	"SUBSCRIPTION_FREEZE_CANCEL",
	// Payment Link
	"PAYMENT_LINK_PAY_ATTEMPT_FAILED",
] as const;

export type StreamPayEventType = (typeof STREAMPAY_EVENT_TYPES)[number];

export type StreamPayEntityType = "PAYMENT" | "INVOICE" | "SUBSCRIPTION" | "PAYMENT_LINK";

export interface StreamPayWebhookPayload<T = Record<string, unknown>> {
	event_type: StreamPayEventType;
	entity_type: StreamPayEntityType;
	entity_id: string;
	entity_url: string;
	status: string;
	data: T;
	timestamp: string;
}
