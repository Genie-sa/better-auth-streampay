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

- `better-auth ^1.6.0`
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

Add `subscription.catalogMapped` with a default of `true` before deploying this version.
Better Auth 1.6's migration generator does not apply static defaults to added columns. Review
and backfill the column explicitly. For PostgreSQL with the default table name:

```sql
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS "catalogMapped" boolean DEFAULT true;
ALTER TABLE subscription ALTER COLUMN "catalogMapped" SET DEFAULT true;
UPDATE subscription SET "catalogMapped" = true WHERE "catalogMapped" IS NULL;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS "renewalCallbackEventId" text;
```

Use your configured table name and your database's boolean syntax when they differ. The column
remains nullable for rolling migrations; legacy null values preserve existing access until
reconciliation provides a catalog decision. Better Auth 1.6.0 is the minimum because 1.5's built-in
SQL adapter handles null comparisons incorrectly, breaking ungrouped reads and released leases.

Reconciliation sets it to `false` when Stream's current products do not match a configured plan;
billing details remain visible, but features and limits deny access. Dynamic plan factories
resolve on each resolution.

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

`portal()` adds signed-in user actions:

- `state`
- `subscriptions`
- `invoices`
- `portal.session` when hosted session creation is configured

```ts
const state = await authClient.consumer.state();
const subscriptions = await authClient.consumer.subscriptions.list();
const invoices = await authClient.consumer.invoices.list();
const nextInvoices = await authClient.consumer.invoices.list({ query: { page: 2, size: 10 } });
```

Invoice and subscription lists return Stream's `pagination` alongside `data`. The consumer filter
always comes from the signed-in account. `page` must be a positive safe integer; `size` is 1–100.
The plugin translates `size` to Stream's documented `limit` query parameter; SDK 1.1.3's
`size` parameter is ignored by the current API.

To open [Stream's hosted customer portal](https://docs.streampay.sa/customer-portal/), configure a
server-side session creator. Stream SDK 1.1.3 does not expose this endpoint yet:

```ts
portal({
  createSession: async (input) => {
    const response = await fetch(`${process.env.STREAMPAY_BASE_URL}/api/v2/consumer_portal/sessions`, {
      method: "POST",
      headers: {
        "x-api-key": process.env.STREAMPAY_API_KEY!,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw Object.assign(new Error("Portal session creation failed."), { status: response.status });
    }
    return response.json();
  },
});

// Frontend, using streampayClient():
const { data, error } = await authClient.consumer.portal.session();
if (error) throw new Error(error.message);
if (data) window.location.assign(data.url);
```

`POST /consumer/portal/session` resolves the consumer from the session and ignores consumer IDs
in the request. Missing consumers or configuration return 404; anonymous sessions are rejected.
Each request creates a fresh URL, requires HTTPS, and sends `Cache-Control: no-store`. Treat the
single-use URL as a credential: do not log, persist, or share it. Keep API keys on the server.

Enable customer permissions and branding in Stream's dashboard. Product switches require switch
groups; add-ons require catalog mappings. Stream controls proration and payment confirmation.
Keep webhook reconciliation enabled so portal changes update local subscription access. This
initial integration opens the consumer's portal; subscription deep links are not exposed. The
current OpenAPI omits the guide's `return_url` field, so the plugin does not send it.

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

SDK 1.1.3 cannot request later freeze pages. Configure `listSubscriptionFreezes` on the
server to enable complete freeze lookup for cancellation and unfreezing:

```ts
import { StreamSDKError } from "@streamsdk/typescript";

subscriptions({
  plans,
  listSubscriptionFreezes: async (subscriptionId, { page, limit }) => {
    const url = new URL(
      `/api/v2/subscriptions/${encodeURIComponent(subscriptionId)}/freeze`,
      process.env.STREAMPAY_BASE_URL!,
    );
    url.search = new URLSearchParams({
      page: String(page), limit: String(limit),
      sort_field: "created_at", sort_direction: "asc",
    }).toString();
    const response = await fetch(url, {
      headers: { "x-api-key": process.env.STREAMPAY_API_KEY! },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new StreamSDKError("Freeze history request failed", {
        status: response.status, body,
      });
    }
    return body;
  },
});
```

The callback receives only an authorized subscription ID. Return the API's complete page
response, including pagination. The plugin requests up to 100 entries per page and searches
up to 100 pages, stopping when it finds the freeze. Invalid or nonadvancing pages return 409;
API failures propagate without reporting cancellation. Without this callback, the plugin uses
the SDK's first page and retains the safe latest-freeze fallback or 409 for unresolved history.

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
  deduplicate: true,

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

`deduplicate: true` also persists generic handler deliveries in `streampayWebhookEvent`, including
unknown event envelopes. Apply the inbox table migration before enabling it. Handler receipts use
the `handlers:` event ID prefix and support the existing authenticated admin replay endpoint.
The default is `false` to preserve existing installations that have no inbox table.

Verified payloads are persisted when processing is claimed, so an interrupted delivery can be
recovered after its lease expires. Callbacks must still be idempotent: a crash after an external
side effect, or failure of a later callback, can repeat earlier work on retry. Inbox deduplication
does not provide exactly-once execution of external side effects.

Typed handlers include `onPaymentPartiallyRefunded` and `onSubscriptionCycleRenewedSuccessfully`.
Successful renewal events reconcile billing state and share renewal inference with completed
invoices. The cycle update records its callback owner in `renewalCallbackEventId`; an interrupted
owner can resume on replay, and competing events cannot take its pending callback. Apply this
nullable column before deploying. External callback side effects still need idempotency.

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

## Local staging demo

The demo uses Node 22's SQLite support, real Better Auth sessions, and a Stream sandbox organization.
It binds to `127.0.0.1:3100`; the tunnel exposes only signed webhook ingress. Credentials and local
state are ignored by Git. It is a single-account test harness, not a deployable application.

Copy `examples/demo/.env.example` to `.env.local` in the same directory, fill in sandbox credentials
and the recurring starter product ID, and generate distinct random auth and webhook secrets.

```bash
pnpm build
pnpm demo:setup
pnpm demo
# In another terminal:
cloudflared tunnel --url http://localhost:3100 --no-autoupdate
pnpm demo:setup https://YOUR-TUNNEL.trycloudflare.com
```

Open `http://localhost:3100`, create a local account, then run `pnpm demo:exercise`. The script
creates a dedicated free trial with notifications disabled, and sends an explicitly synthetic
signed event twice to correlate that fixture with the local account. Provider-created events
arrive separately through the registered webhook. Creating a subscription directly through the
Stream API does not include the plugin's checkout correlation metadata automatically.

The setup command creates or updates only the webhook saved in the demo's state file and
synchronizes its signing secret, including after rotation. When done,
run `pnpm demo:cleanup` to cancel its trial and remove its webhook, then stop the server and tunnel.
Cleanup also requests cancellation of a saved paid validation subscription, if present. Stream
cancels active subscriptions at period end; cleanup retains their state files until cancellation
completes. It retains the dedicated consumer and local database.

Validation on 2026-10-10 used Better Auth 1.7.7 and Stream SDK 1.1.3. Tests also ran on Node
20.19.0 and 24.21.0, and in an isolated Better Auth 1.6.0 / Zod 3.24 installation. PostgreSQL
17 tests run against a temporary schema and cover concurrent claims, expired-lease replay,
stale worker fencing, simultaneous renewal evidence, and migration/backfill of an existing row.

```bash
STREAMPAY_TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/TEST_DATABASE pnpm test:postgres
```

Dependency builds are explicit in `pnpm-workspace.yaml`: esbuild is allowed; optional lefthook
and MSW dependency scripts are disabled. The root prepare script installs the Git hooks.

The PostgreSQL suite owns a randomly named schema and drops it afterward. CI runs it in a
separate PostgreSQL service. Use a test database, not the application's staging or production database.

See [staging validation](docs/staging-validation.md) for the live coverage, regression evidence,
provider discrepancies and remaining limits.

## License

MIT
