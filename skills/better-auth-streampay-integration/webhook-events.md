# Webhook events

The events StreamPay sends and how to handle them. The full handler
type list lives in `dist/index.d.ts` (`WebhookHandlers`) and the event
constants are in `STREAMPAY_*_EVENT_TYPES` — that's the contract.

Scaffold only the handlers the user picked. Don't enable everything
"just in case" — fewer handlers means clearer logs.

## Payload shape

```ts
interface StreamPayWebhookPayload<T = unknown> {
  event_type: StreamPayEventType   // e.g. "PAYMENT_SUCCEEDED"
  entity_type: "PAYMENT" | "INVOICE" | "SUBSCRIPTION" | "PAYMENT_LINK"
  entity_id: string
  entity_url: string
  status: string
  data: T
  timestamp: string                // ISO 8601
}
```

A friendly tip to share with the user: StreamPay may redeliver an
event (after a timeout, after a transient error). Make sure each
handler is safe to run more than once on the same event. With
`subscriptions()` enabled, the plugin handles dedup for you via the
`streampayWebhookEvent` table. Without it, key on `entity_id +
event_type` in your own handler.

## Handler keys

`webhooks()` accepts handlers named after each event:

- **Payments**: `onPaymentSucceeded`, `onPaymentFailed`, `onPaymentCanceled`, `onPaymentRefunded`, `onPaymentMarkedAsPaid`
- **Invoices**: `onInvoiceCreated`, `onInvoiceSent`, `onInvoiceAccepted`, `onInvoiceRejected`, `onInvoiceCompleted`, `onInvoiceCanceled`, `onInvoiceUpdated`
- **Subscriptions**: `onSubscriptionCreated`, `onSubscriptionActivated`, `onSubscriptionInactivated`, `onSubscriptionCanceled`, `onSubscriptionFrozen`, `onSubscriptionCycleRenewalFailed`, `onSubscriptionCancelAtPeriodEnd`, `onSubscriptionFreezeNow`, `onSubscriptionUnfreezeNow`, `onSubscriptionUnfreezeFuture`, `onSubscriptionFreezeCancel`
- **Payment links**: `onPaymentLinkPayAttemptFailed`
- **Catch-all**: `onPayload` — runs before any per-event handler

When in doubt, scaffold these four with TODO bodies:

```ts
onPaymentSucceeded:    async (p) => { /* TODO: provision access */ },
onPaymentRefunded:     async (p) => { /* TODO: revoke access */ },
onSubscriptionActivated: async (p) => { /* TODO: mark entitlement active */ },
onSubscriptionCanceled:  async (p) => { /* TODO: revoke at period end */ },
```

## When `subscriptions()` is on

The subscriptions plugin reacts to these events itself. It syncs the
local `subscription` table, then calls the user-defined callbacks
that live on `subscriptions({ on... })` (`onSubscriptionActivated`,
etc.).

The `webhooks({ on... })` callbacks fire on the same events but
BEFORE the local sync. Use them for things like analytics; use the
`subscriptions({ on... })` callbacks for entitlement logic that needs
to read from the synced row.

## Rules of thumb to share with the user

- Keep handlers fast. If you're doing heavy work, queue it — StreamPay retries on timeout.
- Be idempotent. Even if you return 200, you might still get a redelivery on a network glitch.
- Don't try to read session/headers in a webhook — these calls aren't authenticated.
- A throw becomes a redelivery. If you have a transient error, log and 200 if you can, throw if you genuinely want StreamPay to retry.
