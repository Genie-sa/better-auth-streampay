# better-auth-streampay

Add StreamPay payments and subscriptions to a Better Auth app.

## Agent skill

Install the included integration skill:

```bash
npx skills add Genie-sa/better-auth-streampay
```

Then ask your coding agent to add StreamPay to your Better Auth app.

The plugin can:

- create StreamPay consumers
- open hosted checkout
- show a billing portal
- manage subscriptions
- expose admin billing actions
- verify and handle signed webhooks

## Install

```bash
pnpm add better-auth-streampay @streamsdk/typescript
```

Required versions:

- `better-auth ^1.5.0`
- `@streamsdk/typescript ^1.1.3`
- `zod ^3.24.0 || ^4.0.0`

## Basic setup

Add your StreamPay API key:

```bash
STREAMPAY_API_KEY=
STREAMPAY_WEBHOOK_SECRET=
```

Create one SDK client and pass it to the plugin:

```ts
import StreamSDK from "@streamsdk/typescript";
import { betterAuth } from "better-auth";
import {
  checkout,
  portal,
  streampay,
  subscriptions,
  webhooks,
} from "better-auth-streampay";

const streamPayClient = StreamSDK.init(process.env.STREAMPAY_API_KEY!);

export const auth = betterAuth({
  plugins: [
    streampay({
      client: streamPayClient,
      use: [
        checkout(),
        portal(),
        subscriptions({
          plans: [
            {
              name: "pro",
              productId: "your-recurring-product-id",
              priceInSmallestUnit: 9900,
              billingInterval: "MONTH",
              limits: { reports: true },
            },
          ],
        }),
        webhooks({
          secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
        }),
      ],
    }),
  ],
});
```

Only add the parts you use.

## Database

For a new Better Auth managed database:

```bash
npx auth@latest migrate --config path/to/auth.ts
```

For Drizzle or Prisma:

```bash
npx auth@latest generate --config path/to/auth.ts
```

Review the generated schema, then use your normal migration process. The plugin declares the
schema but never changes your database at runtime. For an existing subscription table, backfill
`seats` to `1` in the same migration.

`streampayConsumerId` is unique. Before applying the generated unique index to an existing
database, resolve any duplicate non-null consumer IDs. Checkout fails closed when a consumer link
cannot be stored safely.

## Client setup

```ts
import { createAuthClient } from "better-auth/react";
import { streampayClient } from "better-auth-streampay/client";

export const authClient = createAuthClient({
  plugins: [streampayClient()],
});
```

Use the matching Better Auth client for Vue, Svelte, or Solid.

## Consumers

By default, the plugin creates a StreamPay consumer when the user first needs one. This keeps a
StreamPay outage from blocking sign-up.

To create the consumer during sign-up:

```ts
streampay({
  client: streamPayClient,
  createConsumerOnSignUp: true,
  use: [],
});
```

To reuse an existing StreamPay consumer after a verified email match:

```ts
streampay({
  client: streamPayClient,
  createConsumerOnSignUp: true,
  claimExistingConsumerBy: ["email"],
  use: [],
});
```

Only enable reuse when your app verifies the matching email or phone number.

## Checkout

```ts
checkout({
  products: [
    { slug: "starter", productId: "product-id" },
  ],
  successUrl: "/billing/success",
  failureUrl: "/billing/failed",
  authenticatedUsersOnly: true,
});
```

Open checkout:

```ts
const { data } = await authClient.checkout({
  slug: "starter",
  redirect: false,
});

window.location.href = data.url;
```

You can also pass StreamPay product IDs directly with `products`.

### Server-authoritative checkout

For a store, derive product IDs, quantities, coupons, expiry, and redirect URLs on the server:

```ts
import { APIError } from "better-auth/api";

checkout({
  authenticatedUsersOnly: true,

  resolveCheckout: async ({ user, body }) => {
    const order = await loadAuthorizedOrder(user?.id, body.referenceId);
    if (!order) {
      throw new APIError("FORBIDDEN", {
        code: "ORDER_NOT_AVAILABLE",
        message: "This order is not available for checkout.",
      });
    }

    return {
      products: [{ productId: order.productId, quantity: order.quantity }],
      successUrl: `https://shop.example.com/orders/${order.id}?checkout=success`,
      failureUrl: `https://shop.example.com/orders/${order.id}?checkout=failed`,
      maxNumberOfPayments: 1,
      validUntil: order.validUntil,
      metadata: { flow: "store" },
    };
  },

  onCheckoutCreated: async ({ referenceId, paymentLinkId, payload }) => {
    await saveOrderPaymentLink({ referenceId, paymentLinkId, payload });
  },
});
```

The client then sends only app-owned reference data:

```ts
await authClient.checkout({ referenceId: order.id, redirect: false });
```

Configuring `resolveCheckout` automatically makes product, pricing, coupon, expiry, metadata, and
redirect URL fields server-only. Requests that include those fields are rejected; without a
resolver, the existing client-driven checkout behavior is unchanged.

Invalid values returned by `resolveCheckout` produce a generic 500 response. Validation details are
written to the server log without echoing the invalid values to the client.

If `onCheckoutCreated` throws, checkout returns an error and the plugin attempts to deactivate the
new payment link. Deactivation is best effort, so webhook handling should still reconcile unexpected
links. Relative success and failure URLs resolve against the auth server; use absolute URLs when the
storefront has a different origin.

## Billing portal

`portal()` adds three signed-in user actions:

- `state`
- `subscriptions`
- `invoices`

```ts
const state = await authClient.consumer.state();
const subscriptions = await authClient.consumer.subscriptions.list();
const invoices = await authClient.consumer.invoices.list();
```

## Subscriptions

```ts
subscriptions({
  plans: [
    {
      name: "pro-monthly",
      productId: "product-id",
      priceInSmallestUnit: 9900,
      currency: "SAR",
      billingInterval: "MONTH",
      billingIntervalCount: 1,
      trialPeriodDays: 7,
      group: "main",
      seatBilling: {
        default: 3,
        minimum: 1,
        maximum: 100,
      },
      limits: { projects: 50, reports: true },
    },
  ],

  onSubscriptionActivated: async ({ subscription, user }) => {
    // Run app-specific work here.
  },
});
```

Plan names and product IDs must be unique. Prices use the smallest currency unit. For SAR,
`9900` means `99.00 SAR`.

`priceInSmallestUnit` is the price per seat. `seatBilling` controls billed quantity; `limits`
controls application access. Set `customerEditable: true` with explicit minimum and maximum bounds
to let customers change quantity in hosted checkout.

The plugin gives one trial per user and plan group by default. Use `isTrialEligible` when your
app needs a stricter or more flexible rule.

### Start checkout

```ts
const { data } = await authClient.subscription.upgrade({
  plan: "pro-monthly",
  seats: 5,
});

window.location.href = data.url;
```

On the success page:

```ts
await authClient.subscription.success({
  query: { subscriptionId: data.subscriptionId },
});
```

Then refresh the subscription data used by your UI.

### Manage a subscription

```ts
await authClient.subscription.changePlan({
  subscriptionId,
  plan: "pro-yearly",
  seats: 8, // optional; defaults to the current quantity
});

await authClient.subscription.updateSeats({
  subscriptionId,
  seats: 12,
});

await authClient.subscription.pendingChange.cancel({ subscriptionId });

await authClient.subscription.cancel({
  subscriptionId,
  cancelAtPeriodEnd: true,
});

await authClient.subscription.uncancel({ subscriptionId });
```

StreamPay applies quantity and plan changes at period end. Read the active quantity from `seats`
and the scheduled quantity from `pendingSeats`. The older
`authClient.subscription.changePlan.cancel()` action remains available.

StreamPay cancels an active subscription at the end of its current period. Trial and inactive
subscriptions are canceled at once.

### Freeze a subscription

```ts
const { data: freeze } = await authClient.subscription.freeze({
  subscriptionId,
  freezeStartDatetime: new Date().toISOString(),
  freezeEndDatetime: null,
});

await authClient.subscription.unfreeze({ subscriptionId });

await authClient.subscription.freeze.cancel({
  subscriptionId,
  freezeId: freeze.id!,
});
```

### Read access and limits

```ts
const current = await authClient.subscription.current({
  query: { group: "main" },
});

const feature = await authClient.subscription.hasFeature({
  query: { feature: "reports", group: "main" },
});

const projects = await authClient.subscription.checkLimit({
  query: { feature: "projects", count: 4, group: "main" },
});
```

`checkLimit` reads configured entitlements. Use `current.data?.seats` for licensed-member counts.

Pass `group` for grouped plans. Leave it out only for a plan without a group.

See [the subscription data model](docs/subscriptions.md) for columns, lifecycle, and migration
details.

By default, `active`, `trialing`, `frozen`, and `past_due` subscriptions can use plan
features. Change this with `accessStatuses`.

## Server-side calls

Every checkout, portal, subscription, and admin action is also available on `auth.api`. Types
come from Better Auth.

Browser calls follow the route path, such as `authClient.subscription.cancel`. Server calls use
the endpoint name, such as `auth.api.cancelSubscription`.

```ts
import { headers } from "next/headers";

const current = await auth.api.currentSubscription({
  query: { group: "main" },
  headers: await headers(),
});

await auth.api.cancelSubscription({
  body: { subscriptionId, cancelAtPeriodEnd: true },
  headers: await headers(),
});
```

Pass the request headers so Better Auth can read the session.

Webhook delivery is not an `auth.api` action. It uses the raw HTTP body to verify the signature.

## Cross-account access

User actions use the signed-in user's ID by default.

To manage an organization or another app-owned reference, add `authorizeReference`:

```ts
subscriptions({
  plans,
  authorizeReference: async ({ user, referenceId, referenceType, action }) => {
    return canManageBilling(user, referenceId, referenceType, action);
  },
});
```

Without this callback, cross-account actions return `FORBIDDEN`.

### Who gets billed

By default, checkout bills the acting user's StreamPay consumer whatever the reference points
at. Set `billingIdentity: "reference"` to bill the user named by `referenceId` instead:

```ts
subscriptions({
  plans,
  authorizeReference,
  billingIdentity: "reference",
});
```

```ts
await auth.api.upgradeSubscription({
  body: { plan: "pro", referenceId: targetUserId },
  headers,
});
```

That bills `targetUserId`'s consumer, provisioning one if they have none. `authorizeReference`
is still the only gate — the consumer is derived from the reference it already approved, never
from the request body.

Under `"reference"`, `referenceType` defaults to `"user"` rather than `"custom"`, so ownership
and billing land on the same identity and the subscription appears in the target user's own
reads with no query params.

Only `"user"` references have a billing identity. Under `"reference"`, upgrading with a
`referenceType` of `"organization"` or `"custom"` returns `SUBSCRIPTION_REFERENCE_NOT_BILLABLE`,
since those have no StreamPay consumer to charge. Both types still work for reads and for
managing existing subscriptions.

## Admin

`admin()` adds billing actions for payments, subscriptions, freezes, consumers, invoices,
products, coupons, payment links, and webhook retries.

```ts
import { admin } from "better-auth-streampay";

admin({
  adminRoles: ["admin", "billing"],
  isAdmin: async (user) => user.email.endsWith("@example.com"),
});
```

Calls use names such as:

- `auth.api.adminListPayments`
- `auth.api.adminGetSubscription`
- `auth.api.adminCreateProduct`
- `auth.api.adminReplayWebhookEvent`

The IDE shows the body, query, and response types for every action.

Make sure your Better Auth route accepts `GET`, `POST`, `PATCH`, `PUT`, and `DELETE`.

## Webhooks

Register this URL in the StreamPay dashboard:

```text
https://your-app.com/api/auth/streampay/webhooks
```

Then add the handlers you need:

```ts
webhooks({
  secret: process.env.STREAMPAY_WEBHOOK_SECRET!,

  onPaymentSucceeded: async (event) => {},
  onPaymentFailed: async (event) => {},
  onSubscriptionActivated: async (event) => {},
  onSubscriptionCanceled: async (event) => {},
  onPayload: async (event) => {},
});
```

The plugin:

- checks the webhook signature
- rejects old signatures
- deduplicates subscription sync and lifecycle callbacks
- retries temporary failures
- stores failed subscription events for admin replay

The StreamPay SDK does not export webhook payload types. This package provides checked event
types based on StreamPay's documented payloads.

To rotate a secret:

```ts
webhooks({
  secret: [
    process.env.STREAMPAY_WEBHOOK_SECRET!,
    process.env.STREAMPAY_WEBHOOK_SECRET_OLD!,
  ],
});
```

Remove the old secret after StreamPay uses the new one.

## What owns each job

StreamPay owns:

- charges
- invoices
- subscription state
- trials
- renewal attempts
- cancellation timing

The plugin owns:

- Better Auth access checks
- local subscription rows
- plan features and limits
- webhook checks and retries
- checkout recovery

Do not edit subscription rows by hand. Let provider responses and webhooks update them.

## Errors

Errors use stable codes:

```ts
import { $ERROR_CODES } from "better-auth-streampay";

if (error.code === $ERROR_CODES.SUBSCRIPTION_ALREADY_ACTIVE.code) {
  // Show the current plan.
}
```

Common codes include:

- `VALIDATION_ERROR`
- `FORBIDDEN`
- `NOT_FOUND`
- `SUBSCRIPTION_ALREADY_ACTIVE`
- `SUBSCRIPTION_INVALID_STATE`
- `SUBSCRIPTION_PLAN_CHANGE_ALREADY_SCHEDULED`
- `WEBHOOK_REPLAY_IN_PROGRESS`

## Useful exports

```ts
import {
  StreamPayAmount,
  checkLimit,
  findConsumerByExternalId,
  formatStreamPayError,
  hasFeature,
  parseStreamPayError,
  verifyWebhook,
} from "better-auth-streampay";
```

## License

MIT
