# better-auth-streampay

> **Community plugin — not affiliated with Stream or StreamPay.** For plugin bugs, [open an issue here](https://github.com/Genie-sa/better-auth-streampay/issues). For StreamPay bugs, contact [Stream support](https://streampay.sa).

A [Better Auth](https://better-auth.com) plugin for integrating [StreamPay](https://streampay.sa) payments and subscriptions into your authentication flow.

## Features

- Checkout Integration (lazy-creates a StreamPay consumer on first payment)
- Consumer Portal (subscriptions, invoices, payments)
- Subscription Management (cancel, freeze)
- Optional eager consumer creation on signup (`createConsumerOnSignUp: true`)
- Handle StreamPay Webhooks securely with HMAC-SHA256 signature verification
- Consumer sync on user update/delete (when eager mode is on)

## Installation

```bash
pnpm add better-auth-streampay @streamsdk/typescript better-auth
```

Peer dependencies: `@streamsdk/typescript`, `better-auth`, `zod` (`^3.24` or `^4.0`).

## Preparation

Get your API credentials from the [StreamPay dashboard](https://streampay.sa). The API key is a Base64-encoded `apiKey:apiSecret` pair. Add it to your environment:

```bash
# .env
STREAMPAY_API_KEY=...
STREAMPAY_WEBHOOK_SECRET=...  # Only if using webhooks()
BETTER_AUTH_SECRET=...        # Session signing secret (min 32 chars)
BETTER_AUTH_URL=...           # Your app's public URL (required in prod)
```

## Server Setup

The StreamPay plugin comes with a handful of sub-plugins that add functionality to your stack:

- **Checkout** — Enables a seamless checkout integration via payment links
- **Portal** — Lets your customers view their subscriptions, invoices, and payments
- **Subscriptions** — Manage subscriptions (cancel, freeze)
- **Webhooks** — Listen for StreamPay webhooks with signature verification

```typescript
import { betterAuth } from "better-auth";
import StreamSDK from "@streamsdk/typescript";
import {
  streampay,
  checkout,
  portal,
  subscriptions,
  webhooks,
} from "better-auth-streampay";

const streamPayClient = StreamSDK.init(process.env.STREAMPAY_API_KEY!);

const auth = betterAuth({
  plugins: [
    streampay({
      client: streamPayClient,
      // createConsumerOnSignUp defaults to false: consumers are created
      // lazily at first checkout or subscription mutation. Set to `true`
      // to provision a StreamPay consumer at signup instead.
      use: [
        checkout({
          products: [
            { productId: "aaaa-bbbb-cccc-dddd", slug: "pro" },
          ],
          successUrl: "/dashboard?checkout=success",
          failureUrl: "/dashboard?checkout=failure",
          authenticatedUsersOnly: true,
        }),
        portal(),
        subscriptions(),
        webhooks({
          secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
          onPaymentSucceeded: async (payload) => {
            // provision access
          },
          onSubscriptionCanceled: async (payload) => {
            // revoke access
          },
        }),
      ],
    }),
  ],
});
```

## Client Setup

```typescript
import { createAuthClient } from "better-auth/react";
import { streampayClient } from "better-auth-streampay/client";

export const authClient = createAuthClient({
  plugins: [streampayClient()],
});
```

## Database Migration

The plugin adds a `streampayConsumerId` column to the `user` table. Run your migration after installing:

```bash
npx @better-auth/cli migrate                              # Better Auth CLI
npx drizzle-kit generate && npx drizzle-kit migrate        # Drizzle
npx prisma migrate dev                                     # Prisma
```

## Configuration Options

### Required

| Option   | Type              | Description                   |
| -------- | ----------------- | ----------------------------- |
| `client` | `StreamPayClient` | Initialized StreamPay SDK client |
| `use`    | `StreamPayPlugin[]` | Sub-plugins to compose        |

### Optional

| Option                    | Type       | Description                                                        |
| ------------------------- | ---------- | ------------------------------------------------------------------ |
| `createConsumerOnSignUp`  | `boolean`  | Create a StreamPay consumer eagerly at signup. Default: `false` (lazy — consumer is created on first checkout / subscription mutation). |
| `claimExistingConsumerBy` | `("email" \| "phone")[]` | Reclaim a duplicate linked consumer by the listed identifier(s) |
| `getConsumerCreateParams` | `function` | Provide additional consumer fields (phone, language, IBAN, etc.)   |

### Consumers

**Lazy by default (`createConsumerOnSignUp: false`).** A StreamPay Consumer is created on demand the first time an authenticated user hits `/checkout` or a subscription mutation — not at signup. This keeps the signup hot path off StreamPay and the consumer table free of users who never pay. It matches the convention used by every other Better Auth billing plugin (Stripe, Polar, Dodo Payments).

**Eager opt-in (`createConsumerOnSignUp: true`).** Set the flag to `true` to provision a StreamPay Consumer inside the signup transaction — useful when your product needs portal data (invoices, subscriptions) immediately after signup. The `before` hook aborts signup if StreamPay rejects, keeping the two systems atomic.

All consumers — lazy or eager — are created with `external_id` matching the user's database ID, so no mapping table is needed. The resulting consumer ID is stored as `streampayConsumerId` on the user row.

If StreamPay rejects with `DUPLICATE_CONSUMER`, the plugin normally reuses only stranded consumers whose `external_id` is empty. If you set `claimExistingConsumerBy`, the plugin can also reuse an existing consumer that matches one of the listed identifiers even if it is already linked to a different `external_id`. The `after` hook then rewrites that `external_id` to the new Better Auth user id.

Claim modes:
- omitted / `[]` — only reuse stranded consumers
- `["email"]` — reclaim duplicates that match the same email
- `["phone"]` — reclaim duplicates that match the same phone number
- `["email", "phone"]` — reclaim duplicates that match either email or phone

> **Breaking in 0.2.0:** `claimExistingConsumerBy` now takes an array. Replace `"email"` → `["email"]`, `"phone"` → `["phone"]`, `"both"` → `["email", "phone"]`. `null` is no longer accepted — omit the option or pass `[]` to disable.

Consumer data is kept in sync for any user with a linked `streampayConsumerId` — independent of `createConsumerOnSignUp`:
- **User update** — name/email changes are synced to StreamPay
- **User delete** — the StreamPay consumer is deleted

Users with no linked consumer (pre-first-payment in lazy mode, legacy pre-schema users) are skipped cheaply — there is no list-scan on the user-update hot path.

#### Custom Consumer Fields

```typescript
streampay({
  client: streamPayClient,
  createConsumerOnSignUp: true, // opt into eager mode
  claimExistingConsumerBy: ["email", "phone"],
  getConsumerCreateParams: async ({ user }, request) => ({
    phone_number: "+966501234567",
    preferred_language: "ar",
    communication_methods: ["WHATSAPP", "EMAIL"],
  }),
  use: [...],
});
```

`getConsumerCreateParams` also runs during lazy provisioning at checkout, so it applies in both modes.

## Checkout Plugin

```typescript
checkout({
  products: [{ productId: "aaaa-bbbb-cccc-dddd", slug: "pro" }],
  successUrl: "/dashboard?checkout=success",
  failureUrl: "/dashboard?checkout=failure",
  authenticatedUsersOnly: true,
  contactInformationType: "EMAIL",
  customFields: { source: "website" },
});
```

### Client Usage

```typescript
// By slug (maps to a productId configured on the server)
const { data } = await authClient.checkout({ slug: "pro" });
window.location.href = data.url;

// By product UUID
const { data } = await authClient.checkout({
  products: "aaaa-bbbb-cccc-dddd",
});

// Multiple products with quantities
const { data } = await authClient.checkout({
  products: [
    { productId: "aaaa-bbbb-cccc-dddd", quantity: 2 },
  ],
});

// With metadata and reference ID
const { data } = await authClient.checkout({
  slug: "pro",
  referenceId: organizationId,
  metadata: { campaign: "spring-sale" },
});
```

### Checkout Options

| Option                     | Type                               | Description                                            |
| -------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `products`                 | `StreamPayProduct[]` or `function` | Slug-to-productId mappings                             |
| `successUrl`               | `string`                           | Redirect URL on successful payment                     |
| `failureUrl`               | `string`                           | Redirect URL on failed payment                         |
| `authenticatedUsersOnly`   | `boolean`                          | Reject unauthenticated/anonymous users                 |
| `contactInformationType`   | `"EMAIL" \| "PHONE"`              | Contact info to collect during checkout                |
| `customFields`             | `Record<string, unknown>`          | Static fields forwarded on every payment link          |

### Checkout Request Body

| Field                  | Type                               | Description                              |
| ---------------------- | ---------------------------------- | ---------------------------------------- |
| `slug`                 | `string`                           | Product slug (resolved server-side)      |
| `products`             | `string \| string[] \| object[]`   | Product UUID(s) with optional quantity   |
| `referenceId`          | `string`                           | Custom reference (stored in metadata)    |
| `consumerId`           | `string`                           | Override consumer ID                     |
| `name`                 | `string`                           | Payment link display name                |
| `description`          | `string`                           | Payment link description                 |
| `metadata`             | `Record<string, string\|number\|boolean>` | Custom key-value metadata         |
| `successUrl`           | `string`                           | Override success redirect                |
| `failureUrl`           | `string`                           | Override failure redirect                |
| `maxNumberOfPayments`  | `number`                           | Limit number of payments on this link    |
| `validUntil`           | `string`                           | ISO 8601 expiration datetime             |
| `couponIds`            | `string[]`                         | Coupon UUIDs to apply                    |
| `redirect`             | `boolean`                          | Whether to auto-redirect (default: true) |

## Portal Plugin

```typescript
portal();

// With custom lookup depth for legacy users
portal({ consumerLookupMaxPages: 20 });
```

### Client Usage

```typescript
// Get consumer state — returns { hasConsumer, consumer }
const { data } = await authClient.state();
if (!data.hasConsumer) {
  // User has not triggered lazy consumer creation yet — render "no billing activity" state
}

// List subscriptions — returns { hasConsumer, data, pagination }
const { data: subs } = await authClient.subscriptions({
  query: { page: 1, limit: 20 },
});

// List invoices
const { data: invoices } = await authClient.invoices({
  query: { page: 1, limit: 20 },
});

// List payments
const { data: payments } = await authClient.payments();
```

> **Response shape:** portal reads never eagerly create a consumer. When a user has no StreamPay consumer yet, every read returns `200 OK` with `{ hasConsumer: false, data: [], pagination: null }` (or `consumer: null` for `/state`) instead of `404`. This is additive — the `data` / `consumer` / `pagination` fields keep their shape when `hasConsumer` is true.

## Subscriptions Plugin

```typescript
subscriptions();
```

### Client Usage

```typescript
// Cancel a subscription
await authClient.cancelSubscription({
  subscriptionId: "sub-uuid",
  cancelRelatedInvoices: true,
});

// Freeze a subscription
await authClient.freezeSubscription({
  subscriptionId: "sub-uuid",
  freezeStartDatetime: "2026-06-01T00:00:00Z",
  freezeEndDatetime: "2026-07-01T00:00:00Z",
  notes: "Customer vacation",
});
```

## Webhooks Plugin

```typescript
webhooks({
  secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
  toleranceSeconds: 300, // Replay protection window (default: 300s)

  // Catch-all handler (runs before event-specific handlers)
  onPayload: async (payload) => {
    console.log(`Received: ${payload.event_type}`);
  },

  // Payment events
  onPaymentSucceeded: async (payload) => {},
  onPaymentFailed: async (payload) => {},
  onPaymentCanceled: async (payload) => {},
  onPaymentRefunded: async (payload) => {},
  onPaymentMarkedAsPaid: async (payload) => {},

  // Invoice events
  onInvoiceCreated: async (payload) => {},
  onInvoiceSent: async (payload) => {},
  onInvoiceAccepted: async (payload) => {},
  onInvoiceRejected: async (payload) => {},
  onInvoiceCompleted: async (payload) => {},
  onInvoiceCanceled: async (payload) => {},
  onInvoiceUpdated: async (payload) => {},

  // Subscription events
  onSubscriptionCreated: async (payload) => {},
  onSubscriptionActivated: async (payload) => {},
  onSubscriptionInactivated: async (payload) => {},
  onSubscriptionCanceled: async (payload) => {},
  onSubscriptionFrozen: async (payload) => {},
  onSubscriptionCycleRenewalFailed: async (payload) => {},
  onSubscriptionCancelAtPeriodEnd: async (payload) => {},
  onSubscriptionFreezeNow: async (payload) => {},
  onSubscriptionUnfreezeNow: async (payload) => {},
  onSubscriptionUnfreezeFuture: async (payload) => {},
  onSubscriptionFreezeCancel: async (payload) => {},

  // Payment link events
  onPaymentLinkPayAttemptFailed: async (payload) => {},
});
```

### Webhook Configuration

Register `https://your-app.com/api/auth/streampay/webhooks` as the webhook URL in your [StreamPay dashboard](https://streampay.sa).

### Webhook Payload Shape

```typescript
interface StreamPayWebhookPayload<T = Record<string, unknown>> {
  event_type: StreamPayEventType;   // e.g. "PAYMENT_SUCCEEDED"
  entity_type: StreamPayEntityType; // "PAYMENT" | "INVOICE" | "SUBSCRIPTION" | "PAYMENT_LINK"
  entity_id: string;
  entity_url: string;
  status: string;
  data: T;
  timestamp: string;                // ISO 8601
}
```

### Signature Verification

Webhooks are verified using HMAC-SHA256 with replay protection. The signature header format is `t=<timestamp>,v1=<hex-hmac>`.

## Endpoints

| Key                   | Method | Path                              | Auth      | Plugin            |
| --------------------- | ------ | --------------------------------- | --------- | ----------------- |
| `checkout`            | POST   | `/checkout`                       | Optional  | `checkout()`      |
| `state`               | GET    | `/consumer/state`                 | Required  | `portal()`        |
| `subscriptions`       | GET    | `/consumer/subscriptions/list`    | Required  | `portal()`        |
| `invoices`            | GET    | `/consumer/invoices/list`         | Required  | `portal()`        |
| `payments`            | GET    | `/consumer/payments/list`         | Required  | `portal()`        |
| `cancelSubscription`  | POST   | `/consumer/subscriptions/cancel`  | Required  | `subscriptions()` |
| `freezeSubscription`  | POST   | `/consumer/subscriptions/freeze`  | Required  | `subscriptions()` |
| `streampayWebhooks`   | POST   | `/streampay/webhooks`             | Signature | `webhooks()`      |

## Standalone Exports

These utilities can be used independently, outside the plugin context:

### Webhook Verification

```typescript
import {
  verifyWebhook,
  verifyWebhookOrThrow,
  StreamPayWebhookError,
} from "better-auth-streampay";

// Result-based (no exceptions)
const result = verifyWebhook({
  secret: "your-secret",
  rawBody: '{"event_type":"PAYMENT_SUCCEEDED",...}',
  signatureHeader: request.headers.get("X-Webhook-Signature"),
  toleranceSeconds: 300,
});

if (result.ok) {
  console.log("Valid, timestamp:", result.timestamp);
} else {
  console.log("Invalid:", result.reason);
  // "MISSING_HEADER" | "MALFORMED_HEADER" | "INVALID_TIMESTAMP" | "EXPIRED" | "INVALID_SIGNATURE"
}

// Exception-based
try {
  const timestamp = verifyWebhookOrThrow({
    secret: "your-secret",
    rawBody,
    signatureHeader,
  });
} catch (err) {
  if (err instanceof StreamPayWebhookError) {
    console.log(err.reason);
  }
}
```

### Webhook Dispatch

```typescript
import { dispatchWebhook } from "better-auth-streampay";

await dispatchWebhook(payload, {
  onPayload: async (p) => { /* catch-all */ },
  onPaymentSucceeded: async (p) => { /* specific */ },
});
```

### Consumer Lookup

```typescript
import {
  findConsumerByExternalId,
  findConsumerByIdentifiers,
} from "better-auth-streampay";

// By external ID (returns consumer ID or null)
const consumerId = await findConsumerByExternalId(client, {
  externalId: "user-123",
  maxPages: 10,
  pageSize: 100,
});

// By any identifier (returns full ConsumerResponse or null)
const consumer = await findConsumerByIdentifiers(client, {
  email: "user@example.com",
  phone_number: "+966501234567",
  external_id: "user-123",
  iban: "SA...",
});
```

### Error Formatting

```typescript
import { formatStreamPayError } from "better-auth-streampay";

try {
  await client.createConsumer(input);
} catch (err) {
  console.error(formatStreamPayError(err));
}
```

### Constants & Types

```typescript
import {
  STREAMPAY_EVENT_TYPES,
  type StreamPayEventType,
  type StreamPayEntityType,
  type StreamPayWebhookPayload,
  type WebhookHandler,
  type WebhookHandlers,
  type StreamPayOptions,
  type StreamPayProduct,
  type CheckoutOptions,
  type CheckoutParams,
  type ConsumerCreateOverrides,
  type VerifyWebhookInput,
  type VerifyWebhookResult,
  type VerifyFailureReason,
} from "better-auth-streampay";
```

## Testing

```bash
pnpm test            # vitest run
pnpm typecheck       # tsc --noEmit
pnpm lint            # biome check
pnpm build           # tsup (ESM + CJS)
```

## License

MIT
