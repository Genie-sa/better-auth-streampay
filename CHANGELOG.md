# better-auth-streampay

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
