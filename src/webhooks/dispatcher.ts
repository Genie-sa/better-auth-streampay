import type {
	StreamPayEntityType,
	StreamPayEventType,
	StreamPayWebhookData,
	StreamPayWebhookPayload,
} from "./events";

/**
 * Generic webhook handler. Parameterizes on both `event_type` and
 * `entity_type` so per-event handlers (`onPaymentSucceeded`, etc.)
 * receive a payload where both discriminants are narrowed to the
 * exact literal StreamPay sent.
 *
 * The defaults keep callers that import `WebhookHandler` without
 * generics unchanged — they get the wide union, just as before.
 */
export type WebhookHandler<
	TEvent extends StreamPayEventType = StreamPayEventType,
	TEntity extends StreamPayEntityType = StreamPayEntityType,
	TData extends StreamPayWebhookData = StreamPayWebhookData,
> = (payload: StreamPayWebhookPayload<TEvent, TEntity, TData>) => Promise<void> | void;

/**
 * Every documented StreamPay webhook event maps to a handler option
 * here. `onPayload` stays wide as the catch-all audit hook; the
 * per-event handlers lock `event_type` and `entity_type` to the exact
 * StreamPay literals so `switch (payload.event_type)` narrows
 * correctly inside user code.
 */
export interface WebhookHandlers {
	/**
	 * Catch-all that runs BEFORE the specific handler for the event.
	 * Useful for audit logs, fan-out queues, dead-letter handling.
	 * Stays wide so a single `onPayload` can accept every event.
	 */
	onPayload?: WebhookHandler;

	// Payment
	onPaymentSucceeded?: WebhookHandler<"PAYMENT_SUCCEEDED", "PAYMENT">;
	onPaymentFailed?: WebhookHandler<"PAYMENT_FAILED", "PAYMENT">;
	onPaymentCanceled?: WebhookHandler<"PAYMENT_CANCELED", "PAYMENT">;
	onPaymentRefunded?: WebhookHandler<"PAYMENT_REFUNDED", "PAYMENT">;
	onPaymentMarkedAsPaid?: WebhookHandler<"PAYMENT_MARKED_AS_PAID", "PAYMENT">;

	// Invoice
	onInvoiceCreated?: WebhookHandler<"INVOICE_CREATED", "INVOICE">;
	onInvoiceSent?: WebhookHandler<"INVOICE_SENT", "INVOICE">;
	onInvoiceAccepted?: WebhookHandler<"INVOICE_ACCEPTED", "INVOICE">;
	onInvoiceRejected?: WebhookHandler<"INVOICE_REJECTED", "INVOICE">;
	onInvoiceCompleted?: WebhookHandler<"INVOICE_COMPLETED", "INVOICE">;
	onInvoiceCanceled?: WebhookHandler<"INVOICE_CANCELED", "INVOICE">;
	onInvoiceUpdated?: WebhookHandler<"INVOICE_UPDATED", "INVOICE">;

	// Subscription
	onSubscriptionCreated?: WebhookHandler<"SUBSCRIPTION_CREATED", "SUBSCRIPTION">;
	onSubscriptionActivated?: WebhookHandler<"SUBSCRIPTION_ACTIVATED", "SUBSCRIPTION">;
	onSubscriptionInactivated?: WebhookHandler<"SUBSCRIPTION_INACTIVATED", "SUBSCRIPTION">;
	onSubscriptionCanceled?: WebhookHandler<"SUBSCRIPTION_CANCELED", "SUBSCRIPTION">;
	onSubscriptionFrozen?: WebhookHandler<"SUBSCRIPTION_FROZEN", "SUBSCRIPTION">;
	onSubscriptionCycleRenewalFailed?: WebhookHandler<
		"SUBSCRIPTION_CYCLE_RENEWAL_FAILED",
		"SUBSCRIPTION"
	>;
	onSubscriptionCancelAtPeriodEnd?: WebhookHandler<
		"SUBSCRIPTION_CANCEL_AT_PERIOD_END",
		"SUBSCRIPTION"
	>;
	onSubscriptionFreezeNow?: WebhookHandler<"SUBSCRIPTION_FREEZE_NOW", "SUBSCRIPTION">;
	onSubscriptionUnfreezeNow?: WebhookHandler<"SUBSCRIPTION_UNFREEZE_NOW", "SUBSCRIPTION">;
	onSubscriptionUnfreezeFuture?: WebhookHandler<
		"SUBSCRIPTION_UNFREEZE_FUTURE",
		"SUBSCRIPTION"
	>;
	onSubscriptionFreezeCancel?: WebhookHandler<
		"SUBSCRIPTION_FREEZE_CANCEL",
		"SUBSCRIPTION"
	>;

	// Payment Link
	onPaymentLinkPayAttemptFailed?: WebhookHandler<
		"PAYMENT_LINK_PAY_ATTEMPT_FAILED",
		"PAYMENT_LINK"
	>;
}

/**
 * Fan out a webhook payload to the registered handlers. `onPayload` is
 * always invoked first so catch-all use-cases (audit logs, fan-out
 * queues) stay reliable even when a specific handler is missing.
 *
 * Dispatch is an exhaustive switch on the discriminated union of
 * webhook variants — each case narrows `event_type` AND `entity_type`
 * to the exact literals declared on the handler, so calling the
 * specific handler is structurally sound with zero type assertions.
 * The `default` branch's `never` check enforces that adding a new
 * variant to `StreamPayWebhookPayload` fails compilation until a new
 * case is added here.
 */
export async function dispatchWebhook(
	payload: StreamPayWebhookPayload,
	handlers: WebhookHandlers,
): Promise<void> {
	if (handlers.onPayload) await handlers.onPayload(payload);

	switch (payload.event_type) {
		// Payment
		case "PAYMENT_SUCCEEDED":
			await handlers.onPaymentSucceeded?.(payload);
			return;
		case "PAYMENT_FAILED":
			await handlers.onPaymentFailed?.(payload);
			return;
		case "PAYMENT_CANCELED":
			await handlers.onPaymentCanceled?.(payload);
			return;
		case "PAYMENT_REFUNDED":
			await handlers.onPaymentRefunded?.(payload);
			return;
		case "PAYMENT_MARKED_AS_PAID":
			await handlers.onPaymentMarkedAsPaid?.(payload);
			return;

		// Invoice
		case "INVOICE_CREATED":
			await handlers.onInvoiceCreated?.(payload);
			return;
		case "INVOICE_SENT":
			await handlers.onInvoiceSent?.(payload);
			return;
		case "INVOICE_ACCEPTED":
			await handlers.onInvoiceAccepted?.(payload);
			return;
		case "INVOICE_REJECTED":
			await handlers.onInvoiceRejected?.(payload);
			return;
		case "INVOICE_COMPLETED":
			await handlers.onInvoiceCompleted?.(payload);
			return;
		case "INVOICE_CANCELED":
			await handlers.onInvoiceCanceled?.(payload);
			return;
		case "INVOICE_UPDATED":
			await handlers.onInvoiceUpdated?.(payload);
			return;

		// Subscription
		case "SUBSCRIPTION_CREATED":
			await handlers.onSubscriptionCreated?.(payload);
			return;
		case "SUBSCRIPTION_ACTIVATED":
			await handlers.onSubscriptionActivated?.(payload);
			return;
		case "SUBSCRIPTION_INACTIVATED":
			await handlers.onSubscriptionInactivated?.(payload);
			return;
		case "SUBSCRIPTION_CANCELED":
			await handlers.onSubscriptionCanceled?.(payload);
			return;
		case "SUBSCRIPTION_FROZEN":
			await handlers.onSubscriptionFrozen?.(payload);
			return;
		case "SUBSCRIPTION_CYCLE_RENEWAL_FAILED":
			await handlers.onSubscriptionCycleRenewalFailed?.(payload);
			return;
		case "SUBSCRIPTION_CANCEL_AT_PERIOD_END":
			await handlers.onSubscriptionCancelAtPeriodEnd?.(payload);
			return;
		case "SUBSCRIPTION_FREEZE_NOW":
			await handlers.onSubscriptionFreezeNow?.(payload);
			return;
		case "SUBSCRIPTION_UNFREEZE_NOW":
			await handlers.onSubscriptionUnfreezeNow?.(payload);
			return;
		case "SUBSCRIPTION_UNFREEZE_FUTURE":
			await handlers.onSubscriptionUnfreezeFuture?.(payload);
			return;
		case "SUBSCRIPTION_FREEZE_CANCEL":
			await handlers.onSubscriptionFreezeCancel?.(payload);
			return;

		// Payment Link
		case "PAYMENT_LINK_PAY_ATTEMPT_FAILED":
			await handlers.onPaymentLinkPayAttemptFailed?.(payload);
			return;

		default: {
			// Exhaustiveness guard. If a new variant is added to
			// `StreamPayWebhookPayload`, `payload` here is no longer
			// `never` and this assignment fails typecheck — the
			// dispatcher stays in lockstep with the event catalog by
			// construction.
			const _exhaustive: never = payload;
			void _exhaustive;
			return;
		}
	}
}
