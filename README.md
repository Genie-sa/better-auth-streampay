# better-auth-streampay

> Community plugin. Not affiliated with Stream / StreamPay.
> Plugin bugs → [GitHub issues](https://github.com/Genie-sa/better-auth-streampay/issues). StreamPay bugs → [Stream support](https://streampay.sa).

[Better Auth](https://better-auth.com) plugin for [StreamPay](https://streampay.sa).

## Features

- Checkout via payment links
- Customer portal (subscriptions, invoices, consumer state)
- Subscriptions: upgrade, change plan, cancel, freeze/unfreeze, entitlements
- Webhook receiver with HMAC-SHA256 verification + replay protection
- Auto DB sync from webhooks (idempotent)
- Admin back-office (consumers, products, coupons, refunds, freezes, …)
- Lazy or eager StreamPay consumer creation, with duplicate-claim modes

## Install

```bash
pnpm add better-auth-streampay @streamsdk/typescript better-auth zod
```

Peers: `better-auth ^1.4`, `@streamsdk/typescript ^1.0.6`, `zod ^3.24 || ^4`.

### Preview releases

Every push to `main` and every PR is published as an installable tarball
via [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new):

```bash
pnpm add https://pkg.pr.new/better-auth-streampay@<sha-or-pr-number>
```

## Env

```bash
STREAMPAY_API_KEY=...
STREAMPAY_WEBHOOK_SECRET=...
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=...
```

## Server

```ts
import { betterAuth } from "better-auth";
import StreamSDK from "@streamsdk/typescript";
import {
  streampay,
  checkout,
  portal,
  subscriptions,
  webhooks,
  admin,
} from "better-auth-streampay";

const client = StreamSDK.init(process.env.STREAMPAY_API_KEY!);

export const auth = betterAuth({
  plugins: [
    streampay({
      client,
      use: [
        checkout({
          products: [{ productId: "aaaa-bbbb-cccc-dddd", slug: "pro" }],
          successUrl: "/dashboard?checkout=success",
          failureUrl: "/dashboard?checkout=failure",
          authenticatedUsersOnly: true,
        }),
        portal(),
        subscriptions({
          plans: [
            {
              name: "pro",
              productId: "prod_recurring_uuid",
              priceHalalat: 9900,
              billingInterval: "MONTH",
              limits: { seats: 10 },
            },
          ],
        }),
        webhooks({ secret: process.env.STREAMPAY_WEBHOOK_SECRET! }),
        admin(),
      ],
    }),
  ],
});
```

## Client

```ts
import { createAuthClient } from "better-auth/react";
import { streampayClient } from "better-auth-streampay/client";

export const authClient = createAuthClient({
  plugins: [streampayClient()],
});
```

## Database migration

Adds a `streampayConsumerId` column on `user`, plus `subscription` and `streampayWebhookEvent` tables when `subscriptions()` is in `use`.

```bash
npx @better-auth/cli migrate                          # Better Auth CLI
npx drizzle-kit generate && npx drizzle-kit migrate    # Drizzle
npx prisma migrate dev                                 # Prisma
```

## `streampay()` options

```ts
streampay({
  client,
  // Eagerly create a consumer at signup. Default: false (lazy).
  createConsumerOnSignUp: false,
  // Reclaim duplicates by matching identifier(s).
  claimExistingConsumerBy: ["email", "phone"],
  // Extra fields passed to `client.createConsumer`.
  getConsumerCreateParams: async ({ user }) => ({
    phone_number: "+966501234567",
    preferred_language: "AR",
    communication_methods: ["WHATSAPP", "EMAIL"],
  }),
  use: [/* sub-plugins */],
});
```

### Consumer lifecycle

- **Lazy** (default) — consumer created on first `/checkout` or subscription mutation.
- **Eager** (`createConsumerOnSignUp: true`) — consumer created inside the signup transaction. Signup aborts if StreamPay rejects.
- All consumers get `external_id = user.id`. The id is stored on `user.streampayConsumerId`.
- On user update → name/email synced to StreamPay. On user delete → consumer deleted. Users with no link are skipped cheap.

### Duplicate handling

`claimExistingConsumerBy` controls reuse when StreamPay returns `DUPLICATE_CONSUMER`:

| Value                | Behavior                                                            |
| -------------------- | ------------------------------------------------------------------- |
| omitted / `[]`       | Reuse only stranded consumers (no `external_id`).                   |
| `["email"]`          | Also reuse consumers matching the same email.                       |
| `["phone"]`          | Also reuse consumers matching the same phone.                       |
| `["email","phone"]`  | Reuse on either match.                                              |

If reused, the plugin rewrites `external_id` to the new user id.

## Checkout

```ts
checkout({
  products: [{ productId: "aaaa-bbbb-cccc-dddd", slug: "pro" }],
  successUrl: "/dashboard?checkout=success",
  failureUrl: "/dashboard?checkout=failure",
  authenticatedUsersOnly: true,
  contactInformationType: "EMAIL",          // or "PHONE"
  customFields: { source: "website" },
});
```

`products` can be a static array or a `() => Promise<StreamPayProduct[]>` factory.

### Client

```ts
// By slug
const { data } = await authClient.checkout({ slug: "pro" });
window.location.href = data.url;

// By UUID
await authClient.checkout({ products: "aaaa-bbbb-cccc-dddd" });

// Multiple products + quantity
await authClient.checkout({
  products: [{ productId: "aaaa-bbbb-cccc-dddd", quantity: 2 }],
});

// With reference id and metadata
await authClient.checkout({
  slug: "pro",
  referenceId: organizationId,
  metadata: { campaign: "spring-sale" },
});
```

### Body fields

| Field                 | Type                                       | Notes                                  |
| --------------------- | ------------------------------------------ | -------------------------------------- |
| `slug`                | `string`                                   | Resolved server-side via `products`    |
| `products`            | `string \| string[] \| { productId, quantity? }[]` | UUID(s)                        |
| `referenceId`         | `string`                                   | Stored in `custom_metadata`            |
| `consumerId`          | `string` (uuid)                            | Override the resolved consumer         |
| `name`                | `string`                                   | Payment link display name              |
| `description`         | `string`                                   |                                        |
| `metadata`            | `Record<string, string \| number \| boolean>` |                                     |
| `successUrl`          | `string`                                   | Absolute or `/relative`                |
| `failureUrl`          | `string`                                   | Absolute or `/relative`                |
| `maxNumberOfPayments` | `number`                                   |                                        |
| `validUntil`          | `string` (ISO 8601)                        |                                        |
| `couponIds`           | `string[]` (uuid)                          |                                        |
| `redirect`            | `boolean`                                  | Default `true`                         |

## Portal

```ts
portal();                       // default page size 100 (StreamPay's max)
portal({ pageSize: 50 });
```

Reads are scoped to the session user via `organization_consumer_id`. One API call per read.

```ts
const { data } = await authClient.state();
if (!data.hasConsumer) {
  // user has no StreamPay consumer yet
}

const subs     = await authClient.subscriptions();   // { hasConsumer, data }
const invoices = await authClient.invoices();        // { hasConsumer, data }
```

When `hasConsumer` is `false`, reads return `200 OK` with `data: []` (or `consumer: null`) instead of 404.

## Subscriptions

```ts
subscriptions({
  plans: [
    {
      name: "pro",
      productId: "prod_recurring_uuid",
      priceHalalat: 9900,                    // 99.00 SAR
      billingInterval: "MONTH",              // WEEK | MONTH | QUARTER | YEAR
      billingIntervalCount: 1,               // optional
      group: "tier",                         // optional, enforces 1 active per group
      limits: { seats: 10, ai_calls: 1000 }, // typed entitlements
    },
  ],
  // or a factory: plans: async () => fetchPlansFromCMS(),

  authorizeReference: async ({ user, referenceId, action }) => {
    return user.role === "admin";
  },

  // Schema knobs (defaults shown). Set to false to BYO state.
  enableSubscriptionTable: true,    // false → skip `subscription` schema + auto-sync
  enableWebhookEventTable: true,    // false → skip `streampayWebhookEvent` dedupe; you handle idempotency

  onSubscriptionCreated:        async (data) => {},
  onSubscriptionActivated:      async (data) => {},
  onSubscriptionCanceled:       async (data) => {},
  onSubscriptionFrozen:         async (data) => {},
  onSubscriptionResumed:        async (data) => {},
  onSubscriptionRenewed:        async (data) => {},
  onSubscriptionPaymentFailed:  async (data) => {},
});
```

Each callback receives `{ subscription, user, streampaySubscription, event }`.

### Endpoints

| Path                                   | Method | Notes                                                            |
| -------------------------------------- | ------ | ---------------------------------------------------------------- |
| `/subscription/upgrade`                | POST   | Creates payment link + `incomplete` row. Idempotent within 15min |
| `/subscription/success`                | GET    | Post-checkout fallback sync if webhook is slow                   |
| `/subscription/cancel`                 | POST   | Immediate or `cancelAtPeriodEnd: true`                           |
| `/subscription/change-plan`            | POST   | `mode: "at_period_end"` (default) or `"immediate"`               |
| `/subscription/freeze`                 | POST   |                                                                  |
| `/subscription/unfreeze`               | POST   | Ends the active freeze early                                     |
| `/subscription/list`                   | GET    | Local rows + plan config                                         |
| `/subscription/current?group=...`      | GET    | Active / frozen / past_due, optional group filter                |
| `/subscription/has-feature?feature=X`  | GET    | Boolean entitlement                                              |
| `/subscription/check-limit?feature=X&count=N` | GET | `{ allowed, limit, remaining }`                            |

### Client

```ts
const { data } = await authClient.upgradeSubscription({ plan: "pro" });
window.location.href = data.url;

// On success page:
await authClient.subscriptionSuccess({ subscriptionId: data.subscriptionId });

// Cancel at period end (keeps access until periodEnd)
await authClient.cancelSubscription({
  subscriptionId,
  cancelAtPeriodEnd: true,
});

// Plan change — immediate (PATCH items, no proration)
await authClient.changeSubscriptionPlan({ plan: "pro_plus", mode: "immediate" });

// Plan change — at period end (default; spawns new payment link)
const { data: change } = await authClient.changeSubscriptionPlan({ plan: "pro_plus" });
window.location.href = change.url;

// Freeze
await authClient.freezeSubscription({
  subscriptionId,
  freezeStartDatetime: new Date().toISOString(),
  freezeEndDatetime: null,
});
await authClient.unfreezeSubscription({ subscriptionId });

// Reads
const current = await authClient.currentSubscription();
const seats   = await authClient.checkSubscriptionLimit({ feature: "seats", count: 8 });
const flag    = await authClient.hasSubscriptionFeature({ feature: "ai_calls" });
```

### Status values

`incomplete | active | inactive | expired | canceled | frozen | past_due`

- `incomplete` — row pre-created at `/upgrade`, webhook not landed yet.
- `past_due` — renewal failed. StreamPay keeps `ACTIVE` during dunning; we don't.

### Cross-account access

By default `referenceId` is the session user's id. Pass a different one and `authorizeReference` is called:

```ts
authorizeReference: async ({ user, referenceId, action }, ctx) => {
  // action: "upgrade" | "cancel" | "freeze" | "unfreeze" | "read" | "change-plan"
  return user.role === "admin";
},
```

Without `authorizeReference`, cross-account ops throw `FORBIDDEN`.

### Webhook auto-sync

If both `subscriptions()` and `webhooks()` are in `use`, the plugin runs an idempotent sync **before** your handlers:

- Dedupes via `streampayWebhookEvent` (`event_type:entity_id:timestamp`).
- Maps subscription events + `INVOICE_COMPLETED` (renewal) onto local rows.
- Fires your `onSubscription*` callbacks after the row is persisted.
- Transient failure → 500 (StreamPay retries). Permanent → logged + 200.

## Admin

Back-office over the StreamPay SDK. Auth gate is `(adminRoles match user.role) || (isAdmin returns true)` — anon → 401, non-admin → 403.

```ts
admin({
  adminRoles: ["admin", "billing_ops"],
  isAdmin: async (user, ctx) => user.email.endsWith("@yourco.com"),

  onRefund:     async ({ user, paymentId, request }) => { /* throw to block */ },
  onPlanChange: async ({ user, subscriptionId, current, patch }) => { /* throw to block */ },
});
```

- POST/PATCH/PUT bodies forward to the SDK verbatim (types from `@streamsdk/typescript`).
- DELETEs take no body / no `Content-Type`.
- List endpoints accept `?page=` / `?size=` (max 100); consumers also `?search_term=`; payments also `?invoice_id=`.
- Admin sub mutations refetch + project into the local `subscription` row using the same code path as the webhook — no drift.

### Endpoints

| Endpoint                                            | Method | SDK call                       |
| --------------------------------------------------- | ------ | ------------------------------ |
| `/admin/streampay/payments`                         | GET    | `listPayments`                 |
| `/admin/streampay/payments/:id`                     | GET    | `getPayment`                   |
| `/admin/streampay/payments/:id/refund`              | POST   | `refundPayment`                |
| `/admin/streampay/subscriptions`                    | GET    | `listSubscriptions`            |
| `/admin/streampay/subscriptions`                    | POST   | `createSubscription`           |
| `/admin/streampay/subscriptions/:id`                | GET    | `getSubscription`              |
| `/admin/streampay/subscriptions/:id`                | PATCH  | `updateSubscription`           |
| `/admin/streampay/subscriptions/:id/cancel`         | POST   | `cancelSubscription`           |
| `/admin/streampay/subscriptions/:id/freeze`         | GET    | `listSubscriptionFreezes`      |
| `/admin/streampay/subscriptions/:id/freeze`         | POST   | `freezeSubscription`           |
| `/admin/streampay/subscriptions/:id/freeze/:freezeId` | PUT  | `updateSubscriptionFreeze`     |
| `/admin/streampay/subscriptions/:id/freeze/:freezeId` | DELETE | `deleteSubscriptionFreeze`   |
| `/admin/streampay/consumers`                        | GET    | `listConsumers` (`search_term`) |
| `/admin/streampay/consumers/:id`                    | GET    | `getConsumer`                  |
| `/admin/streampay/consumers/:id`                    | PATCH  | `updateConsumer`               |
| `/admin/streampay/consumers/:id`                    | DELETE | `deleteConsumer` + clears `streampayConsumerId` |
| `/admin/streampay/invoices`                         | GET    | `listInvoices`                 |
| `/admin/streampay/invoices/:id`                     | GET    | `getInvoice`                   |
| `/admin/streampay/products`                         | GET / POST | `listProducts` / `createProduct` |
| `/admin/streampay/products/:id`                     | GET / PUT / DELETE | `getProduct` / `updateProduct` / `deleteProduct` |
| `/admin/streampay/coupons`                          | GET / POST | `listCoupons` / `createCoupon` |
| `/admin/streampay/coupons/:id`                      | GET / PUT / DELETE | `getCoupon` / `updateCoupon` / `deleteCoupon` |
| `/admin/streampay/payment-links`                    | GET    | `listPaymentLinks`             |
| `/admin/streampay/payment-links/:id`                | GET    | `getPaymentLink`               |

### Calling

Method names mirror the routes: `adminListProducts`, `adminCreateProduct`, `adminCancelSubscription`, `adminRefundPayment`, etc.

Server (`auth.api.*`):
```ts
await auth.api.adminCancelSubscription({
  params: { id: streampaySubscriptionId },
  body:   { cancel_related_invoices: true },
  headers: await headers(),
});
```

Client (`authClient.*` — auto-generated, cookie auto-sent, gate runs on server):
```ts
await authClient.adminListProducts({ query: { page: 1, size: 20 } });
```

### Examples

Create a recurring product:
```ts
await authClient.adminCreateProduct({
  body: {
    name: "Pro Monthly",
    price: "99.000",                       // SAR (string preserves halalat precision)
    is_one_time: false,
    type: "RECURRING",                     // or "ONE_OFF"
    recurring_interval: "MONTH",           // WEEK | MONTH | QUARTER | YEAR
    recurring_interval_count: 1,
    is_price_inclusive_of_vat: true,
  },
});
```
For ONE_OFF: drop the `recurring_*` fields, set `type: "ONE_OFF"`, `is_one_time: true`.

Refund a payment:
```ts
await authClient.adminRefundPayment({
  params: { id: paymentId },
  body: {
    refund_reason: "REQUESTED_BY_CUSTOMER", // REQUESTED_BY_CUSTOMER | DUPLICATE | FRAUDULENT | OTHER
    refund_note: "optional",
    allow_refund_multiple_related_payments: false,
  },
});
```
Refunds are always full (no `amount` field). Settled payments only — `PENDING`/`CANCELED` → 400 `PAYMENT_INVALID_STATE`.

### Errors

Upstream status propagates: 404 → 404, 422 → 422, 409 → 409, 403 → 403. Network/5xx → 500. Body is `{ code, message }` — `code` is stable (`NOT_FOUND`, `VALIDATION_ERROR`, `PRODUCT_LOCKED`, `COUPON_LOCKED`, …). Branch on `code`.

## Webhooks

Register `https://your-app.com/api/auth/streampay/webhooks` in the StreamPay dashboard.

```ts
webhooks({
  secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
  toleranceSeconds: 300,                         // default 300s

  onPayload: async (p) => { /* catch-all, runs first */ },

  onPaymentSucceeded: async (p) => {},
  onPaymentFailed: async (p) => {},
  onPaymentCanceled: async (p) => {},
  onPaymentRefunded: async (p) => {},
  onPaymentMarkedAsPaid: async (p) => {},

  onInvoiceCreated: async (p) => {},
  onInvoiceSent: async (p) => {},
  onInvoiceAccepted: async (p) => {},
  onInvoiceRejected: async (p) => {},
  onInvoiceCompleted: async (p) => {},
  onInvoiceCanceled: async (p) => {},
  onInvoiceUpdated: async (p) => {},

  onSubscriptionCreated: async (p) => {},
  onSubscriptionActivated: async (p) => {},
  onSubscriptionInactivated: async (p) => {},
  onSubscriptionCanceled: async (p) => {},
  onSubscriptionFrozen: async (p) => {},
  onSubscriptionCycleRenewalFailed: async (p) => {},
  onSubscriptionCancelAtPeriodEnd: async (p) => {},
  onSubscriptionFreezeNow: async (p) => {},
  onSubscriptionUnfreezeNow: async (p) => {},
  onSubscriptionUnfreezeFuture: async (p) => {},
  onSubscriptionFreezeCancel: async (p) => {},

  onPaymentLinkPayAttemptFailed: async (p) => {},
});
```

### Payload

```ts
interface StreamPayWebhookPayload<T = StreamPayWebhookData> {
  event_type: StreamPayEventType;
  entity_type: "PAYMENT" | "INVOICE" | "SUBSCRIPTION" | "PAYMENT_LINK";
  entity_id: string;
  entity_url: string;
  status: string;
  data: T;
  timestamp: string;          // ISO 8601
}
```

Each handler is narrowed: `onPaymentSucceeded` only sees `event_type: "PAYMENT_SUCCEEDED"`, etc.

### Signature

Header: `X-Webhook-Signature: t=<unix>,v1=<hex>` where hex is `HMAC_SHA256(secret, "${t}.${rawBody}")`.

### Rolling rotation

```ts
webhooks({
  secret: [
    process.env.STREAMPAY_WEBHOOK_SECRET!,      // new
    process.env.STREAMPAY_WEBHOOK_SECRET_OLD!,  // old
  ],
});
```

Drop the old one once the dashboard is fully cut over.

## Subscription row

```ts
interface Subscription {
  id: string;
  referenceId: string;
  streampaySubscriptionId: string | null;
  streampayConsumerId: string | null;
  plan: string;
  group: string | null;
  amountHalalat: number | null;
  currency: string | null;
  billingInterval: "WEEK" | "MONTH" | "QUARTER" | "YEAR" | null;
  billingIntervalCount: number | null;
  status: "incomplete" | "active" | "inactive" | "expired" | "canceled" | "frozen" | "past_due";
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  endedAt: Date | null;
  frozenAt: Date | null;
  freezeEndAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

## Error codes

```ts
import { $ERROR_CODES, type StreamPayErrorCode } from "better-auth-streampay";

if (err.code === $ERROR_CODES.SUBSCRIPTION_ALREADY_ACTIVE.code) {
  // ...
}
```

Buckets: `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONSUMER_DUPLICATE`, `CONSUMER_HAS_ONGOING_ACTIVITY`, `INVOICE_INVALID_STATE`, `PAYMENT_DUPLICATE`, `PAYMENT_INVALID_STATE`, `PAYMENT_ALREADY_REFUNDED`, `PAYMENT_REFUND_FAILED`, `PAYMENT_GATEWAY_DECLINED`, `PAYMENT_GATEWAY_UNAVAILABLE`, `PAYMENT_METHOD_INVALID`, `PRODUCT_LOCKED`, `COUPON_LOCKED`, `SUBSCRIPTION_NOT_FOUND`, `SUBSCRIPTION_PLAN_NOT_FOUND`, `SUBSCRIPTION_ALREADY_ACTIVE`, `SUBSCRIPTION_INVALID_STATE`, `SUBSCRIPTION_FREEZE_NOT_ACTIVE`, `SUBSCRIPTION_REFERENCE_NOT_AUTHORIZED`, `UNKNOWN`.

`mapToErrorCode(rawCode, status)` maps StreamPay's raw codes onto these buckets.

## Standalone exports

### Verify webhooks (no plugin)

```ts
import {
  verifyWebhook,
  verifyWebhookOrThrow,
  StreamPayWebhookError,
} from "better-auth-streampay";

const result = verifyWebhook({
  secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
  rawBody,
  signatureHeader: req.headers.get("x-webhook-signature"),
  toleranceSeconds: 300,
});

if (!result.ok) {
  // result.reason: MISSING_HEADER | MALFORMED_HEADER | INVALID_TIMESTAMP | EXPIRED | INVALID_SIGNATURE
}
```

### Dispatch handlers manually

```ts
import { dispatchWebhook } from "better-auth-streampay";

await dispatchWebhook(payload, {
  onPayload: async (p) => {},
  onPaymentSucceeded: async (p) => {},
});
```

### Find consumers

```ts
import {
  findConsumerByExternalId,
  findConsumerByIdentifiers,
} from "better-auth-streampay";

const id = await findConsumerByExternalId(client, { externalId: "user-123" });

const consumer = await findConsumerByIdentifiers(client, {
  email: "user@example.com",
  phone_number: "+966501234567",
  external_id: "user-123",
  iban: "SA...",
});
```

### Format / parse SDK errors

```ts
import { formatStreamPayError, parseStreamPayError } from "better-auth-streampay";

try {
  await client.createConsumer(input);
} catch (err) {
  console.error(formatStreamPayError(err));
  const { status, code, requestId, validationErrors } = parseStreamPayError(err);
}
```

### Money

```ts
import { StreamPayAmount } from "better-auth-streampay";

StreamPayAmount.toHalalat("99.00");   // 9900
StreamPayAmount.toSAR(9900);          // "99.00"
```

### Event-type constants

```ts
import {
  STREAMPAY_EVENT_TYPES,
  STREAMPAY_PAYMENT_EVENT_TYPES,
  STREAMPAY_INVOICE_EVENT_TYPES,
  STREAMPAY_SUBSCRIPTION_EVENT_TYPES,
  STREAMPAY_PAYMENT_LINK_EVENT_TYPES,
  type StreamPayEventType,
  type StreamPayEntityType,
  type StreamPayWebhookPayload,
  type WebhookHandler,
  type WebhookHandlers,
} from "better-auth-streampay";
```

### Subscription helpers

```ts
import { hasFeature, checkLimit, subscriptionSchema } from "better-auth-streampay";

const allowed = hasFeature(row, plan, "ai_calls");
const quota   = checkLimit(row, plan, "seats", 8); // { allowed, limit, remaining }
```

## Endpoints summary

| Key                       | Method | Path                               | Auth      | Plugin            |
| ------------------------- | ------ | ---------------------------------- | --------- | ----------------- |
| `checkout`                | POST   | `/checkout`                        | Optional  | `checkout()`      |
| `state`                   | GET    | `/consumer/state`                  | Required  | `portal()`        |
| `subscriptions`           | GET    | `/consumer/subscriptions/list`     | Required  | `portal()`        |
| `invoices`                | GET    | `/consumer/invoices/list`          | Required  | `portal()`        |
| `upgradeSubscription`     | POST   | `/subscription/upgrade`            | Required  | `subscriptions()` |
| `subscriptionSuccess`     | GET    | `/subscription/success`            | Required  | `subscriptions()` |
| `cancelSubscription`      | POST   | `/subscription/cancel`             | Required  | `subscriptions()` |
| `changeSubscriptionPlan`  | POST   | `/subscription/change-plan`        | Required  | `subscriptions()` |
| `freezeSubscription`      | POST   | `/subscription/freeze`             | Required  | `subscriptions()` |
| `unfreezeSubscription`    | POST   | `/subscription/unfreeze`           | Required  | `subscriptions()` |
| `listSubscriptions`       | GET    | `/subscription/list`               | Required  | `subscriptions()` |
| `currentSubscription`     | GET    | `/subscription/current`            | Required  | `subscriptions()` |
| `hasSubscriptionFeature`  | GET    | `/subscription/has-feature`        | Required  | `subscriptions()` |
| `checkSubscriptionLimit`  | GET    | `/subscription/check-limit`        | Required  | `subscriptions()` |
| `streampayWebhooks`       | POST   | `/streampay/webhooks`              | Signature | `webhooks()`      |
| `admin*`                  | varied | `/admin/streampay/...`             | Role      | `admin()`         |

## Scripts

```bash
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check
pnpm build         # tsup (ESM + CJS)
```

## License

MIT
