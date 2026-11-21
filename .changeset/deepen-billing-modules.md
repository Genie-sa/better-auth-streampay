---
"better-auth-streampay": minor
---

Consolidate the webhook inbox, checkout reservations, subscription projection writes, and consumer links into one module each, and fix the defects that the duplicated copies had drifted into.

- Replaying a leftover `handlers:` inbox event with `webhooks({ deduplicate })` turned off no longer marks it completed without running any handler. Replay is routed by the event ID prefix; the event stays pending with `lastErrorCode: "WEBHOOK_INBOX_SCOPE_DISABLED"` and leaves the due queue until a StreamPay redelivery or an admin replay after re-enabling the scope.
- New `webhooks({ maxWebhookAttempts })` sets how many deliveries a generic handler event gets before it is dead-lettered (default 5). Before, generic handlers always used 5.
- Cancel, uncancel, freeze, unfreeze, freeze cancel, and the admin subscription endpoints now refresh `pendingPlan`, `pendingSeats`, `catalogMapped`, and the other plan fields from StreamPay. A provider snapshot without `items` no longer clears the plan mapping, and those customer actions no longer fail while a function-backed `plans` catalog is temporarily unavailable.
- The consumer link is claimed only while the user is still unlinked, so a concurrent request can neither overwrite a stored link nor roll it back. A consumer created by a request that lost the claim is deleted. A session issued before the link was stored uses the stored link instead of provisioning again. The link is written directly instead of through `internalAdapter.updateUser`, so Better Auth `user.update` database hooks no longer fire for it, and an app that reads `session.user.streampayConsumerId` from a cached session sees the link once that session refreshes. The plugin itself always reads the stored link.
- Replacing a stale checkout reservation fails with `SUBSCRIPTION_CHECKOUT_IN_PROGRESS` when a payment link was attached concurrently, instead of releasing a reservation whose link was still payable.
- Renewal writes also check the subscription and consumer IDs, so a renewal never applies to a row that was rebound concurrently.
- Discarding a renewal event still releases its callback lock after `subscriptions({ enableWebhookEventTable: false })` turns subscription deduplication off.
- A failed `onSubscriptionRenewed` callback records `lastErrorCode: "SUBSCRIPTION_RENEWAL_CALLBACK_FAILED"`. Rows recorded by earlier versions are still recognized.

`StreamPayPluginRegistry` gains the optional `webhookInbox` and `refreshSubscriptionProjection` members; `replayWebhookHandler` is deprecated in favor of `replayWebhookEvent`, which replays any inbox event.
