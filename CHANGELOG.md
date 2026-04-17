# Changelog

## 0.3.0 — unreleased

### Breaking

- **`createConsumerOnSignUp` now defaults to `false`.** Matches the convention of every other Better Auth billing plugin (Stripe, Polar, Dodo). Consumers are provisioned lazily at first checkout or subscription mutation via a new shared helper `ensureConsumerForUser`. If you relied on eager provisioning, add it back explicitly:

  ```ts
  streampay({
    client,
    createConsumerOnSignUp: true, // <-- restore eager mode
    use: [...],
  });
  ```

- **Portal reads no longer throw `NOT_FOUND` for users without a StreamPay consumer.** All four portal endpoints (`/consumer/state`, `/consumer/subscriptions/list`, `/consumer/invoices/list`, `/consumer/payments/list`) now return `200 OK` with `{ hasConsumer: false, ... }` instead. The existing `consumer` / `data` / `pagination` fields keep their shape when `hasConsumer` is `true`, so clients that weren't catching the 404 just see empty arrays. Clients that render a distinct "no billing yet" UI should key off `hasConsumer`.

- **Subscription mutations (`cancel`, `freeze`) now lazy-create a consumer before the ownership check.** In practice anyone with a subscription already has a consumer, so this is a no-op. Users who have no consumer AND try to act on a subscription ID they don't own now see `FORBIDDEN` instead of `NOT_FOUND` — same user-facing outcome (request denied), different error label.

- **Authenticated checkout for a user without a StreamPay consumer now lazy-creates one** instead of passing `null` to StreamPay (guest-style checkout). Anonymous sessions still pass `null` so guest checkout keeps working.

### Added

- `ensureConsumerForUser(options, ctx, user)` — shared helper exported from `src/utils/ensure-consumer.ts`. Short-circuits on the already-linked case, recovers by `external_id` for legacy users, creates with `external_id` otherwise, handles `DUPLICATE_CONSUMER` via the same resolution logic as the signup hook, and writes the id back through `internalAdapter.updateUser`. Idempotent and race-safe.

### Changed

- **User-update and user-delete hooks are no longer gated on `createConsumerOnSignUp`.** They fire whenever the user has a linked `streampayConsumerId`, independent of the flag. This means lazy-mode users whose consumers were provisioned at checkout still get profile changes synced to StreamPay. Users with no link are skipped cheaply — no list-scan on the user-update hot path (the legacy `findConsumerByExternalId` fallback was removed; pre-schema legacy users are recovered by the lazy `ensureConsumerForUser` path instead, the next time they hit checkout).
- Sub-plugin factories (`checkout()`, `portal()`, `subscriptions()`, `webhooks()`) now receive the full `StreamPayOptions` object internally instead of just the client. This is a purely internal refactor — the public `streampay(options)` API is unchanged.
