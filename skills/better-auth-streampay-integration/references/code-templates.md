# Setup examples

Use these only after reading the app. Match its paths, framework, and style.

## Install

```bash
pnpm add better-auth-streampay @streamsdk/typescript
```

Install in the workspace that owns the Better Auth config.

## Environment

```bash
STREAMPAY_API_KEY=
STREAMPAY_WEBHOOK_SECRET=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
```

Only add `STREAMPAY_WEBHOOK_SECRET` when `webhooks()` is enabled.

Keep real values out of source control. Put empty names in `.env.example`.

## Server

```ts
import StreamSDK from "@streamsdk/typescript";
import { betterAuth } from "better-auth";
import {
  checkout,
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
        checkout({
          successUrl: "/billing/success",
          failureUrl: "/billing/failed",
          authenticatedUsersOnly: true,
        }),
        subscriptions({
          plans: [
            {
              name: "pro",
              productId: "recurring-product-id",
              priceInSmallestUnit: 9900,
              billingInterval: "MONTH",
              group: "main",
              seatBilling: { default: 3, minimum: 1, maximum: 100 },
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

Remove parts the app does not use.

Keep an existing auth factory:

```ts
export function createAuth() {
  const db = createDb();

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    plugins: [
      streampay({
        client: streamPayClient,
        use: [checkout()],
      }),
    ],
  });
}
```

## Server-authoritative checkout

Use this shape when a local order determines what the customer may pay for:

```ts
import { APIError } from "better-auth/api";

checkout({
  authenticatedUsersOnly: true,
  resolveCheckout: async ({ user, body }) => {
    if (!user || !body.referenceId) {
      throw new APIError("BAD_REQUEST", {
        code: "ORDER_REFERENCE_REQUIRED",
        message: "A valid order reference is required.",
      });
    }

    const order = await loadAuthorizedOrder(user.id, body.referenceId);
    if (!order) {
      throw new APIError("FORBIDDEN", {
        code: "ORDER_NOT_AVAILABLE",
        message: "This order is not available for checkout.",
      });
    }

    return {
      products: [{ productId: order.productId, quantity: order.quantity }],
      successUrl: `${process.env.APP_URL}/orders/${order.id}?checkout=success`,
      failureUrl: `${process.env.APP_URL}/orders/${order.id}?checkout=failed`,
      maxNumberOfPayments: 1,
      validUntil: order.validUntil,
      metadata: { flow: "store" },
    };
  },
  onCheckoutCreated: async ({ referenceId, paymentLinkId, payload }) => {
    if (!referenceId) throw new Error("resolved checkout is missing its order reference");

    try {
      await saveOrderPaymentLink({ referenceId, paymentLinkId, payload });
    } catch (error) {
      if (isOrderConflict(error)) {
        throw new APIError("CONFLICT", {
          code: "ORDER_WRITE_CONFLICT",
          message: "This order already has a checkout.",
        });
      }
      throw error;
    }
  },
});
```

The client sends only the local reference and redirect preference:

```ts
await authClient.checkout({ referenceId: order.id, redirect: false });
```

`resolveCheckout` automatically rejects client-supplied payment fields; there is no trust flag to
configure. Invalid resolver output is a generic 500 and logs only invalid field paths. If
`onCheckoutCreated` throws, the plugin attempts to deactivate the new link, but that compensation
is best effort. Keep the write idempotent and reconcile final order state from idempotent webhooks.

## Bill another user or organization

These endpoints have no HTTP route. Only server code can call them. Check permission first.

```ts
// Subscription checkout billed to any user (referenceType defaults to "user"):
const { url } = await auth.api.upgradeSubscriptionForReference({
  body: { plan: "pro", referenceId: targetUserId },
});

// Subscription checkout billed to an organization:
await auth.api.upgradeSubscriptionForReference({
  body: { plan: "team", referenceId: orgId, referenceType: "organization", seats: 10 },
});

// One-time payment link billed to a user or organization.
// The link allows one payment by default; pass maxNumberOfPayments for more.
await auth.api.checkoutForReference({
  body: { slug: "consulting-hour", referenceId: orgId, referenceType: "organization" },
});
```

Organization billing needs the Better Auth `organization()` plugin plus this option on
`streampay()`:

```ts
streampay({
  client: streamPayClient,
  organization: {
    enabled: true,
    // Only when the organization plugin uses a custom table name:
    modelName: "orgs",
    // Only when the StreamPay account requires contact fields on consumers:
    getBillingDetails: async ({ organization }) => ({
      phone_number: await billingPhoneFor(organization.id),
    }),
  },
  use: [/* ... */],
});
```

Startup fails with a clear error when the organization plugin is missing or its table name
does not match — the error message says what to set.

Run the database step again after enabling it: the option adds
`organization.streampayConsumerId`.

Send the returned `url` to whoever completes payment. Typed failures:
`SUBSCRIPTION_ORG_BILLING_NOT_ENABLED`, `ORG_NOT_FOUND`, `BILLING_CONTACT_REQUIRED`,
`SUBSCRIPTION_REFERENCE_USER_NOT_FOUND`, `SUBSCRIPTION_REFERENCE_USER_NOT_BILLABLE`.

## Client

```ts
import { createAuthClient } from "better-auth/react";
import { streampayClient } from "better-auth-streampay/client";

export const authClient = createAuthClient({
  plugins: [streampayClient()],
});
```

Use the app's current Better Auth client package.

## Routes

### Next.js App Router

```ts
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(auth);
```

### Next.js Pages Router

```ts
import { toNodeHandler } from "better-auth/node";
import { auth } from "@/lib/auth";

export default toNodeHandler(auth);
```

### Hono

```ts
app.on(
  ["GET", "POST", "PATCH", "PUT", "DELETE"],
  "/api/auth/*",
  (c) => auth.handler(c.req.raw),
);
```

### Elysia

```ts
new Elysia().all("/api/auth/*", ({ request }) => auth.handler(request));
```

### Express

```ts
import { toNodeHandler } from "better-auth/node";

app.all("/api/auth/*", toNodeHandler(auth));
```

## Database

New Better Auth managed database:

```bash
npx auth@latest migrate --config path/to/auth.ts
```

Drizzle or Prisma:

```bash
npx auth@latest generate --config path/to/auth.ts
```

Then review and run the app's normal database migration. For an existing subscription table,
backfill `subscription.seats` to `1` in that application-owned migration.

## Checkout return

```ts
await authClient.subscription.success({
  query: { subscriptionId },
});
```

After this call, refresh the subscription query or route data already used by the app.

## Server-side call

```ts
import { headers } from "next/headers";

const subscription = await auth.api.currentSubscription({
  query: { group: "main" },
  headers: await headers(),
});
```

Pass session headers to user and admin actions.

## Webhook signature only

Use this when the app does not use the webhook plugin:

```ts
import { verifyWebhook } from "better-auth-streampay";

const rawBody = await request.text();
const result = verifyWebhook({
  secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
  rawBody,
  signatureHeader: request.headers.get("X-Webhook-Signature"),
  toleranceSeconds: 300,
});

if (!result.ok) {
  return new Response("Invalid webhook", { status: 401 });
}
```
