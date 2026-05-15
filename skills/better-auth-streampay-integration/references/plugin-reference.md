# Plugin option reference

A summary of options on `streampay()` and each sub-plugin. Treat this
as a map, not a contract — the real contract lives in
`node_modules/better-auth-streampay/dist/index.d.ts`. When this file
disagrees with the source, trust the source.

## `streampay(options)` — the root

| Option | Type | Required? | Notes |
|---|---|---|---|
| `client` | `StreamPayClient` | yes | From `StreamSDK.init(process.env.STREAMPAY_API_KEY!)` |
| `use` | `StreamPayPlugin[]` | yes | The sub-plugins to enable |
| `createConsumerOnSignUp` | `boolean` | no | `false` by default (creates customers lazily on first checkout). Set to `true` to create at sign-up |
| `claimExistingConsumerBy` | array of `"email" \| "phone"` | no | What to do when a duplicate is detected (see [troubleshooting.md](troubleshooting.md) for the security trade-off) |
| `getConsumerCreateParams` | `(ctx, request) => Promise<ConsumerCreateOverrides>` | no | Send extra fields when creating a customer |

`ConsumerCreateOverrides` (read from source for the current shape):
`phone_number?`, `preferred_language?`, `iban?`,
`communication_methods?`. Don't set `external_id` — the plugin owns
that.

## `checkout(options)`

| Option | Type | Notes |
|---|---|---|
| `products` | `StreamPayProduct[] \| () => Promise<StreamPayProduct[]>` | Slug → product ID list, or an async resolver |
| `successUrl` | `string` | Absolute or site-relative redirect on success |
| `failureUrl` | `string` | Absolute or site-relative redirect on failure |
| `authenticatedUsersOnly` | `boolean` | If true, rejects guests/anonymous |
| `contactInformationType` | `"EMAIL" \| "PHONE"` | Forwarded to StreamPay |
| `customFields` | `Record<string, unknown>` | Static fields on every payment link |

## `portal(options)`

| Option | Type | Notes |
|---|---|---|
| `pageSize` | `number` | Default 100 (StreamPay's max). Clamped server-side |

## `subscriptions(options)`

| Option | Type | Notes |
|---|---|---|
| `plans` | `StreamPayPlan[] \| () => Promise<StreamPayPlan[]>` | Required. Validated at startup (static) or first request (async) |
| `authorizeReference` | `(ctx) => boolean \| Promise<boolean>` | Per-action authorization (upgrade / cancel / freeze / etc.) for cross-account mutations |
| `enableSubscriptionTable` | `boolean` | Default `true`. `false` skips the `subscription` schema + webhook auto-sync; BYO state via `webhooks({ on* })` |
| `enableWebhookEventTable` | `boolean` | Default `true`. `false` skips the `streampayWebhookEvent` dedupe table — you must guarantee idempotency (Redis SETNX, idempotency middleware, …) |
| `maxWebhookAttempts` | `number` | Default 10. Per-event delivery cap before a row is parked as `dead_letter` |
| `onSubscription{Created,Activated,Canceled,Frozen,Resumed,Renewed,PaymentFailed}` | callbacks | Run after the local row is synced from the matching webhook (skipped when `enableSubscriptionTable=false`) |

`StreamPayPlan`: `name`, `productId`, `priceHalalat`,
`billingInterval`, optional `billingIntervalCount`, optional `group`,
optional `limits`. Plans without `group` share one slot per user.

## `admin(options)`

| Option | Type | Notes |
|---|---|---|
| `adminRoles` | `string[]` | Default `["admin"]`. Comma-split match against `user.role` |
| `isAdmin` | `(user, ctx) => boolean \| Promise<boolean>` | Custom check used when role match fails |
| `onRefund` | hook | Throw to block a refund |
| `onPlanChange` | hook | Receives current sub + incoming patch |

Mounts back-office endpoints under `/admin/streampay/*` for payments,
subscriptions, consumers, invoices, products, coupons, and the
webhook-event lifecycle table (list / get / replay / delete). Read
`src/plugins/admin.ts` for the exact path list.

## `webhooks(options)`

| Option | Type | Notes |
|---|---|---|
| `secret` | `string \| readonly string[]` | Required. Array form for rolling rotation |
| `toleranceSeconds` | `number` | Default 300 |
| `onPayload` | handler | Catch-all, runs BEFORE per-event handlers |
| `on<EventName>` | handler | One per event — see [webhook-events.md](webhook-events.md) |

## Standalone exports (no plugin wiring needed)

| Export | What it's for |
|---|---|
| `verifyWebhook(input)` | Result-based signature verification |
| `verifyWebhookOrThrow(input)` | Throws `StreamPayWebhookError` on failure |
| `dispatchWebhook(payload, handlers)` | Dispatch a pre-verified payload |
| `findConsumerByExternalId(client, opts)` | Resolve a customer ID via `external_id` |
| `findConsumerByIdentifiers(client, ids)` | Lookup full customer by email / phone / external_id / iban |
| `parseStreamPayError(err)` / `formatStreamPayError(err)` | Normalize SDK errors for logs |
| `hasFeature(plans, plan, feature)` / `checkLimit(plans, plan, feature, value)` | Entitlement gating helpers |
| `FeatureKey<P>` | Type helper that narrows `feature` to `keyof plan.limits` for typed plan generics |
| `StreamPayAmount` | Halalat ↔ SAR helper |

`VerifyFailureReason`: `MISSING_HEADER` · `MALFORMED_HEADER` ·
`INVALID_TIMESTAMP` · `EXPIRED` · `INVALID_SIGNATURE`.

## Peer dependencies

```
better-auth          ^1.4.0
@streamsdk/typescript ^1.0.6
zod                  ^3.24 || ^4.0
```

If `better-auth` is older, ask the user to upgrade Better Auth first.

## Tables the plugin contributes

- `user.streampayConsumerId` — always
- `subscription` — only when `subscriptions()` is in `use` and `enableSubscriptionTable !== false`
- `streampayWebhookEvent` — only when `subscriptions()` is in `use`, `enableSubscriptionTable !== false`, and `enableWebhookEventTable !== false`. Dedupes webhook deliveries via unique-insert

For exact field shapes when generating migrations by hand, read
`dist/index.js` or `src/plugins/subscriptions/schema.ts`.
