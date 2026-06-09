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
export type StreamPaySubscriptionEventType = (typeof STREAMPAY_SUBSCRIPTION_EVENT_TYPES)[number];

export const STREAMPAY_PAYMENT_LINK_EVENT_TYPES = ["PAYMENT_LINK_PAY_ATTEMPT_FAILED"] as const;
export type StreamPayPaymentLinkEventType = (typeof STREAMPAY_PAYMENT_LINK_EVENT_TYPES)[number];

export const STREAMPAY_EVENT_TYPES = [
	...STREAMPAY_PAYMENT_EVENT_TYPES,
	...STREAMPAY_INVOICE_EVENT_TYPES,
	...STREAMPAY_SUBSCRIPTION_EVENT_TYPES,
	...STREAMPAY_PAYMENT_LINK_EVENT_TYPES,
] as const;

export type StreamPayEventType = (typeof STREAMPAY_EVENT_TYPES)[number];

export type StreamPayEntityType = "PAYMENT" | "INVOICE" | "SUBSCRIPTION" | "PAYMENT_LINK";

export interface StreamPayWebhookData {
	metadata?: Record<string, unknown>;
	payment?: { id: string; url: string };
	invoice?: { id: string; url: string };
	payment_link?: { id: string; url: string };
}

interface StreamPayWebhookEnvelope<TData extends StreamPayWebhookData = StreamPayWebhookData> {
	entity_id: string;
	entity_url: string;
	status: string;
	timestamp: string;
	data: TData;
}

export type StreamPayWebhookPayload<
	TEvent extends StreamPayEventType = StreamPayEventType,
	TEntity extends StreamPayEntityType = StreamPayEntityType,
	TData extends StreamPayWebhookData = StreamPayWebhookData,
> = Extract<StreamPayWebhookPayloadVariant<TData>, { event_type: TEvent; entity_type: TEntity }>;

type StreamPayWebhookPayloadVariant<TData extends StreamPayWebhookData = StreamPayWebhookData> =
	| (StreamPayWebhookEnvelope<TData> & { event_type: "PAYMENT_SUCCEEDED"; entity_type: "PAYMENT" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "PAYMENT_FAILED"; entity_type: "PAYMENT" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "PAYMENT_CANCELED"; entity_type: "PAYMENT" })
	| (StreamPayWebhookEnvelope<TData> & { event_type: "PAYMENT_REFUNDED"; entity_type: "PAYMENT" })
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "PAYMENT_MARKED_AS_PAID";
			entity_type: "PAYMENT";
	  })
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
	| (StreamPayWebhookEnvelope<TData> & {
			event_type: "PAYMENT_LINK_PAY_ATTEMPT_FAILED";
			entity_type: "PAYMENT_LINK";
	  });
