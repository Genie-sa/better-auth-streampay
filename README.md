# better-auth-streampay

Add StreamPay checkout, billing, and signed webhooks to a Better Auth app. This is a community
plugin and is not affiliated with Stream.

The plugin supports hosted checkout, consumer records, subscription plans and access checks, a
consumer billing portal, admin billing actions, and webhook verification and replay.

For advanced checkout, consumer matching, portal, subscription lifecycle, admin, and webhook
examples, see the [integration guide](docs/integration.md). For subscription columns and upgrade
migrations, see the [subscription data model](docs/subscriptions.md).

## Requirements

- Node.js `>=20.19.0`
- Better Auth `^1.6.0`
- Stream SDK `@streamsdk/typescript ^1.1.3`
- Zod `^3.24.0` or `^4.0.0`

Install the plugin and SDK with your package manager:

```bash
pnpm add better-auth-streampay @streamsdk/typescript
```

Keep Better Auth and Zod installed in your app. Set `STREAMPAY_API_KEY` on the server. Add
`STREAMPAY_WEBHOOK_SECRET` when you enable webhook handling.

## Server setup

Create one SDK client and register the plugin with the features your app uses. This example enables
checkout and signed webhooks.

```ts
import StreamSDK from "@streamsdk/typescript";
import { betterAuth } from "better-auth";
import { checkout, streampay, webhooks } from "better-auth-streampay";

const client = StreamSDK.init(process.env.STREAMPAY_API_KEY!);

export const auth = betterAuth({
  plugins: [
    streampay({
      client,
      use: [
        checkout({
          products: [{ slug: "starter", productId: "your-payment-product-id" }],
          authenticatedUsersOnly: true,
        }),
        webhooks({ secret: process.env.STREAMPAY_WEBHOOK_SECRET! }),
      ],
    }),
  ],
});
```

Register your webhook endpoint in the StreamPay dashboard. With the default Better Auth base path,
use:

```text
https://your-app.com/api/auth/streampay/webhooks
```

Keep API keys and webhook secrets on the server. Do not put them in browser code.

## Client setup

For React, register the client plugin:

```ts
import { createAuthClient } from "better-auth/react";
import { streampayClient } from "better-auth-streampay/client";

export const authClient = createAuthClient({
  plugins: [streampayClient()],
});
```

Use the matching Better Auth client package for Vue, Svelte, or Solid. Open a hosted checkout link
with:

```ts
const { data, error } = await authClient.checkout({ slug: "starter", redirect: false });
if (error) throw new Error(error.message);
if (data) window.location.assign(data.url);
```

## Database setup

The plugin declares Better Auth schema fields. It does not change your database at runtime. Generate
and apply a migration before deploying the plugin:

```bash
npx auth@latest generate --config path/to/auth.ts
```

For a Better Auth managed database, use `npx auth@latest migrate --config path/to/auth.ts` instead.
Review generated changes and apply them with your normal database migration process.

For an existing installation, review the [database upgrade instructions](docs/integration.md#database)
and [subscription migrations](docs/subscriptions.md#migration). Apply new columns and backfill
existing rows before deploying. Resolve duplicate non-null `streampayConsumerId` values before applying
the unique index. If you enable generic webhook deduplication, migrate the `streampayWebhookEvent`
table before setting `deduplicate: true`.

## Billing portal

`portal()` adds authenticated consumer state, subscription, and invoice endpoints. Stream SDK 1.1.3
does not provide hosted portal session creation. To open Stream's hosted portal, configure the
server-side `createSession` callback with the REST endpoint. The [integration guide](docs/integration.md#billing-portal)
has a working bridge example and client call. The callback receives the consumer ID resolved from
the signed-in session.

## Security and access

Checkout can require an authenticated session with `authenticatedUsersOnly`. Cross-account
subscription actions require an `authorizeReference` callback. Webhook signatures are checked
against the configured secret, and signature age is bounded by the webhook tolerance setting.

Subscription features and limits default to access for `active`, `trialing`, `frozen`, and
`past_due` states. Set `accessStatuses` to use a different policy. When provider products no longer
match a configured plan, billing details remain readable while feature and limit checks deny access.

## Checks and coverage

Run the repository checks with:

```bash
pnpm check
```

`pnpm test` excludes live StreamPay tests. `pnpm test:coverage` measures local source coverage, but
does not prove behavior against StreamPay. `pnpm test:postgres` uses a dedicated test database for
database-specific behavior. Live provider coverage, test limits, and validation details are in
[staging validation](docs/staging-validation.md).

## License

MIT
