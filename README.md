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
              limits: { seats: 10 },
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
npx @better-auth/cli migrate --config path/to/auth.ts
```

For Drizzle or Prisma:

```bash
npx @better-auth/cli generate --config path/to/auth.ts
```

Then create and run your normal database migration.

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
      limits: { seats: 10, reports: true },
    },
  ],

  onSubscriptionActivated: async ({ subscription, user }) => {
    // Run app-specific work here.
  },
});
```

Plan names and product IDs must be unique. Prices use the smallest currency unit. For SAR,
`9900` means `99.00 SAR`.

The plugin gives one trial per user and plan group by default. Use `isTrialEligible` when your
app needs a stricter or more flexible rule.

### Start checkout

```ts
const { data } = await authClient.subscription.upgrade({
  plan: "pro-monthly",
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
});

await authClient.subscription.changePlan.cancel({ subscriptionId });

await authClient.subscription.cancel({
  subscriptionId,
  cancelAtPeriodEnd: true,
});

await authClient.subscription.uncancel({ subscriptionId });
```

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

const seats = await authClient.subscription.checkLimit({
  query: { feature: "seats", count: 4, group: "main" },
});
```

Pass `group` for grouped plans. Leave it out only for a plan without a group.

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
