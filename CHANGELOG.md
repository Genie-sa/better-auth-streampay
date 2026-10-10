# better-auth-streampay

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
