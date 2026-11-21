---
"better-auth-streampay": minor
---

Link StreamPay subscriptions that have no local reservation, only with ownership evidence.

- New `subscriptions({ appId })` stamps checkout links with a per-deployment ID. A link stamped with
  another app's ID is never linked, so apps and environments can share one StreamPay organization.
  Keep the value stable.
- Renewal and creation events for a plugin checkout whose reservation row is gone link it when
  StreamPay bills a configured plan product and the user exists with a matching consumer.
  Organization and custom references need the new `resolveSubscriptionReference` callback
  (`SUBSCRIPTION_CREATED` and `SUBSCRIPTION_ACTIVATED` still link them with a warning, as before).
- New opt-in `resolveUnlinkedSubscription` maps subscriptions created in the StreamPay dashboard or
  API, which carry no plugin metadata, to a local reference.
- New `adminLinkSubscription` endpoint (`POST /admin/streampay/subscriptions/:id/link`) links one by
  hand. It projects state without firing lifecycle callbacks and returns 409 on any conflict.
- Creation webhooks no longer create rows for users that do not exist in this app, and a released
  reservation that owns the payment link is linked instead of failing on the unique link ID.
