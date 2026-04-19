/**
 * Canonical StreamPay webhook event lists, grouped by the entity that
 * emits them. Kept as string-literal tuples (rather than enums) so
 * downstream code stays ergonomic and the per-group unions below
 * derive for free.
 *
 * Source: https://docs.streampay.sa/webhooks
 */

export const STREAMPAY_PAYMENT_EVENT_TYPES = [
	"PAYMENT_SUCCEEDED",
	"PAYMENT_FAILED",
	"PAYMENT_CANCELED",
	"PAYMENT_REFUNDED",
	"PAYMENT_MARKED_AS_PAID",
] as const;
export type StreamPayPaymentEventType = (typeof STREAMPAY_PAYMENT_EVENT_TYPES)[number];

export const STREAMPAY_INVOICE_EVENT_TYPES = [
	"INVOICE_CREATED",
	"INVOICE_SENT",
	"INVOICE_ACCEPTED",
	"INVOICE_REJECTED",
	"INVOICE_COMPLETED",
	"INVOICE_CANCELED",
	"INVOICE_UPDATED",
] as const;
export type StreamPayInvoiceEventType = (typeof STREAMPAY_INVOICE_EVENT_TYPES)[number];

export const STREAMPAY_SUBSCRIPTION_EVENT_TYPES = [
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
] as const;
export type StreamPaySubscriptionEventType =
	(typeof STREAMPAY_SUBSCRIPTION_EVENT_TYPES)[number];

export const STREAMPAY_PAYMENT_LINK_EVENT_TYPES = [
	"PAYMENT_LINK_PAY_ATTEMPT_FAILED",
] as const;
export type StreamPayPaymentLinkEventType =
	(typeof STREAMPAY_PAYMENT_LINK_EVENT_TYPES)[number];

/**
 * All documented StreamPay event types. Preserved as a single runtime
 * array for callers that need exhaustive iteration (catch-all audits,
 * schema generation). Derived from the four per-entity lists so adding
 * a new event requires touching exactly one group.
 */
export const STREAMPAY_EVENT_TYPES = [
	...STREAMPAY_PAYMENT_EVENT_TYPES,
	...STREAMPAY_INVOICE_EVENT_TYPES,
	...STREAMPAY_SUBSCRIPTION_EVENT_TYPES,
	...STREAMPAY_PAYMENT_LINK_EVENT_TYPES,
] as const;

export type StreamPayEventType = (typeof STREAMPAY_EVENT_TYPES)[number];

export type StreamPayEntityType = "PAYMENT" | "INVOICE" | "SUBSCRIPTION" | "PAYMENT_LINK";

/**
 * Shape of the `data` field on a webhook payload. Every entity pointer
 * is optional because StreamPay's single documented example shows
 * multiple entity keys populated at once (a payment made via a
 * payment-link against an invoice carries all three). Do not infer
 * "`PAYMENT` events guarantee `data.payment`" from this — the docs
 * don't guarantee it, and runtime data may omit any of the fields.
 */
export interface StreamPayWebhookData {
	metadata?: Record<string, unknown>;
	payment?: { id: string; url: string };
	invoice?: { id: string; url: string };
	payment_link?: { id: string; url: string };
}

/**
 * Envelope fields shared by every StreamPay webhook, regardless of the
 * event_type/entity_type pair. The per-event variants intersect this
 * with their specific discriminants to form the full discriminated
 * union below.
 */
interface StreamPayWebhookEnvelope<TData extends StreamPayWebhookData = StreamPayWebhookData> {
	entity_id: string;
	entity_url: string;
	status: string;
	timestamp: string;
	data: TData;
}

/**
 * Discriminated union of every documented StreamPay webhook variant.
 * Keying on `event_type` narrows both `event_type` AND `entity_type`
 * through the switch, so the dispatcher can call the specific handler
 * with zero type assertions.
 *
 * Organized by entity for maintainability — adding an event to
 * StreamPay requires appending one variant to the right group.
 */
export type StreamPayWebhookPayload<
	TEvent extends StreamPayEventType = StreamPayEventType,
	TEntity extends StreamPayEntityType = StreamPayEntityType,
	TData extends StreamPayWebhookData = StreamPayWebhookData,
> = Extract<
	StreamPayWebhookPayloadVariant<TData>,
	{ event_type: TEvent; entity_type: TEntity }
>;

/**
 * Internal variant union. `StreamPayWebhookPayload` is the public
 * surface — it routes through `Extract` so callers get either the full
 * union (defaults) or a narrowed variant.
 */
type StreamPayWebhookPayloadVariant<
	TData extends StreamPayWebhookData = StreamPayWebhookData,
> =
	// Payment
	| (StreamPayWebhookEnvelope<TData> & { event_type: "PAYMENT_SUCCEEDED"; entity_type: "PAYMENT" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "PAYMENT_FAILED"; entity_type: "PAYMENT" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "PAYMENT_CANCELED"; entity_type: "PAYMENT" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "PAYMENT_REFUNDED"; entity_type: "PAYMENT" })
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "PAYMENT_MARKED_AS_PAID";
			entity_type: "PAYMENT";
		})
	// Invoice
	| (StreamPayWebhookEnvelope<TData> & { event_type: "INVOICE_CREATED"; entity_type: "INVOICE" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "INVOICE_SENT"; entity_type: "INVOICE" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "INVOICE_ACCEPTED"; entity_type: "INVOICE" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "INVOICE_REJECTED"; entity_type: "INVOICE" })
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "INVOICE_COMPLETED";
			entity_type: "INVOICE";
		})
	| (StreamPayWebhookEnvelope<TData> & { event_type: "INVOICE_CANCELED"; entity_type: "INVOICE" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "INVOICE_UPDATED"; entity_type: "INVOICE" })
	// Subscription
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_CREATED";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_ACTIVATED";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_INACTIVATED";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_CANCELED";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_FROZEN";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_CYCLE_RENEWAL_FAILED";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_CANCEL_AT_PERIOD_END";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_FREEZE_NOW";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_UNFREEZE_NOW";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_UNFREEZE_FUTURE";
			entity_type: "SUBSCRIPTION";
		})
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "SUBSCRIPTION_FREEZE_CANCEL";
			entity_type: "SUBSCRIPTION";
		})
	// Payment Link
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "PAYMENT_LINK_PAY_ATTEMPT_FAILED";
			entity_type: "PAYMENT_LINK";
		});
