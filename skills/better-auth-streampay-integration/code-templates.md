# Code Templates

Copy-adapt snippets for Phases 3–8. Replace placeholders, don't paste verbatim.

## Dependencies

```
# bun
bun add better-auth-streampay @streamsdk/typescript
# pnpm
pnpm add better-auth-streampay @streamsdk/typescript
# yarn
yarn add better-auth-streampay @streamsdk/typescript
# npm
npm i better-auth-streampay @streamsdk/typescript
```

Ensure `better-auth` and `zod` are already present (peer deps). Add them if missing.

## Environment

`.env` (or `.env.local`):

```
STREAMPAY_API_KEY=
# only if webhooks() is enabled:
STREAMPAY_WEBHOOK_SECRET=
# Better Auth already needs these:
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
```

`.env.example` should match but without values. Never write a real secret to disk.

## Server (`auth.ts`)

Minimal shape, composed from the interview answers. Include only the sub-plugins the user picked.

```ts
import { betterAuth } from "better-auth"
import StreamSDK from "@streamsdk/typescript"
import {
  streampay,
  checkout,
  portal,
  subscriptions,
  webhooks,
} from "better-auth-streampay"

const streamPayClient = StreamSDK.init(process.env.STREAMPAY_API_KEY!)

export const auth = betterAuth({
  // ...existing config (database, emailAndPassword, etc.)
  plugins: [
    streampay({
      client: streamPayClient,
      // `createConsumerOnSignUp` defaults to `false` (lazy — the consumer
      // is created on the first authenticated checkout or subscription
      // mutation). Set to `true` if your product needs portal data
      // immediately after signup, before any payment has happened.
      // createConsumerOnSignUp: true,
      claimExistingConsumerBy: [], // or ["email"], ["phone"], ["email", "phone"]
      getConsumerCreateParams: async ({ user }, request) => ({
        // TODO: source these from request/db/session
        phone_number: undefined,
        preferred_language: undefined,
      }),
      use: [
        checkout({
          products: [
            // { productId: "aaaa-bbbb-cccc-dddd", slug: "pro" },
          ],
          successUrl: "/dashboard?checkout=success",
          failureUrl: "/dashboard?checkout=failure",
          authenticatedUsersOnly: true,
        }),
        portal(),
        subscriptions(),
        webhooks({
          secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
          onPaymentSucceeded: async (p) => {
            // TODO: provision access
          },
          onSubscriptionCanceled: async (p) => {
            // TODO: revoke access
          },
        }),
      ],
    }),
  ],
})
```

Trim the `use: [...]` array to match the selected sub-plugins. Drop `getConsumerCreateParams` entirely if no custom fields were selected.

## Client (`auth-client.ts`)

```ts
import { createAuthClient } from "better-auth/react" // or /vue, /svelte, /solid
import { streampayClient } from "better-auth-streampay/client"

export const authClient = createAuthClient({
  plugins: [streampayClient()],
})
```

Use whichever framework entry the app already uses. Don't switch it.

## Framework routes

The plugin's endpoints are served through Better Auth's `handler`. You almost always already have this mounted — just verify.

### Next.js App Router

```ts
// app/api/auth/[...all]/route.ts
import { auth } from "@/lib/auth"
import { toNextJsHandler } from "better-auth/next-js"

export const { GET, POST } = toNextJsHandler(auth)
```

### Next.js Pages Router

```ts
// pages/api/auth/[...all].ts
import { auth } from "@/lib/auth"
import { toNodeHandler } from "better-auth/node"

export default toNodeHandler(auth)
```

### Hono

```ts
import { Hono } from "hono"
import { auth } from "./auth"

const app = new Hono()
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
```

### Elysia

```ts
import { Elysia } from "elysia"
import { auth } from "./auth"

new Elysia()
  .all("/api/auth/*", ({ request }) => auth.handler(request))
```

### Express

```ts
import express from "express"
import { toNodeHandler } from "better-auth/node"
import { auth } from "./auth"

const app = express()
app.all("/api/auth/*", toNodeHandler(auth))
```

Once mounted, the webhook endpoint is available at `/api/auth/streampay/webhooks` — register THAT URL in the StreamPay dashboard.

## Migrations

Column added: `user.streampayConsumerId TEXT NULL`. Run one of:

| Tool | Command |
|---|---|
| Better Auth CLI | `npx @better-auth/cli migrate` |
| Drizzle | `npx drizzle-kit generate && npx drizzle-kit migrate` |
| Prisma | `npx prisma migrate dev --name streampay_consumer_id` |

If the ORM owns the schema (Drizzle/Prisma), verify `user` includes the column after regeneration.

## Standalone webhook verification (outside Better Auth)

If the user doesn't want the `webhooks()` sub-plugin but still needs verification:

```ts
import { verifyWebhook } from "better-auth-streampay"

const result = verifyWebhook({
  secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
  rawBody: await request.text(),
  signatureHeader: request.headers.get("X-Webhook-Signature"),
  toleranceSeconds: 300,
})

if (!result.ok) {
  return new Response(`invalid: ${result.reason}`, { status: 400 })
}
```

Reasons: `MISSING_HEADER | MALFORMED_HEADER | INVALID_TIMESTAMP | EXPIRED | INVALID_SIGNATURE`.
