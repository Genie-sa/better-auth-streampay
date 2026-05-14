# When something goes wrong

The common things that trip people up. If a symptom isn't here, don't
guess — read the plugin source under
`node_modules/better-auth-streampay/dist` or check the repo at
https://github.com/Genie-sa/better-auth-streampay.

When you're explaining a fix to a user, lead with what's happening
and why before the command — they'll understand the next failure
better.

## "Account cannot be created at this time" on sign-up

**What's happening**: StreamPay already has a customer with this email
or phone, and it's linked to a different user. The plugin won't move
billing history to a new account silently.

**Fix it**: ask the user one of:

- Keep it the way it is — they should recover their original account
- Reuse on email match: set `claimExistingConsumerBy: ["email"]`
- Reuse on phone match: `["phone"]`
- Reuse on either: `["email", "phone"]`

Only enable reuse when sign-up actually verifies the matching field.

## Webhook returns 401 / "INVALID_SIGNATURE"

**What's happening**: the signature StreamPay sent doesn't match what
the plugin computes from the request body.

Common causes:

- The webhook secret in env doesn't match the one in the dashboard for THIS endpoint
- A body-parsing middleware is rewriting the JSON before the plugin sees it (the signature only works on the exact bytes StreamPay sent)
- Wrong env (sandbox secret in prod, or vice versa)

**Fix**: regenerate the secret in the dashboard, paste it into env exactly, and make sure no parser runs before `/api/auth/streampay/webhooks`.

## Webhook returns 401 / "EXPIRED"

**What's happening**: the timestamp on the signature is older than the
tolerance window (default 5 minutes).

Usually one of:

- Server clock is way off (NTP isn't running)
- Someone replayed an old payload during testing

Don't push tolerance past ~10 minutes in prod — that weakens replay protection.

## `user.streampayConsumerId` is still null after sign-up

A few possibilities:

- `createConsumerOnSignUp` is `false` (the lazy default) — the column will fill in on first checkout/upgrade, not at sign-up
- The migration didn't actually run, so the column doesn't exist
- The BYO schema gotcha (see the next entry)
- StreamPay's `createConsumer` call threw — check server logs
- The user is anonymous — the plugin intentionally skips anonymous sessions; the customer is created when they upgrade to a real account

## The plugin compiles but inserts fail with "no such column" or "no such table"

**What's happening**: the project uses a custom Drizzle or Prisma
schema (`drizzleAdapter(db, { schema })` or explicit Prisma models),
so Better Auth used those tables as-is. The plugin's
`streampayConsumerId` column and `subscription` /
`streampayWebhookEvent` tables didn't get added.

**Fix**: regenerate the schema with the plugin loaded:

```
npx @better-auth/cli generate --config <path/to/auth.ts>
```

Review the diff (the CLI updates schema files), then run the ORM
migration. Repeat any time you add or remove sub-plugins.

## Where do I point `--config` in a monorepo?

At the package that calls `betterAuth(...)`. Example:

```
npx @better-auth/cli generate --config packages/auth/src/index.ts
```

The CLI imports the file and reads its `auth` export, so the path has
to resolve through the workspace's tsconfig and module resolution.

## `authClient.checkout(...)` returns 404

Usually one of:

- The Better Auth handler isn't mounted (or is mounted at a non-default path)
- `checkout()` isn't in the `use: [...]` array
- Framework route is wrong — Next.js needs `[...all]`, not `[...]`

## Admin endpoint returns 405 (Method Not Allowed)

The handler is mounted but only registers GET + POST. Admin endpoints
use PATCH, PUT, and DELETE. Widen the methods. For Next.js:

```ts
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(auth)
```

For Hono, change `["POST", "GET"]` to `["GET", "POST", "PATCH", "PUT", "DELETE"]`.

## Subscriptions plugin throws at startup

The plan catalog has something wrong — duplicate plan name, missing
`productId`, mismatched `billingInterval`, etc. The error message tells
you exactly which plan and which field. Show it to the user as-is —
that's more helpful than a paraphrase.

## Subscription state slowly drifts from StreamPay

The `subscriptions()` plugin needs `webhooks()` to stay in sync.
Without webhooks, the local table only updates when the user does
something. Add `webhooks()` to `use: [...]` and re-test.

## Same payment processed twice (duplicate side effects)

StreamPay redelivers on timeout AND on some transient errors.

- With `subscriptions()` enabled, the plugin uses
  `streampayWebhookEvent` to dedupe — you're covered.
- Without it, key your handler's mutations on `entity_id +
  event_type` so a redelivery is a no-op.

## Peer dependency warning on install

Plugin needs `better-auth ^1.4.0` and `zod ^3.24 || ^4.0`. Older
`better-auth` will break — ask the user to upgrade Better Auth
first.

## `/subscription/current` returns `null` right after upgrade

**What's happening**: the endpoint intentionally filters to live
entitlements — only `active | frozen | past_due`. Between
`/subscription/upgrade` (creates the `incomplete` row + payment link)
and the `SUBSCRIPTION_ACTIVATED` webhook landing, the row is
`incomplete` and is hidden from `/subscription/current`.

**Fix**: if the UI needs to render "your subscription is being
activated" during the gap, call `/subscription/list` and filter for
`status === "incomplete"` yourself. Don't change the
`/subscription/current` shape.

## Known sandbox quirks

These bite every new integrator on StreamPay's sandbox. Mention them
proactively when the user is setting up dev.

- **Consumer email lock**: sandbox refuses consumer creation for
  emails that don't match the org-owner's email. Symptom: `400
  DUPLICATE_CONSUMER` or `CONSUMER_CREATE_FAILED` on signup with
  arbitrary test emails. Fix: sign up with the org-owner email for
  the first happy-path test, OR run `claimExistingConsumerBy:
  ["email"]` if a stranded sandbox consumer is in the way.
- **Stranded consumers persist across test sessions**: deleting the
  Better Auth user does NOT delete the StreamPay consumer. Retrying
  signup with the same email hits `DUPLICATE_CONSUMER`. Either delete
  the consumer from the StreamPay dashboard or enable
  `claimExistingConsumerBy`.
- **`cancel_at_period_end` is a one-way door**: StreamPay's API
  doesn't expose an "unschedule" action. Once a sub is scheduled to
  cancel at period end, you can't promote it back to "renew" via API
  — the only escape is letting it expire then re-upgrading. Set
  expectations with the user before they wire a cancel UI.
- **Sandbox subscription state survives restarts**: don't assume a
  fresh DB means a fresh upstream. Always query StreamPay
  (`listSubscriptions`) for the consumer when debugging "why is my
  signup blocked".

## Filtering plugin logs

Every line the plugin emits is prefixed with `[streampay]` (inside
Better Auth's outer `[Better Auth]:` wrapper). A single regex on
`\[streampay\]` catches every plugin log line regardless of level.

Useful when piping dev logs through `grep` or wiring a structured
log filter in production.
