---
"better-auth-streampay": patch
---

A customer who paid an abandoned subscription checkout after starting a replacement checkout no
longer ends up without access. Replacing an expired reservation now deactivates its StreamPay
payment link first, and a paid subscription takes its billing slot from an unpaid reservation.
That reservation's link is deactivated too; if StreamPay rejects it, the error is logged for manual
follow-up and the paid subscription is still activated. Before, every webhook delivery failed on the `activeSlotKey`
unique constraint until the event dead-lettered. Two live subscriptions in one slot now dead-letter
immediately as a correlation failure, and upgrades return `SUBSCRIPTION_ALREADY_ACTIVE` instead of
a database error when a live subscription takes the slot concurrently.

Add `docs/state-machines.md`, which documents every plugin state machine and its invariants.
