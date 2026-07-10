import { z } from "zod";

export type StreamPayEntityType = "PAYMENT" | "INVOICE" | "SUBSCRIPTION" | "PAYMENT_LINK";

export const STREAMPAY_EVENT_ENTITY_TYPES = {
	PAYMENT_SUCCEEDED: "PAYMENT",
	PAYMENT_FAILED: "PAYMENT",
	PAYMENT_CANCELED: "PAYMENT",
	PAYMENT_REFUNDED: "PAYMENT",
	PAYMENT_MARKED_AS_PAID: "PAYMENT",
	INVOICE_CREATED: "INVOICE",
	INVOICE_SENT: "INVOICE",
	INVOICE_ACCEPTED: "INVOICE",
	INVOICE_REJECTED: "INVOICE",
	INVOICE_COMPLETED: "INVOICE",
	INVOICE_CANCELED: "INVOICE",
	INVOICE_UPDATED: "INVOICE",
	SUBSCRIPTION_CREATED: "SUBSCRIPTION",
	SUBSCRIPTION_ACTIVATED: "SUBSCRIPTION",
	SUBSCRIPTION_INACTIVATED: "SUBSCRIPTION",
	SUBSCRIPTION_CANCELED: "SUBSCRIPTION",
	SUBSCRIPTION_FROZEN: "SUBSCRIPTION",
	SUBSCRIPTION_CYCLE_RENEWAL_FAILED: "SUBSCRIPTION",
	SUBSCRIPTION_CANCEL_AT_PERIOD_END: "SUBSCRIPTION",
	SUBSCRIPTION_FREEZE_NOW: "SUBSCRIPTION",
	SUBSCRIPTION_UNFREEZE_NOW: "SUBSCRIPTION",
	SUBSCRIPTION_UNFREEZE_FUTURE: "SUBSCRIPTION",
	SUBSCRIPTION_FREEZE_CANCEL: "SUBSCRIPTION",
	SUBSCRIPTION_PLAN_CHANGE_SCHEDULED: "SUBSCRIPTION",
	SUBSCRIPTION_PLAN_CHANGE_CANCELED: "SUBSCRIPTION",
	SUBSCRIPTION_PLAN_CHANGED: "SUBSCRIPTION",
	SUBSCRIPTION_PLAN_CHANGE_INVOICE_REISSUED: "SUBSCRIPTION",
	SUBSCRIPTION_PLAN_UPDATED: "SUBSCRIPTION",
	PAYMENT_LINK_PAY_ATTEMPT_FAILED: "PAYMENT_LINK",
} as const satisfies Record<string, StreamPayEntityType>;

export type StreamPayEventType = keyof typeof STREAMPAY_EVENT_ENTITY_TYPES;

type EventTypeForEntity<TEntity extends StreamPayEntityType> = {
	[TEvent in StreamPayEventType]: (typeof STREAMPAY_EVENT_ENTITY_TYPES)[TEvent] extends TEntity
		? TEvent
		: never;
}[StreamPayEventType];

export type StreamPayPaymentEventType = EventTypeForEntity<"PAYMENT">;
export type StreamPayInvoiceEventType = EventTypeForEntity<"INVOICE">;
export type StreamPaySubscriptionEventType = EventTypeForEntity<"SUBSCRIPTION">;
export type StreamPayPaymentLinkEventType = EventTypeForEntity<"PAYMENT_LINK">;

function eventTypesForEntity<TEntity extends StreamPayEntityType>(
	entityType: TEntity,
): readonly EventTypeForEntity<TEntity>[] {
	return Object.entries(STREAMPAY_EVENT_ENTITY_TYPES)
		.filter(([, entity]) => entity === entityType)
		.map(([event]) => event as EventTypeForEntity<TEntity>);
}

export const STREAMPAY_PAYMENT_EVENT_TYPES = eventTypesForEntity("PAYMENT");
export const STREAMPAY_INVOICE_EVENT_TYPES = eventTypesForEntity("INVOICE");
export const STREAMPAY_SUBSCRIPTION_EVENT_TYPES = eventTypesForEntity("SUBSCRIPTION");
export const STREAMPAY_PAYMENT_LINK_EVENT_TYPES = eventTypesForEntity("PAYMENT_LINK");
export const STREAMPAY_EVENT_TYPES = Object.keys(
	STREAMPAY_EVENT_ENTITY_TYPES,
) as StreamPayEventType[];

export interface StreamPayWebhookData {
	[key: string]: unknown;
	metadata?: Record<string, unknown>;
	payment?: { id: string; url: string };
	invoice?: { id: string; url: string };
	payment_link?: { id: string; url: string };
}

const StreamPayWebhookEnvelopeSchema = z.object({
	event_type: z.string().min(1),
	entity_type: z.string().min(1),
	entity_id: z.string().min(1),
	entity_url: z.string(),
	status: z.string(),
	timestamp: z.string().min(1),
	data: z.record(z.string(), z.unknown()),
});

export type StreamPayWebhookEnvelope<TData extends StreamPayWebhookData = StreamPayWebhookData> =
	Omit<z.infer<typeof StreamPayWebhookEnvelopeSchema>, "data"> & { data: TData };

export function isStreamPayWebhookEnvelope(value: unknown): value is StreamPayWebhookEnvelope {
	return StreamPayWebhookEnvelopeSchema.safeParse(value).success;
}

function isStreamPayEventType(value: string): value is StreamPayEventType {
	return Object.hasOwn(STREAMPAY_EVENT_ENTITY_TYPES, value);
}

export function isKnownStreamPayWebhookPayload(
	payload: StreamPayWebhookEnvelope,
): payload is StreamPayWebhookPayload {
	return (
		isStreamPayEventType(payload.event_type) &&
		payload.entity_type === STREAMPAY_EVENT_ENTITY_TYPES[payload.event_type]
	);
}

type StreamPayWebhookPayloadVariant<TData extends StreamPayWebhookData = StreamPayWebhookData> = {
	[TEvent in StreamPayEventType]: StreamPayWebhookEnvelope<TData> & {
		event_type: TEvent;
		entity_type: (typeof STREAMPAY_EVENT_ENTITY_TYPES)[TEvent];
	};
}[StreamPayEventType];

export type StreamPayWebhookPayload<
	TEvent extends StreamPayEventType = StreamPayEventType,
	TEntity extends StreamPayEntityType = StreamPayEntityType,
	TData extends StreamPayWebhookData = StreamPayWebhookData,
> = Extract<StreamPayWebhookPayloadVariant<TData>, { event_type: TEvent; entity_type: TEntity }>;
