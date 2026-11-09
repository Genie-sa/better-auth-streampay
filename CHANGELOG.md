# better-auth-streampay

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
