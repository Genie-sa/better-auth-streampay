---
"better-auth-streampay": minor
---

Recover stuck webhook inbox events. A delivery that arrives while another worker holds the processing lease now returns `503` so StreamPay redelivers it, instead of `200` with no processing. The new server-only `auth.api.processDueStreampayWebhookEvents()` retries pending events whose `nextAttemptAt` has passed and reclaims abandoned leases, dead-lettering only after the attempt budget is spent. Run it on a schedule.
