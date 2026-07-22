---
name: better-auth-streampay-integration
description: Add better-auth-streampay to a Better Auth app. Use for checkout, billing portal, subscriptions, admin billing tools, signed webhooks, database setup, and plugin updates.
license: MIT
metadata:
  author: Genie-sa
  homepage: https://github.com/Genie-sa/better-auth-streampay
---

# Better Auth and StreamPay

Use this process to add or update the plugin.

## Sources

Read these before changing code:

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

- `better-auth ^1.5.0`
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

For server-authoritative checkout:

- use `resolveCheckout` so the client sends only an app-owned `referenceId` and `redirect`
- authorize the signed-in user against that reference before deriving products, quantities,
  coupons, expiry, metadata, and redirects
- use `onCheckoutCreated` for the app's idempotent payment-link write
- map expected app conflicts to `APIError`; leave unexpected failures as server errors

Do not add a client-field trust switch. Configuring `resolveCheckout` enables strict field rejection
automatically.

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

For Drizzle or Prisma, generate the Better Auth schema changes, review them, then run the app's
normal database migration.

Check that:

- `user.streampayConsumerId` exists with a unique constraint or index
- `subscription` exists when subscriptions are on
- `streampayWebhookEvent` exists when webhook tracking is on

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
- freeze and unfreeze
- current plan, feature, and limit reads
- direct server calls through `auth.api`

When server-authoritative checkout is enabled, also test:

- a valid reference produces the server-derived StreamPay payload and persists its payment-link ID
- a request containing product, coupon, expiry, metadata, or redirect fields is rejected before a
  StreamPay call
- invalid resolver output returns a generic 500 while the server log identifies invalid field paths
- persistence failure preserves an intentional `APIError` and triggers best-effort link deactivation

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
