# Plugin Option Reference

Every option on `streampay()` and each sub-plugin, with types and defaults, copied from the `better-auth-streampay` README and `src/types.ts`. Use this as the source of truth when generating the `auth.ts` file in Phase 4.

## `streampay(options)` — the root plugin

| Option | Type | Required | Default | Notes |
|---|---|---|---|---|
| `client` | `StreamPayClient` | ✅ | — | From `StreamSDK.init(process.env.STREAMPAY_API_KEY!)` |
| `use` | `StreamPayPlugin[]` | ✅ | — | Sub-plugins to compose: `checkout()`, `portal()`, `subscriptions()`, `webhooks()` |
| `createConsumerOnSignUp` | `boolean` | — | `false` | Create consumer on Better Auth sign-up |
| `claimExistingConsumerBy` | `("email" \| "phone")[]` | — | `[]` | Reclaim a linked duplicate on `DUPLICATE_CONSUMER`. Omit (or `[]`) = only stranded consumers are reused. Pass `["email", "phone"]` to reclaim by either. See security note in [interview-questions.md](interview-questions.md) Q5 |
| `getConsumerCreateParams` | `(ctx, request) => Promise<ConsumerCreateOverrides>` | — | — | Inject custom consumer fields at creation time |

### `ConsumerCreateOverrides` fields

```ts
{
  phone_number?: string
  preferred_language?: string              // ISO-ish: "en", "ar"
  iban?: string
  communication_methods?: ("WHATSAPP" | "EMAIL" | "SMS")[]
}
```

The returned object is merged with the default `{ name, email, external_id }` payload. Do not override `external_id` — the plugin owns it.

## `checkout(options)` — sub-plugin

| Option | Type | Description |
|---|---|---|
| `products` | `StreamPayProduct[] \| function` | Slug→productId mapping, or a resolver `(ctx) => Promise<StreamPayProduct[]>` |
| `successUrl` | `string` | Redirect on successful payment (absolute or relative) |
| `failureUrl` | `string` | Redirect on failed payment |
| `authenticatedUsersOnly` | `boolean` | Reject anonymous/unauthenticated callers |
| `contactInformationType` | `"EMAIL" \| "PHONE"` | Contact field collected during checkout |
| `customFields` | `Record<string, unknown>` | Static fields forwarded on every payment link |

### Endpoint

- `POST /api/auth/checkout` — body: `CheckoutParams` (see README §Checkout Request Body)
- Client: `authClient.checkout({ slug, products, referenceId, metadata, ... })`

## `portal()` — sub-plugin

| Option | Type | Description |
|---|---|---|
| `consumerLookupMaxPages` | `number` | Pages to scan when resolving legacy consumers without `external_id`. Default: `10` |

### Endpoints (all require session)

- `GET /api/auth/consumer/state` → `authClient.state()`
- `GET /api/auth/consumer/subscriptions/list` → `authClient.subscriptions({ query: { page, limit } })`
- `GET /api/auth/consumer/invoices/list` → `authClient.invoices(...)`
- `GET /api/auth/consumer/payments/list` → `authClient.payments()`

## `subscriptions()` — sub-plugin

No options. Exposes:

- `POST /api/auth/consumer/subscriptions/cancel` → `authClient.cancelSubscription({ subscriptionId, cancelRelatedInvoices })`
- `POST /api/auth/consumer/subscriptions/freeze` → `authClient.freezeSubscription({ subscriptionId, freezeStartDatetime, freezeEndDatetime, notes })`

## `webhooks(options)` — sub-plugin

| Option | Type | Description |
|---|---|---|
| `secret` | `string` | The webhook signing secret from the StreamPay dashboard (store in env). Required. |
| `toleranceSeconds` | `number` | Max allowed signature age. Default: `300` |
| `onPayload` | `(p: StreamPayWebhookPayload) => Promise<void>` | Catch-all handler, runs BEFORE event-specific handlers |
| `on<EventName>` | `(p: StreamPayWebhookPayload) => Promise<void>` | Per-event handler — see [webhook-events.md](webhook-events.md) |

### Endpoint

- `POST /api/auth/streampay/webhooks` — verifies HMAC-SHA256 signature and dispatches. No session required (signature header format: `t=<timestamp>,v1=<hex>`).

## Standalone exports (no plugin wiring required)

| Export | Signature | Use case |
|---|---|---|
| `verifyWebhook(input)` | `(input: VerifyWebhookInput) => VerifyWebhookResult` | Result-based verification (no throw) |
| `verifyWebhookOrThrow(input)` | `(input) => number` | Throws `StreamPayWebhookError` on failure |
| `dispatchWebhook(payload, handlers)` | `(payload, WebhookHandlers) => Promise<void>` | Dispatch a pre-verified payload to handlers |
| `findConsumerByExternalId(client, opts)` | `(client, { externalId, maxPages, pageSize }) => Promise<string \| null>` | Look up consumer ID by external ID |
| `findConsumerByIdentifiers(client, ids)` | `(client, { email?, phone_number?, external_id?, iban? }) => Promise<ConsumerResponse \| null>` | Look up full consumer by any identifier |
| `formatStreamPayError(err)` | `(err: unknown) => string` | Normalize SDK errors for logs |

### `VerifyFailureReason` values

`"MISSING_HEADER" | "MALFORMED_HEADER" | "INVALID_TIMESTAMP" | "EXPIRED" | "INVALID_SIGNATURE"`

## Types worth knowing

From the package root entry:

```ts
import type {
  StreamPayOptions,
  StreamPayProduct,
  CheckoutOptions,
  CheckoutParams,
  ConsumerCreateOverrides,
  ClaimExistingConsumerBy,
  ClaimExistingConsumerIdentifier,
  StreamPayWebhookPayload,
  StreamPayEventType,
  StreamPayEntityType,
  WebhookHandler,
  WebhookHandlers,
  VerifyWebhookInput,
  VerifyWebhookResult,
  VerifyFailureReason,
} from "better-auth-streampay"
```

## Peer dependencies

```
better-auth     ^1.4.0
@streamsdk/typescript  ^1.0.6
zod             ^3.24 || ^4.0
```

If a project uses an older `better-auth`, abort and tell the user to upgrade first.
