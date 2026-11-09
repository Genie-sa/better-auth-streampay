---
"better-auth-streampay": patch
---

Stamp `cancelScheduledAt` when the `SUBSCRIPTION_CANCEL_AT_PERIOD_END` webhook arrives after another
webhook already recorded the scheduled cancellation. Before, the column stayed `null` permanently.
