---
"better-auth-streampay": minor
---

Keep lifecycle effects of webhooks that arrive after a newer StreamPay write, and stop other writers
from absorbing renewal callbacks.

Migration: add the nullable `subscription.renewedCycleNumber` integer column before deploying (see
the integration guide). Existing rows need no backfill.

- A retried or reordered event still runs its callback and timestamps when the current StreamPay
  state confirms it. Before, a retried `SUBSCRIPTION_ACTIVATED` was dropped once any later change
  (for example a period-end cancellation) reached the row, so `onSubscriptionActivated` never ran.
- `onSubscriptionRenewed` fires once per StreamPay cycle even when a plan-change webhook or a
  customer action wrote the new cycle before the renewal evidence arrived.
- A late `SUBSCRIPTION_CANCEL_AT_PERIOD_END` stamps `cancelScheduledAt` when another event recorded
  the schedule first.
- A late `INVOICE_COMPLETED` for the subscription's latest invoice clears `past_due`.
- Renewal evidence that revives a canceled, expired, or inactive subscription takes its billing slot
  back, and dead-letters for review when another live subscription holds it.
- A pending inbox event without a replayable payload no longer blocks
  `processDueStreampayWebhookEvents`, and a redelivery stores the payload it carries.
- Overlapping `processDueStreampayWebhookEvents` runs no longer retry an event before its backoff or
  automatically replay a dead letter. `WebhookReplayOptions.dueAttemptCount` carries the selected
  attempt.
- A customer action that observes a revived subscription takes its free billing slot, and no longer
  writes it live while another subscription holds that slot.
- Two concurrent first deliveries for a subscription without a matching reservation no longer
  dead-letter `SUBSCRIPTION_ACTIVATED`; the second retries.
- A late `SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY` clears `past_due` and delivers its renewal when
  the latest invoice is completed.
- A same-plan upgrade after the 15-minute window starts a new checkout instead of resuming the old
  link, and a link that is `INACTIVE` at StreamPay is never resumed.
- Admin discard returns 409 while a worker holds the event's processing lease.
- A dead-lettered event keeps its stored payload when the final delivery has no body.
