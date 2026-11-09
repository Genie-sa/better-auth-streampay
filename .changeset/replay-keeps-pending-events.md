---
"better-auth-streampay": patch
---

A failed admin webhook replay no longer dead-letters an event that was still pending. Before, the
event was skipped on every later StreamPay redelivery and by `processDueStreampayWebhookEvents()`,
so a transient outage during a replay lost it. Replays now dead-letter only events that were already
dead-lettered, failed permanently, or exhausted their attempts, and they honor
`retryOnCallbackError`.
