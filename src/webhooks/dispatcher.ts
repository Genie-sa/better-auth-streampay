import type {
	StreamPayEntityType,
	StreamPayEventType,
	StreamPayWebhookData,
	StreamPayWebhookPayload,
} from "./events";

export type WebhookHandler<
	TEvent extends StreamPayEventType = StreamPayEventType,
	TEntity extends StreamPayEntityType = StreamPayEntityType,
	TData extends StreamPayWebhookData = StreamPayWebhookData,
> = (payload: StreamPayWebhookPayload<TEvent, TEntity, TData>) => Promise<void> | void;

export interface WebhookHandlers {
	onPayload?: WebhookHandler;

	onPaymentSucceeded?: WebhookHandler<"PAYMENT_SUCCEEDED", "PAYMENT">;
	onPaymentFailed?: WebhookHandler<"PAYMENT_FAILED", "PAYMENT">;
	onPaymentCanceled?: WebhookHandler<"PAYMENT_CANCELED", "PAYMENT">;
	onPaymentRefunded?: WebhookHandler<"PAYMENT_REFUNDED", "PAYMENT">;
	onPaymentMarkedAsPaid?: WebhookHandler<"PAYMENT_MARKED_AS_PAID", "PAYMENT">;

	onInvoiceCreated?: WebhookHandler<"INVOICE_CREATED", "INVOICE">;
	onInvoiceSent?: WebhookHandler<"INVOICE_SENT", "INVOICE">;
	onInvoiceAccepted?: WebhookHandler<"INVOICE_ACCEPTED", "INVOICE">;
	onInvoiceRejected?: WebhookHandler<"INVOICE_REJECTED", "INVOICE">;
	onInvoiceCompleted?: WebhookHandler<"INVOICE_COMPLETED", "INVOICE">;
	onInvoiceCanceled?: WebhookHandler<"INVOICE_CANCELED", "INVOICE">;
	onInvoiceUpdated?: WebhookHandler<"INVOICE_UPDATED", "INVOICE">;

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
	onSubscriptionUnfreezeFuture?: WebhookHandler<"SUBSCRIPTION_UNFREEZE_FUTURE", "SUBSCRIPTION">;
	onSubscriptionFreezeCancel?: WebhookHandler<"SUBSCRIPTION_FREEZE_CANCEL", "SUBSCRIPTION">;

	onPaymentLinkPayAttemptFailed?: WebhookHandler<"PAYMENT_LINK_PAY_ATTEMPT_FAILED", "PAYMENT_LINK">;
}

export async function dispatchWebhook(
	payload: StreamPayWebhookPayload,
	handlers: WebhookHandlers,
): Promise<void> {
	if (handlers.onPayload) await handlers.onPayload(payload);

	switch (payload.event_type) {
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

		case "PAYMENT_LINK_PAY_ATTEMPT_FAILED":
			await handlers.onPaymentLinkPayAttemptFailed?.(payload);
			return;

		default: {
			const _exhaustive: never = payload;
			void _exhaustive;
			return;
		}
	}
}
