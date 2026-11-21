# better-auth-streampay

## 3.4.0

### Minor Changes

- 3abf804: Consolidate the webhook inbox, checkout reservations, subscription projection writes, and consumer links into one module each, and fix the defects that the duplicated copies had drifted into.

  - Replaying a leftover `handlers:` inbox event with `webhooks({ deduplicate })` turned off no longer marks it completed without running any handler. Replay is routed by the event ID prefix; the event stays pending with `lastErrorCode: "WEBHOOK_INBOX_SCOPE_DISABLED"` and leaves the due queue until a StreamPay redelivery or an admin replay after re-enabling the scope.
  - New `webhooks({ maxWebhookAttempts })` sets how many deliveries a generic handler event gets before it is dead-lettered (default 5). Before, generic handlers always used 5.
  - Cancel, uncancel, freeze, unfreeze, freeze cancel, and the admin subscription endpoints now refresh `pendingPlan`, `pendingSeats`, `catalogMapped`, and the other plan fields from StreamPay. A provider snapshot without `items` no longer clears the plan mapping, and those customer actions no longer fail while a function-backed `plans` catalog is temporarily unavailable.
  - The consumer link is claimed only while the user is still unlinked, so a concurrent request can neither overwrite a stored link nor roll it back. A consumer created by a request that lost the claim is deleted. A session issued before the link was stored uses the stored link instead of provisioning again. The link is written directly instead of through `internalAdapter.updateUser`, so Better Auth `user.update` database hooks no longer fire for it, and an app that reads `session.user.streampayConsumerId` from a cached session sees the link once that session refreshes. The plugin itself always reads the stored link.
  - Replacing a stale checkout reservation fails with `SUBSCRIPTION_CHECKOUT_IN_PROGRESS` when a payment link was attached concurrently, instead of releasing a reservation whose link was still payable.
  - Renewal writes also check the subscription and consumer IDs, so a renewal never applies to a row that was rebound concurrently.
  - Discarding a renewal event still releases its callback lock after `subscriptions({ enableWebhookEventTable: false })` turns subscription deduplication off.
  - A failed `onSubscriptionRenewed` callback records `lastErrorCode: "SUBSCRIPTION_RENEWAL_CALLBACK_FAILED"`. Rows recorded by earlier versions are still recognized.

  `StreamPayPluginRegistry` gains the optional `webhookInbox` and `refreshSubscriptionProjection` members; `replayWebhookHandler` is deprecated in favor of `replayWebhookEvent`, which replays any inbox event.

## 3.3.1

### Patch Changes

- f650f28: Renewal evidence (`INVOICE_COMPLETED`, `SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY`) for a subscription
  that is not linked yet now links the checkout reservation that owns its StreamPay payment link,
  using the link's signed metadata. Before, if the creation webhooks failed or were delayed, renewal
  events completed without effect: the paid checkout stayed `incomplete` and `onSubscriptionRenewed`
  never ran. A subscription first linked after it already renewed reports that renewal once.

## 3.3.0

### Minor Changes

- 7fecc22: Keep lifecycle effects of webhooks that arrive after a newer StreamPay write, and stop other writers
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
  - Admin discard returns 409 while a worker holds or acquires the event's processing lease.
  - A dead-lettered event keeps its stored payload when the final delivery has no body.
  - Two concurrent redeliveries of the same attempt no longer both run it.
  - A same-plan upgrade replaces a concurrent reservation whose checkout link is already gone instead
    of returning `SUBSCRIPTION_CHECKOUT_IN_PROGRESS`.
  - A customer action that observes a subscription moved to another plan group moves its billing slot.
  - Replacing a stale reservation no longer releases it after its checkout link was saved concurrently.
  - A renewal callback lock left behind by a completed (for example discarded) event is released by
    the next renewal event instead of blocking renewals.

## 3.2.0

### Minor Changes

- 67f5f76: A failed admin webhook replay no longer dead-letters an event that was still pending. Before, the
  event was skipped on every later StreamPay redelivery and by `processDueStreampayWebhookEvents()`,
  so a transient outage during a replay lost it. Replays now dead-letter only events that were already
  dead-lettered, failed permanently, or exhausted their attempts, and they honor
  `retryOnCallbackError`. The `retryUntilExhausted` replay option now has no effect and is deprecated.

### Patch Changes

- 3ff9310: A customer who paid an abandoned subscription checkout after starting a replacement checkout no
  longer ends up without access. Replacing an expired reservation now deactivates its StreamPay
  payment link first, and a paid subscription takes its billing slot from an unpaid reservation.
  That reservation's link is deactivated too; if StreamPay rejects it, the error is logged for manual
  follow-up and the paid subscription is still activated. Before, every webhook delivery failed on the `activeSlotKey`
  unique constraint until the event dead-lettered. Two live subscriptions in one slot now dead-letter
  immediately as a correlation failure, and upgrades return `SUBSCRIPTION_ALREADY_ACTIVE` instead of
  a database error when a live subscription takes the slot concurrently.

  Add `docs/state-machines.md`, which documents every plugin state machine and its invariants.

## 3.1.0

### Minor Changes

- 0344580: Recover stuck webhook inbox events. A delivery that arrives while another worker holds the processing lease now returns `503` so StreamPay redelivers it, instead of `200` with no processing. The new server-only `auth.api.processDueStreampayWebhookEvents()` retries pending events whose `nextAttemptAt` has passed and reclaims abandoned leases, dead-lettering only after the attempt budget is spent. Run it on a schedule.

## 3.0.2

### Patch Changes

- 83d9ffb: Recover lazy consumer provisioning after a network or server failure by searching the auth user's exact external ID and enforcing the existing local ownership checks, without repeating the create request. Preserve provider validation, rate-limit, and unresolved duplicate-consumer statuses (422, 429, 409) instead of always returning a generic 500, and include provider status, code, and request ID in the existing error log.

## 3.0.1

### Patch Changes

- aa092ef: Reject eager consumer recovery when another local account owns the consumer. Secure the unique
  local claim before updating StreamPay's external ID during lazy recovery, and release failed
  claims without erasing a replacement link. Check current database links before using cached
  session consumer IDs in checkout, subscription creation, and portal requests. Clear missing
  consumer links conditionally so concurrent relinking survives.

  Simplify the README and move detailed examples into the integration guide.

## 3.0.0

### Major Changes

- 7bd4852: Add authenticated hosted customer portal sessions, consumer-owned pagination, durable generic
  webhook deduplication/replay, and typed partial-refund and successful-renewal handlers. Preserve
  verified payloads before processing, reject invalid usage counts, and deny access for unmapped
  provider products. A conditional database update prevents concurrent invoice and subscription
  events from invoking the renewal callback twice for the same cycle. Inbox conflicts without a
  visible row now retry instead of processing untracked callbacks. Persist the renewal callback
  owner with the cycle update so replay recovers interrupted callbacks. Reject payment-link and
  consumer mismatches when correlating checkout reservations. Explicitly map the no-argument
  portal client call to POST.
  Follow paginated consumer searches before creating a new consumer, and fence checkout cleanup
  so a late provider failure cannot expire or delete a confirmed subscription.
  Translate pagination to the current API's limit parameter and prevent stale lifecycle responses
  from overwriting newer subscription state.
  Dead-letter exhausted generic callbacks on the final permitted failure.

  Require Better Auth 1.6.0 or later: 1.5's built-in SQL adapter compares NULL with equals, breaking
  ungrouped billing reads and replay claims. Apply and explicitly backfill catalogMapped before
  deployment; older migration generators omit static defaults. Add nullable renewalCallbackEventId
  before deploying. Apply the inbox migration before
  enabling generic callback deduplication.

  Preserve consumed trial history and guard endpoint projections against concurrent webhook updates.
  Handle active freeze windows and incomplete freeze pagination without false success. Accept RFC3339
  offsets and reject unsafe integers and non-finite checkout metadata under both supported Zod majors.
  Protect consumer identity from callback overrides, condition admin consumer deletion on its current
  local owner, and safely decode discarded webhook IDs. Map server-resolved checkout to POST.
  Register all supported events in the staging demo and accept checkout redirect query parameters.

  Add an optional paginated freeze-history REST adapter for SDK 1.1.3. Cancellation and unfreeze
  search later pages with progress checks and a bounded page count; configure the adapter to
  resolve freezes beyond the SDK's first page.

## 2.2.1

### Patch Changes

- 7f6e154: Resolve subscription plans directly on every lookup so function-backed catalogs stay current without restarting the process.

## 2.2.0

### Minor Changes

- 33356bb: Add first-class subscription seat billing. Upgrade and plan-change calls accept `seats`, a new
  seat-update endpoint schedules quantity changes, hosted checkout quantities can be explicitly
  bounded and customer-editable, and current/pending seat state is reconciled through webhooks.
  Subscription updates now retain unrelated items and exposed coupon IDs.

  Provider-confirmed quantities win over requested values, pending-change cancellation is
  idempotent, ambiguous multi-plan provider state fails closed, and timezone-less StreamPay
  timestamps are consistently interpreted as UTC.

  Before deploying, generate/review the Better Auth schema migration and backfill existing
  `subscription.seats` values to `1`. The plugin declares the schema but never runs DDL at runtime.

## 2.1.0

### Minor Changes

- 6b30253: Add server-authoritative checkout resolution, post-create persistence with payment-link
  compensation, and fail-closed unique consumer linking.

  Existing databases must add the generated unique index for `streampayConsumerId`; resolve duplicate
  non-null values before applying that migration.

  Consumer ownership conflicts and database failures now fail closed anywhere lazy consumer
  provisioning runs, including checkout, portal, and subscriptions.

## 2.0.0

### Major Changes

- 66bcc4a: Update subscriptions for StreamPay SDK 1.1.3.

  - Change plans on the same subscription.
  - Cancel a pending plan change or period-end cancellation.
  - Support trials, freezes, plan groups, and app-owned billing references.
  - Store subscription billing and lifecycle state and prevent duplicate active checkouts.
  - Check, retry, and replay subscription webhooks.
  - Add typed handlers for all documented StreamPay subscription events.

  This release needs Better Auth `^1.5.0` and changes the subscription tables. Generate and run the
  database changes before starting the app. Node.js `20.19.0` or newer is required.
