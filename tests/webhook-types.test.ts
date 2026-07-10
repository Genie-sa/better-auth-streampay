import { describe, expectTypeOf, it } from "vitest";
import type {
	StreamPayEntityType,
	StreamPayEventType,
	StreamPayInvoiceEventType,
	StreamPayPaymentEventType,
	StreamPayPaymentLinkEventType,
	StreamPaySubscriptionEventType,
	StreamPayWebhookEnvelope,
	StreamPayWebhookPayload,
	WebhookHandler,
	WebhookHandlers,
} from "../src";

describe("webhook type narrowing", () => {
	describe("StreamPayWebhookPayload generics", () => {
		it("defaults to the wide unions on event_type and entity_type", () => {
			expectTypeOf<StreamPayWebhookPayload["event_type"]>().toEqualTypeOf<StreamPayEventType>();
			expectTypeOf<StreamPayWebhookPayload["entity_type"]>().toEqualTypeOf<StreamPayEntityType>();
		});

		it("narrows to a single literal when both params are pinned", () => {
			type PaymentSucceeded = StreamPayWebhookPayload<"PAYMENT_SUCCEEDED", "PAYMENT">;
			expectTypeOf<PaymentSucceeded["event_type"]>().toEqualTypeOf<"PAYMENT_SUCCEEDED">();
			expectTypeOf<PaymentSucceeded["entity_type"]>().toEqualTypeOf<"PAYMENT">();
		});

		it("narrows to a per-entity union when parameterized by subtype", () => {
			type AnySubscriptionEvent = StreamPayWebhookPayload<
				StreamPaySubscriptionEventType,
				"SUBSCRIPTION"
			>;
			expectTypeOf<
				AnySubscriptionEvent["event_type"]
			>().toEqualTypeOf<StreamPaySubscriptionEventType>();
			expectTypeOf<AnySubscriptionEvent["entity_type"]>().toEqualTypeOf<"SUBSCRIPTION">();
		});
	});

	describe("per-entity event subtype unions", () => {
		it("StreamPayPaymentEventType is the 5 payment literals", () => {
			expectTypeOf<StreamPayPaymentEventType>().toEqualTypeOf<
				| "PAYMENT_SUCCEEDED"
				| "PAYMENT_FAILED"
				| "PAYMENT_CANCELED"
				| "PAYMENT_REFUNDED"
				| "PAYMENT_MARKED_AS_PAID"
			>();
		});

		it("StreamPayInvoiceEventType is the 7 invoice literals", () => {
			expectTypeOf<StreamPayInvoiceEventType>().toEqualTypeOf<
				| "INVOICE_CREATED"
				| "INVOICE_SENT"
				| "INVOICE_ACCEPTED"
				| "INVOICE_REJECTED"
				| "INVOICE_COMPLETED"
				| "INVOICE_CANCELED"
				| "INVOICE_UPDATED"
			>();
		});

		it("StreamPaySubscriptionEventType covers every documented subscription event", () => {
			expectTypeOf<StreamPaySubscriptionEventType>().toEqualTypeOf<
				| "SUBSCRIPTION_CREATED"
				| "SUBSCRIPTION_ACTIVATED"
				| "SUBSCRIPTION_INACTIVATED"
				| "SUBSCRIPTION_CANCELED"
				| "SUBSCRIPTION_FROZEN"
				| "SUBSCRIPTION_CYCLE_RENEWAL_FAILED"
				| "SUBSCRIPTION_CANCEL_AT_PERIOD_END"
				| "SUBSCRIPTION_FREEZE_NOW"
				| "SUBSCRIPTION_UNFREEZE_NOW"
				| "SUBSCRIPTION_UNFREEZE_FUTURE"
				| "SUBSCRIPTION_FREEZE_CANCEL"
				| "SUBSCRIPTION_PLAN_CHANGE_SCHEDULED"
				| "SUBSCRIPTION_PLAN_CHANGE_CANCELED"
				| "SUBSCRIPTION_PLAN_CHANGED"
				| "SUBSCRIPTION_PLAN_CHANGE_INVOICE_REISSUED"
				| "SUBSCRIPTION_PLAN_UPDATED"
			>();
		});

		it("StreamPayPaymentLinkEventType is the single payment-link literal", () => {
			expectTypeOf<StreamPayPaymentLinkEventType>().toEqualTypeOf<"PAYMENT_LINK_PAY_ATTEMPT_FAILED">();
		});

		it("StreamPayEventType is the union of all four per-entity subtypes", () => {
			expectTypeOf<StreamPayEventType>().toEqualTypeOf<
				| StreamPayPaymentEventType
				| StreamPayInvoiceEventType
				| StreamPaySubscriptionEventType
				| StreamPayPaymentLinkEventType
			>();
		});
	});

	describe("WebhookHandlers field narrowing", () => {
		it("onPayload receives the future-compatible validated envelope", () => {
			type P = NonNullable<WebhookHandlers["onPayload"]>;
			expectTypeOf<Parameters<P>[0]>().toEqualTypeOf<StreamPayWebhookEnvelope>();
		});

		it("onPaymentSucceeded pins event_type and entity_type to payment literals", () => {
			type H = NonNullable<WebhookHandlers["onPaymentSucceeded"]>;
			type Payload = Parameters<H>[0];
			expectTypeOf<Payload["event_type"]>().toEqualTypeOf<"PAYMENT_SUCCEEDED">();
			expectTypeOf<Payload["entity_type"]>().toEqualTypeOf<"PAYMENT">();
		});

		it("onSubscriptionFrozen pins both discriminants", () => {
			type H = NonNullable<WebhookHandlers["onSubscriptionFrozen"]>;
			type Payload = Parameters<H>[0];
			expectTypeOf<Payload["event_type"]>().toEqualTypeOf<"SUBSCRIPTION_FROZEN">();
			expectTypeOf<Payload["entity_type"]>().toEqualTypeOf<"SUBSCRIPTION">();
		});
	});

	describe("shared-handler pattern", () => {
		it("a payload typed as StreamPayWebhookPayload<SubscriptionEventType, 'SUBSCRIPTION'> only accepts subscription events", () => {
			type SubPayload = StreamPayWebhookPayload<StreamPaySubscriptionEventType, "SUBSCRIPTION">;
			type SubHandler = (p: SubPayload) => void;
			type PaymentHandler = (p: StreamPayWebhookPayload<"PAYMENT_SUCCEEDED", "PAYMENT">) => void;
			expectTypeOf<SubHandler>().not.toMatchTypeOf<PaymentHandler>();
		});
	});

	describe("cross-entity handler mismatches are rejected", () => {
		it("WebhookHandlers[onPaymentSucceeded] rejects a handler typed for a different event literal", () => {
			type PaymentSucceededHandler = NonNullable<WebhookHandlers["onPaymentSucceeded"]>;
			type InvoiceCreatedHandler = (
				payload: StreamPayWebhookPayload<"INVOICE_CREATED", "INVOICE">,
			) => void;
			expectTypeOf<InvoiceCreatedHandler>().not.toMatchTypeOf<PaymentSucceededHandler>();
		});
	});

	describe("WebhookHandler default parameterization", () => {
		it("bare WebhookHandler accepts the wide payload (backwards compatible)", () => {
			expectTypeOf<Parameters<WebhookHandler>[0]>().toEqualTypeOf<StreamPayWebhookPayload>();
		});

		it("a user-defined shared-handler can be typed with the per-entity union", () => {
			const handler: WebhookHandler<StreamPaySubscriptionEventType, "SUBSCRIPTION"> = (payload) => {
				expectTypeOf(payload.event_type).toEqualTypeOf<StreamPaySubscriptionEventType>();
				expectTypeOf(payload.entity_type).toEqualTypeOf<"SUBSCRIPTION">();
			};
			void handler;
		});
	});
});
