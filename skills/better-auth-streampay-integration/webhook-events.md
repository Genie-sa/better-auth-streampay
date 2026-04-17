# Webhook Event Catalog

Every event the `webhooks()` sub-plugin dispatches, grouped by entity, with the recommended handler shape. Scaffold only the handlers the user picked in Q9 — do not enable them all by default.

## Payload shape

```ts
interface StreamPayWebhookPayload<T = Record<string, unknown>> {
  event_type: StreamPayEventType        // e.g. "PAYMENT_SUCCEEDED"
  entity_type: "PAYMENT" | "INVOICE" | "SUBSCRIPTION" | "PAYMENT_LINK"
  entity_id: string
  entity_url: string
  status: string
  data: T                               // entity-specific fields
  timestamp: string                     // ISO 8601
}
```

Idempotency: StreamPay may redeliver. Always key on `entity_id + event_type` (or a dedupe store) before mutating state.

## Payment events

| Handler | Event | Typical action |
|---|---|---|
| `onPaymentSucceeded` | `PAYMENT_SUCCEEDED` | Provision access, mark order paid, send receipt |
| `onPaymentFailed` | `PAYMENT_FAILED` | Notify user, retry guidance |
| `onPaymentCanceled` | `PAYMENT_CANCELED` | Release reservation |
| `onPaymentRefunded` | `PAYMENT_REFUNDED` | Revoke access, issue credit |
| `onPaymentMarkedAsPaid` | `PAYMENT_MARKED_AS_PAID` | Manual-mark path (cash, bank transfer) |

## Invoice events

| Handler | Event | Typical action |
|---|---|---|
| `onInvoiceCreated` | `INVOICE_CREATED` | Persist shadow record |
| `onInvoiceSent` | `INVOICE_SENT` | Notify user invoice is live |
| `onInvoiceAccepted` | `INVOICE_ACCEPTED` | User agreed to pay |
| `onInvoiceRejected` | `INVOICE_REJECTED` | Close as lost |
| `onInvoiceCompleted` | `INVOICE_COMPLETED` | Lifecycle done |
| `onInvoiceCanceled` | `INVOICE_CANCELED` | Close, void downstream |
| `onInvoiceUpdated` | `INVOICE_UPDATED` | Sync fields |

## Subscription events

| Handler | Event | Typical action |
|---|---|---|
| `onSubscriptionCreated` | `SUBSCRIPTION_CREATED` | Initialize entitlement record |
| `onSubscriptionActivated` | `SUBSCRIPTION_ACTIVATED` | Grant access |
| `onSubscriptionInactivated` | `SUBSCRIPTION_INACTIVATED` | Revoke access |
| `onSubscriptionCanceled` | `SUBSCRIPTION_CANCELED` | Revoke at `current_period_end` |
| `onSubscriptionFrozen` | `SUBSCRIPTION_FROZEN` | Pause access |
| `onSubscriptionCycleRenewalFailed` | `SUBSCRIPTION_CYCLE_RENEWAL_FAILED` | Start dunning |
| `onSubscriptionCancelAtPeriodEnd` | `SUBSCRIPTION_CANCEL_AT_PERIOD_END` | Mark pending cancel |
| `onSubscriptionFreezeNow` | `SUBSCRIPTION_FREEZE_NOW` | Pause immediately |
| `onSubscriptionUnfreezeNow` | `SUBSCRIPTION_UNFREEZE_NOW` | Resume immediately |
| `onSubscriptionUnfreezeFuture` | `SUBSCRIPTION_UNFREEZE_FUTURE` | Scheduled resume registered |
| `onSubscriptionFreezeCancel` | `SUBSCRIPTION_FREEZE_CANCEL` | User canceled a planned freeze |

## Payment link events

| Handler | Event | Typical action |
|---|---|---|
| `onPaymentLinkPayAttemptFailed` | `PAYMENT_LINK_PAY_ATTEMPT_FAILED` | Log, watch for abuse |

## Catch-all

`onPayload` runs **before** any event-specific handler. Use it for logging and metrics, not mutations — a per-event handler expresses intent better.

```ts
onPayload: async (p) => {
  logger.info("streampay webhook", { type: p.event_type, id: p.entity_id })
}
```

## Recommended scaffold (minimum useful set)

When in doubt, scaffold these four and leave TODOs in the bodies:

```ts
webhooks({
  secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
  onPaymentSucceeded: async (p) => {
    // TODO: provision access for p.data
  },
  onPaymentRefunded: async (p) => {
    // TODO: revoke access
  },
  onSubscriptionActivated: async (p) => {
    // TODO: mark entitlement active
  },
  onSubscriptionCanceled: async (p) => {
    // TODO: revoke at period end
  },
})
```

## What NOT to put in handlers

- Heavy work (queue it; StreamPay retries on timeout)
- Non-idempotent mutations without a dedupe key
- Throws that are not transient — StreamPay will redeliver and you'll duplicate side effects
- Access to `request.headers` expecting session auth — these calls are not authenticated
