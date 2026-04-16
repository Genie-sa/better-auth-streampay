import type { StreamPayWebhookData, StreamPayWebhookPayload } from "./events";

export type WebhookHandler<
	T extends StreamPayWebhookData = StreamPayWebhookData,
> = (payload: StreamPayWebhookPayload<T>) => Promise<void> | void;

export interface WebhookHandlers {
	onPayload?: WebhookHandler;
	// Payment
	onPaymentSucceeded?: WebhookHandler;
	onPaymentFailed?: WebhookHandler;
	onPaymentCanceled?: WebhookHandler;
	onPaymentRefunded?: WebhookHandler;
	onPaymentMarkedAsPaid?: WebhookHandler;
	// Invoice
	onInvoiceCreated?: WebhookHandler;
	onInvoiceSent?: WebhookHandler;
	onInvoiceAccepted?: WebhookHandler;
	onInvoiceRejected?: WebhookHandler;
	onInvoiceCompleted?: WebhookHandler;
	onInvoiceCanceled?: WebhookHandler;
	onInvoiceUpdated?: WebhookHandler;
	// Subscription
	onSubscriptionCreated?: WebhookHandler;
	onSubscriptionActivated?: WebhookHandler;
	onSubscriptionInactivated?: WebhookHandler;
	onSubscriptionCanceled?: WebhookHandler;
	onSubscriptionFrozen?: WebhookHandler;
	onSubscriptionCycleRenewalFailed?: WebhookHandler;
	onSubscriptionCancelAtPeriodEnd?: WebhookHandler;
	onSubscriptionFreezeNow?: WebhookHandler;
	onSubscriptionUnfreezeNow?: WebhookHandler;
	onSubscriptionUnfreezeFuture?: WebhookHandler;
	onSubscriptionFreezeCancel?: WebhookHandler;
	// Payment Link
	onPaymentLinkPayAttemptFailed?: WebhookHandler;
}

const HANDLER_BY_EVENT: Record<string, keyof WebhookHandlers> = {
	PAYMENT_SUCCEEDED: "onPaymentSucceeded",
	PAYMENT_FAILED: "onPaymentFailed",
	PAYMENT_CANCELED: "onPaymentCanceled",
	PAYMENT_REFUNDED: "onPaymentRefunded",
	PAYMENT_MARKED_AS_PAID: "onPaymentMarkedAsPaid",
	INVOICE_CREATED: "onInvoiceCreated",
	INVOICE_SENT: "onInvoiceSent",
	INVOICE_ACCEPTED: "onInvoiceAccepted",
	INVOICE_REJECTED: "onInvoiceRejected",
	INVOICE_COMPLETED: "onInvoiceCompleted",
	INVOICE_CANCELED: "onInvoiceCanceled",
	INVOICE_UPDATED: "onInvoiceUpdated",
	SUBSCRIPTION_CREATED: "onSubscriptionCreated",
	SUBSCRIPTION_ACTIVATED: "onSubscriptionActivated",
	SUBSCRIPTION_INACTIVATED: "onSubscriptionInactivated",
	SUBSCRIPTION_CANCELED: "onSubscriptionCanceled",
	SUBSCRIPTION_FROZEN: "onSubscriptionFrozen",
	SUBSCRIPTION_CYCLE_RENEWAL_FAILED: "onSubscriptionCycleRenewalFailed",
	SUBSCRIPTION_CANCEL_AT_PERIOD_END: "onSubscriptionCancelAtPeriodEnd",
	SUBSCRIPTION_FREEZE_NOW: "onSubscriptionFreezeNow",
	SUBSCRIPTION_UNFREEZE_NOW: "onSubscriptionUnfreezeNow",
	SUBSCRIPTION_UNFREEZE_FUTURE: "onSubscriptionUnfreezeFuture",
	SUBSCRIPTION_FREEZE_CANCEL: "onSubscriptionFreezeCancel",
	PAYMENT_LINK_PAY_ATTEMPT_FAILED: "onPaymentLinkPayAttemptFailed",
};

/**
 * Fan out a webhook payload to the registered handlers. `onPayload` is
 * always invoked first so "catch-all" use-cases (audit logs, fan-out
 * queues) stay reliable even when a specific handler is missing.
 */
export async function dispatchWebhook(
	payload: StreamPayWebhookPayload,
	handlers: WebhookHandlers,
): Promise<void> {
	if (handlers.onPayload) await handlers.onPayload(payload);
	const handlerKey = HANDLER_BY_EVENT[payload.event_type];
	if (!handlerKey) return;
	const handler = handlers[handlerKey];
	if (handler) await handler(payload);
}
