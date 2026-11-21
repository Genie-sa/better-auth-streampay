---
"better-auth-streampay": patch
---

Renewal evidence (`INVOICE_COMPLETED`, `SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY`) for a subscription
that is not linked yet now links the checkout reservation that owns its StreamPay payment link,
using the link's signed metadata. Before, if the creation webhooks failed or were delayed, renewal
events completed without effect: the paid checkout stayed `incomplete` and `onSubscriptionRenewed`
never ran. A subscription first linked after it already renewed reports that renewal once.
