---
"better-auth-streampay": minor
---

Add first-class subscription seat billing. Upgrade and plan-change calls accept `seats`, a new
seat-update endpoint schedules quantity changes, hosted checkout quantities can be explicitly
bounded and customer-editable, and current/pending seat state is reconciled through webhooks.
Subscription updates now retain unrelated items and exposed coupon IDs.

Provider-confirmed quantities win over requested values, pending-change cancellation is
idempotent, ambiguous multi-plan provider state fails closed, and timezone-less StreamPay
timestamps are consistently interpreted as UTC.

Before deploying, generate/review the Better Auth schema migration and backfill existing
`subscription.seats` values to `1`. The plugin declares the schema but never runs DDL at runtime.
