# Code templates

Copy-and-adapt snippets. Always check the option names against the
plugin source before pasting — these summaries can lag behind the
real types.

## Installing

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

In a monorepo, install in the workspace that owns the auth file (e.g.
`packages/auth`), not at the root. Make sure `better-auth ^1.4.0` and
`zod ^3.24 || ^4` are present.

## Environment

`.env` (or `.env.local`, or `apps/server/.env` in a monorepo — match
where Better Auth is reading from):

```
STREAMPAY_API_KEY=
# only when webhooks() is enabled:
STREAMPAY_WEBHOOK_SECRET=
# Better Auth basics:
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
```

Mirror in `.env.example` with empty values. See
[env-setup.md](env-setup.md) for sources and rules.

## Server (`auth.ts`)

Use only the sub-plugins the user picked. See
[plugins-overview.md](plugins-overview.md) for what each one does and
[plugin-reference.md](plugin-reference.md) for the option list.

```ts
import { betterAuth } from "better-auth"
import StreamSDK from "@streamsdk/typescript"
import {
  streampay,
  checkout,
  portal,
  subscriptions,
  admin,
  webhooks,
} from "better-auth-streampay"

const streamPayClient = StreamSDK.init(process.env.STREAMPAY_API_KEY!)

export const auth = betterAuth({
  // ...existing config
  plugins: [
    streampay({
      client: streamPayClient,
      // createConsumerOnSignUp: true,
      // claimExistingConsumerBy: ["email"],
      // getConsumerCreateParams: async ({ user }, request) => ({ /* ... */ }),
      use: [
        checkout({
          products: [
            // { productId: "uuid", slug: "pro" },
          ],
          successUrl: "/dashboard?checkout=success",
          failureUrl: "/dashboard?checkout=failure",
          authenticatedUsersOnly: true,
        }),
        portal(),
        subscriptions({
          plans: [
            // {
            //   name: "pro-monthly",
            //   productId: "uuid",
            //   priceHalalat: 9900,
            //   billingInterval: "MONTH",
            // },
          ],
          // onSubscriptionActivated: async ({ subscription, user }) => { /* ... */ },
        }),
        admin({
          // adminRoles: ["admin"],
          // isAdmin: (user) => user.email?.endsWith("@yourco.com") ?? false,
        }),
        webhooks({
          secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
          // onPayload: async (p) => logger.info("streampay webhook", p.event_type),
          onPaymentSucceeded: async (p) => {
            // TODO
          },
          onSubscriptionActivated: async (p) => {
            // TODO
          },
          onSubscriptionCanceled: async (p) => {
            // TODO
          },
        }),
      ],
    }),
  ],
})
```

Trim `use: [...]` to whatever the user picked. Drop
`getConsumerCreateParams` entirely if there are no custom fields.
Don't include `admin()` unless the user asked — it exposes
back-office endpoints.

### Factory pattern (e.g. Better-T-Stack)

Some starters wrap the call in a function. Keep that shape; just add
the plugin to the inner `plugins: [...]`:

```ts
export function createAuth() {
  const db = createDb()
  const streamPayClient = StreamSDK.init(process.env.STREAMPAY_API_KEY!)
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    // ...rest
    plugins: [
      streampay({ client: streamPayClient, use: [/* ... */] }),
    ],
  })
}

export const auth = createAuth()
```

## Better Auth CLI

Two commands, depending on how the project manages its schema.

```
# If the project uses its own Drizzle/Prisma schema (BYO), update the
# schema files first, then run the ORM migration:
npx @better-auth/cli generate --config <path/to/auth.ts>

# If Better Auth manages the schema directly (no BYO), one command:
npx @better-auth/cli migrate --config <path/to/auth.ts>
```

`--config` points at the file that calls `betterAuth(...)`. In a
monorepo:

```
npx @better-auth/cli generate --config packages/auth/src/index.ts
```

## Client (`auth-client.ts`)

```ts
import { createAuthClient } from "better-auth/react" // or /vue, /svelte, /solid
import { streampayClient } from "better-auth-streampay/client"

export const authClient = createAuthClient({
  plugins: [streampayClient()],
})
```

Match the existing framework variant — don't switch.

## Framework routes

Plugin endpoints live under `/api/auth/*` via Better Auth's handler.
If the handler is already mounted, you don't need to add anything —
just make sure all HTTP methods are accepted (admin endpoints use
PATCH, PUT, and DELETE).

### Next.js App Router

```ts
// app/api/auth/[...all]/route.ts
import { auth } from "@/lib/auth"
import { toNextJsHandler } from "better-auth/next-js"
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(auth)
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
app.on(["GET", "POST", "PATCH", "PUT", "DELETE"], "/api/auth/*", (c) => auth.handler(c.req.raw))
```

If the existing app limits methods (e.g. `app.on(["POST", "GET"], ...)`), widen them. Admin endpoints will 405 otherwise.

### Elysia

```ts
new Elysia().all("/api/auth/*", ({ request }) => auth.handler(request))
```

### Express

```ts
import { toNodeHandler } from "better-auth/node"
app.all("/api/auth/*", toNodeHandler(auth))
```

The webhook URL once mounted: `/api/auth/streampay/webhooks` —
register THAT in the StreamPay dashboard.

## Migrations

Once the auth file is updated:

| Tool | Command |
|---|---|
| Better Auth CLI | `npx @better-auth/cli migrate` |
| Drizzle | `npx drizzle-kit generate && npx drizzle-kit migrate` (or `bun run db:push`) |
| Prisma | `npx prisma migrate dev --name streampay` |

After migration, confirm `user.streampayConsumerId` exists. If
`subscriptions()` is enabled, also confirm `subscription` and
`streampayWebhookEvent` tables exist.

## Verifying webhooks without the plugin

If the user wants signature verification but doesn't want to wire the
whole plugin:

```ts
import { verifyWebhook } from "better-auth-streampay"

const result = verifyWebhook({
  secret: process.env.STREAMPAY_WEBHOOK_SECRET!,
  rawBody: await request.text(),
  signatureHeader: request.headers.get("X-Webhook-Signature"),
  toleranceSeconds: 300,
})

if (!result.ok) return new Response(`invalid: ${result.reason}`, { status: 400 })
```
