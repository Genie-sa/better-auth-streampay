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
npx @better-auth/cli migrate --config path/to/auth.ts
```

Drizzle or Prisma:

```bash
npx @better-auth/cli generate --config path/to/auth.ts
```

Then run the app's normal database migration.

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
