import { describe, expectTypeOf, it } from "vitest";
import type {
	StreamPayEntityType,
	StreamPayEventType,
	StreamPayInvoiceEventType,
	StreamPayPaymentEventType,
	StreamPayPaymentLinkEventType,
	StreamPaySubscriptionEventType,
	StreamPayWebhookPayload,
	WebhookHandler,
	WebhookHandlers,
} from "../src";

/**
 * Pure type-level assertions. Every `expectTypeOf` call is compiled
 * away — this file proves the developer-facing types narrow the way
 * the README promises, and fails the typecheck if that contract ever
 * slips.
 */
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
			expectTypeOf<AnySubscriptionEvent["event_type"]>().toEqualTypeOf<StreamPaySubscriptionEventType>();
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

		it("StreamPaySubscriptionEventType is the 11 subscription literals", () => {
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
		it("onPayload receives the wide payload", () => {
			type P = NonNullable<WebhookHandlers["onPayload"]>;
			expectTypeOf<Parameters<P>[0]>().toEqualTypeOf<StreamPayWebhookPayload>();
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
			// A PAYMENT_SUCCEEDED payload should NOT be assignable to SubPayload —
			// assignability is asserted via a parameter-contravariant handler
			// function: if the subscription-only handler accepted a payment
			// payload, this would typecheck.
			type SubHandler = (p: SubPayload) => void;
			type PaymentHandler = (p: StreamPayWebhookPayload<"PAYMENT_SUCCEEDED", "PAYMENT">) => void;
			// `SubHandler` is NOT assignable to `PaymentHandler` (the subscription
			// handler can't safely receive a payment payload).
			expectTypeOf<SubHandler>().not.toMatchTypeOf<PaymentHandler>();
		});
	});

	describe("cross-entity handler mismatches are rejected", () => {
		// These are the negative tests that protect the handler
		// narrowing contract from regressing. If `WebhookHandler`
		// ever becomes covariant in `TEvent`/`TEntity`, the positive
		// tests above still pass but users lose the type safety that
		// prevents mis-registering a payment handler as an invoice
		// handler. These assertions fail in that regression.

		it("WebhookHandlers[onPaymentSucceeded] rejects a handler typed for a different event literal", () => {
			type PaymentSucceededHandler = NonNullable<WebhookHandlers["onPaymentSucceeded"]>;
			// A handler typed for INVOICE_CREATED must NOT be assignable
			// to the onPaymentSucceeded slot.
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
			// This asserts the documented DX pattern from the README
			// actually compiles — a single handler function for every
			// subscription event, fully typed.
			const handler: WebhookHandler<StreamPaySubscriptionEventType, "SUBSCRIPTION"> = (
				payload,
			) => {
				expectTypeOf(payload.event_type).toEqualTypeOf<StreamPaySubscriptionEventType>();
				expectTypeOf(payload.entity_type).toEqualTypeOf<"SUBSCRIPTION">();
			};
			void handler;
		});
	});
});
