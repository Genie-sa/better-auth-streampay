---
name: better-auth-streampay-integration
description: Integrate better-auth-streampay for checkout, subscriptions, organization billing, server-initiated billing for another user or org, admin tools, signed webhooks, or database changes.
license: MIT
metadata:
  author: Genie-sa
  homepage: https://github.com/Genie-sa/better-auth-streampay
---

# Better Auth and StreamPay

Use this process to add or update the plugin.

## Sources

Read before changing code:

1. The app's auth, database, routes, client, and payment code.
2. The installed package types in `node_modules/better-auth-streampay/dist`.
3. The package [README](https://github.com/Genie-sa/better-auth-streampay#readme).

Use the installed types for exact options and return values.

Load [code-templates.md](references/code-templates.md) only when you need setup or route examples.
When checkout values come from app-owned orders, load its **Server-authoritative checkout** section
before editing the auth config.

Load [troubleshooting.md](references/troubleshooting.md) only after a check fails.

## 1. Inspect the app

Find:

- the file that calls `betterAuth()`
- the Better Auth client file
- the database tool, such as Drizzle or Prisma
- the auth route
- the package manager
- the environment file
- any current payment code
- the page users return to after checkout

Check the installed versions. The plugin needs:

- `better-auth ^1.6.23`
- `@streamsdk/typescript ^1.1.3`
- `zod ^3.24.0 || ^4.0.0`

This step is done when every item above is known or does not exist.

## 2. Pick the needed parts

Use only what the app needs:

| Part | Use it for |
| --- | --- |
| `checkout()` | Hosted payment links |
| `portal()` | User billing reads |
| `subscriptions()` | Plans, access, limits, and subscription actions |
| `admin()` | Staff billing actions |
| `webhooks()` | Signed event handling and subscription sync |

Do not add `admin()` unless the app has a real admin check.

Who pays is fixed, not configured: **HTTP endpoints bill the signed-in user; server-only
endpoints bill the reference** (a user or an organization). When the app must bill someone
other than the signed-in user — admin tools, cron jobs, webhook-driven flows — use the
server-only endpoints `upgradeSubscriptionForReference` and `checkoutForReference`. They have
no HTTP route; the app's own server code is the gate.

Turn on `organization: { enabled: true }` in the `streampay()` options only when the app bills
organizations. It adds a `streampayConsumerId` column to the organization model.

Use lazy consumer creation by default. Enable `createConsumerOnSignUp` only when StreamPay
consumer creation should be allowed to block sign-up.

Ask the user only when the repo cannot answer a product choice, such as which plans or admin roles
to use.

This step is done when each selected part has a clear reason.

## 3. Add the server plugin

Create one StreamPay SDK client outside request handlers.

Add `streampay()` to the existing Better Auth plugin list. Keep the app's current auth structure.
Do not rewrite a factory into a new pattern.

Add the selected parts to `use`.

For subscriptions:

- use real recurring StreamPay product IDs
- use unique plan names and product IDs
- store prices in the smallest currency unit
- use a group when plans replace each other
- add `authorizeReference` for organization or custom references
- configure billed quantity with `seatBilling`, not entitlement `limits`
- set explicit minimum and maximum bounds when `customerEditable` is true

For server-authoritative checkout:

- use `resolveCheckout` so the client sends only an app-owned `referenceId` and `redirect`
- authorize the signed-in user against that reference before deriving products, quantities,
  coupons, expiry, metadata, and redirects
- use `onCheckoutCreated` for the app's idempotent payment-link write
- map expected app conflicts to `APIError`; leave unexpected failures as server errors

Do not add a client-field trust switch. Configuring `resolveCheckout` enables strict field rejection
automatically.

For server-only billing (billing another user or an organization):

- call `auth.api.upgradeSubscriptionForReference` or `auth.api.checkoutForReference` from
  server code only, after the app's own permission check
- never expose these calls through an unauthenticated route
- for organizations, add `organization.getBillingDetails` when the StreamPay account requires
  contact fields on consumers; the plugin owns `name`, `email`, and `external_id`
- deliver the returned payment link to whoever completes payment

Load the **Bill another user or organization** section of
[code-templates.md](references/code-templates.md) for the exact shapes.

For webhooks:

- read the secret from server environment
- never expose it to the browser
- add only handlers the app needs
- make custom handler side effects idempotent by StreamPay event ID; built-in event tracking
  deduplicates subscription sync, not arbitrary custom effects

This step is done when the auth file typechecks, all selected parts appear once, and no
server-authoritative checkout field is accepted from the client.

## 4. Add the client and route

Add `streampayClient()` to the existing Better Auth client.

Keep the current framework client import, such as React, Vue, Svelte, or Solid.

Make sure the Better Auth route accepts every HTTP method used by the selected parts. Admin tools
need `PATCH`, `PUT`, and `DELETE`.

The webhook URL is:

```text
/api/auth/streampay/webhooks
```

This step is done when the client types include the selected actions and the route accepts them.

## 5. Update the database

Load the plugin before generating a schema.

For a new Better Auth managed database, run the Better Auth migration command.

For an existing database (and always for Drizzle or Prisma), generate the Better Auth schema
changes, review them, then run the app's normal database migration. Do not let the plugin run DDL
at startup or request time.

Check that:

- `user.streampayConsumerId` exists with a unique constraint or index
- `organization.streampayConsumerId` exists when organization billing is on
- `subscription` exists when subscriptions are on
- `streampayWebhookEvent` exists when webhook tracking is on
- `subscription.seats` is backfilled to `1` when upgrading existing subscription rows

Before adding the unique consumer index to an existing database, query for duplicate non-null
consumer IDs and resolve every duplicate. Do not apply the index until that query returns no rows.

This step is done when the migrated database, not only the generated schema, contains every
selected table, column, and unique constraint.

## 6. Handle checkout return

On the success page:

1. Call `authClient.subscription.success` with the local subscription ID.
2. Refresh the subscription data already used by the app.
3. Show a short activating state while the webhook is still in flight.

Follow the app's current cache or router pattern. Do not add a second state system.

This step is done when a completed checkout updates the visible plan without a manual reload.

## 7. Verify

Run:

1. typecheck
2. tests
3. production build
4. database checks
5. sandbox checkout
6. signed webhook delivery

When subscriptions are enabled, also test:

- duplicate checkout reuse
- active cancellation and uncancel
- plan change and pending-change cancellation
- fixed/editable seat checkout, seat updates, and current/pending reconciliation
- freeze and unfreeze
- current plan, feature, and limit reads
- direct server calls through `auth.api`

When server-authoritative checkout is enabled, also test:

- a valid reference produces the server-derived StreamPay payload and persists its payment-link ID
- a request containing product, coupon, expiry, metadata, or redirect fields is rejected before a
  StreamPay call
- invalid resolver output returns a generic 500 while the server log identifies invalid field paths
- persistence failure preserves an intentional `APIError` and triggers best-effort link deactivation

When server-only billing is enabled, also test:

- the payment link is billed to the reference's consumer, not the caller's
- an organization gets one consumer, stored on its row and reused on the next checkout
- the app route that calls these endpoints rejects callers without permission

For authenticated consumer creation, confirm a database read or write failure aborts the request
and two local users cannot retain the same StreamPay consumer ID.

For custom webhook effects, replay the same signed event and confirm the effect happens once.

Check the database and logs after each action.

This step is done only when every selected flow has a result and no required process is still
running.

## Finish

Report:

- files changed
- migration command or SQL script used
- checks run
- sandbox results
- any StreamPay action that could not be tested

Do not claim a StreamPay action passed when only a mock passed.
