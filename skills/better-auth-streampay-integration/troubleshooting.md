# Troubleshooting

The failure modes this integration hits most often, with root cause and fix. If a user reports something not listed here, don't guess — read the plugin source at https://github.com/y0u-0/better-auth-streampay.

## Sign-up throws "account cannot be created at this time"

**Symptom**: Sign-up fails with that generic message when StreamPay has an existing consumer at the same email/phone.

**Cause**: `DUPLICATE_CONSUMER` from StreamPay. The existing consumer is already linked to another Better Auth user (its `external_id` is set and differs), and `claimExistingConsumerBy` is unset or `null`. The plugin refuses to silently hand user A access to user B's billing history.

**Fix options**:
1. **Intended behavior** — tell the user to recover the original account.
2. **Reclaim by email** — set `claimExistingConsumerBy: "email"`. Rewrites `external_id` to the new user. Only safe if email ownership is verified.
3. **Reclaim by phone** — `"phone"`. Same caveat.
4. **Reclaim by either** — `"both"`. Most permissive; highest risk.

Security note: reclaim is a trade-off. Enable only when the app owns the identity signal (verified email, verified phone). Don't enable on public sign-up with no verification.

## Webhook endpoint returns 400 `INVALID_SIGNATURE`

**Symptom**: StreamPay dashboard shows delivery failures. Server logs show `INVALID_SIGNATURE`.

**Causes**:
- Secret mismatch — the `STREAMPAY_WEBHOOK_SECRET` env doesn't match the dashboard value.
- Body was modified in transit (body parser re-serialized JSON). The plugin verifies the RAW body — any middleware that re-serializes breaks the HMAC.
- Wrong secret for the environment (test vs prod).

**Fix**: rotate the secret from the dashboard, copy it verbatim, and ensure no body parser runs before the Better Auth handler on `/api/auth/streampay/webhooks`.

## Webhook returns `EXPIRED`

**Symptom**: Signature header is valid but the timestamp is older than `toleranceSeconds` (default 300s).

**Causes**:
- Severe clock skew on the server.
- Manual replay of an old payload during testing.

**Fix**: sync NTP. Don't crank `toleranceSeconds` up past 600 in prod — you'd weaken replay protection.

## Sign-up succeeds but `user.streampayConsumerId` is `null`

**Causes**:
- `createConsumerOnSignUp` is `false`. Set to `true`.
- The migration didn't run, and the column doesn't exist. Run the ORM migration (see [code-templates.md](code-templates.md) §Migrations).
- StreamPay `createConsumer` threw; check server logs for the formatted error.
- The user is anonymous — the plugin intentionally skips anonymous sessions; consumers are created on upgrade.

## Client `authClient.checkout(...)` returns 404

**Causes**:
- Better Auth handler isn't mounted (or is mounted at a non-default path). The plugin endpoints live under `/api/auth/...` by default.
- `checkout()` wasn't added to the `use: [...]` array.
- Framework route glob is wrong (e.g., `/api/auth/[...]/route.ts` instead of `/api/auth/[...all]/route.ts` in Next.js).

## `authenticatedUsersOnly: true` but guest gets through

The plugin treats Better Auth anonymous sessions as unauthenticated. If the user is signed in with an anonymous session, checkout is rejected. If you need guests to checkout, leave `authenticatedUsersOnly: false` and set `contactInformationType`.

## Duplicate webhook handler side effects

StreamPay may redeliver. If the same payment shows up twice, the handler isn't idempotent.

**Fix**: key on `payload.entity_id + payload.event_type` in a dedupe table or a unique constraint on the effect's primary key. Don't rely on response codes — StreamPay will retry on 5xx AND on timeouts even if your handler actually succeeded.

## `DUPLICATE_CONSUMER` scan returns `null`

**Symptom**: Logs: "StreamPay said duplicate but the scan missed". Sign-up then surfaces the original error.

**Causes**: paging gap, race, or a soft-deleted consumer. The scan checks `maxPages * pageSize` records — legacy tenants with thousands of consumers may not be covered.

**Fix**: bump `consumerLookupMaxPages` on `portal()` (for portal lookups). For sign-up, the default scan depth lives inside the plugin — if this is a recurring problem, file an issue on the plugin repo with tenant size details.

## Peer dependency warnings on install

The plugin requires `better-auth ^1.4.0` and `zod ^3.24 || ^4.0`. Upgrading `better-auth` below 1.4 will break. Upgrading `zod` v3 → v4 is safe for the plugin itself; verify the rest of the app.
