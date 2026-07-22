# Troubleshooting

Read the server log first. Plugin messages start with `[streampay]`.

## Sign-up fails

When `createConsumerOnSignUp` is true, a StreamPay error can block sign-up.

Try the lazy default:

```ts
streampay({
  client,
  use,
});
```

If StreamPay already has the consumer, reuse it only after your app verifies the email or phone:

```ts
claimExistingConsumerBy: ["email"]
```

StreamPay sandbox may require the organization owner's exact email.

## Consumer ID is empty

This is normal with lazy consumer creation. The ID is added on the first checkout or subscription
upgrade.

If it stays empty after that:

1. Check that the database migration ran.
2. Check the StreamPay consumer call in server logs.
3. Confirm the user is not anonymous.

## Consumer linking returns 409 or 500

`STREAMPAY_CONSUMER_LINK_CONFLICT` means another local user owns that StreamPay consumer ID. Do not
overwrite either user row; resolve the account ownership conflict.

`STREAMPAY_CONSUMER_LINK_WRITE_FAILED` means the ownership read or link write could not be proven
safe. Check the database error and unique index, then retry after the database is healthy. Do not
bypass the failure by creating a client-supplied consumer link.

## Missing table or column

Load the plugin before generating the schema.

For Drizzle or Prisma:

```bash
npx @better-auth/cli generate --config path/to/auth.ts
```

Review and run the database migration.

## Endpoint returns 404

Check:

1. The needed part is in `streampay({ use: [...] })`.
2. Better Auth is mounted at `/api/auth/*`.
3. Next.js uses a catch-all route such as `[...all]`.

## Checkout rejects client fields

`CHECKOUT_CLIENT_FIELDS_FORBIDDEN` is expected when `resolveCheckout` is configured. Send only:

- `referenceId`
- `redirect`

Remove products, slugs, coupons, expiry, metadata, and redirect URLs from the browser request. There
is no client-field trust option to enable.

## Checkout resolution returns 500

For `Checkout resolution failed.`, inspect the logged resolver exception.

For `Checkout resolution produced invalid parameters.`, inspect the logged field paths and make the
resolver return values accepted by the checkout schema. The response intentionally omits schema
details.

Neither failure calls StreamPay.

## Checkout persistence fails

Inspect the `onCheckoutCreated failed` log and the payment link in StreamPay. The plugin attempts to
set the new link to `INACTIVE`, but compensation is best effort.

Map expected domain conflicts to `APIError("CONFLICT", ...)` inside `onCheckoutCreated`. Keep unknown
database errors as 500 responses, then reconcile the link through signed, idempotent webhook
handling.

## Admin endpoint returns 405

The route must accept:

- `GET`
- `POST`
- `PATCH`
- `PUT`
- `DELETE`

## Webhook returns 401

For `INVALID_SIGNATURE`:

1. Match the secret to the correct dashboard endpoint.
2. Use the exact raw request body.
3. Do not run a JSON body parser before the Better Auth route.

For `EXPIRED`:

1. Check the server clock.
2. Do not replay an old signed request.

Keep the normal five-minute limit unless StreamPay support tells you otherwise.

## Subscription does not update

Use both `subscriptions()` and `webhooks()`.

Check:

1. The webhook URL is correct.
2. The signature is accepted.
3. The webhook event row is completed.
4. The StreamPay subscription ID matches the local row.

Use the admin webhook actions to inspect or replay a failed event.

## UI still shows the old plan

On the checkout return page:

1. Call `subscriptionSuccess`.
2. Refresh the app's subscription query or route data.
3. Show an activating state while the webhook is still running.

Do not create a second client-side subscription store.

## Current subscription is null

`currentSubscription` only returns a plan that can use features.

The default allowed states are:

- `active`
- `trialing`
- `frozen`
- `past_due`

A new checkout starts as `incomplete`. Use `listSubscriptions` when the UI needs to show that
temporary state.

## Plan setup fails

Each plan needs:

- a unique name
- a unique recurring StreamPay product ID
- a whole-number price in the smallest currency unit
- a valid billing interval

Use the field named in the startup error.

## Duplicate side effects

StreamPay can send the same webhook again.

With subscription webhook tracking enabled, the plugin handles duplicates. Custom handlers
outside that flow must also use an event ID before doing work twice.

## Freeze request fails in sandbox

StreamPay keeps deleted freeze records. A new freeze cannot start before the end of that history.

List the freezes and choose a later start time, or use a clean sandbox subscription.

## Trial checkout returns failed_internal_error

Check the payment link, payment, invoice, and subscription in StreamPay before changing plugin
code. StreamPay sandbox can approve the test card and still fail before it creates those records.

If no provider record exists, save the payment link ID, redirect payment ID, and timestamp for
StreamPay support.
