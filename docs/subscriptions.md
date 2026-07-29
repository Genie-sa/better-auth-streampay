# Subscription data model and seat billing

This document explains why the subscription tables exist, what every plugin-owned column means,
how seats map to StreamPay quantity, and which system is authoritative at each point in the
lifecycle.

The short version: StreamPay owns money and billing state; your database owns application
references, access-friendly projections, webhook processing state, and recovery metadata. The
local subscription row is deliberately a projection, not a second billing engine.

## Why local tables exist

Calling StreamPay for every authorization check would make application access depend on a remote
network request, add latency, and make webhook retries difficult to reason about. The plugin keeps
three pieces of local state:

| Model | Purpose | Why it cannot live only at StreamPay |
| --- | --- | --- |
| Better Auth `user` extension | Links one app user to one StreamPay consumer. | StreamPay does not know the Better Auth user primary key or session. |
| `subscription` | Projects the subscription into app-owned references, current/pending plan and seats, access status, periods, and correlation IDs. | The application needs fast authorization reads, organization/custom ownership, checkout recovery, and a stable local ID. |
| `streampayWebhookEvent` | Deduplicates signed deliveries and records retry/dead-letter state. | HTTP delivery is at-least-once; application callbacks and database writes must be recoverable and observable. |

## Data authority

| Data | Authority | Local behavior |
| --- | --- | --- |
| Product price, discounts, invoice totals, currency | StreamPay | Copied from subscription responses/webhooks. The configured price is only the pre-checkout quote. |
| Current item quantity | StreamPay `subscription.items[].quantity` | Stored as `seats` after success reconciliation or a webhook. |
| Scheduled item quantity | StreamPay `pending_change.target_items[].quantity` | Stored as `pendingSeats` until applied or canceled. |
| Subscription status and billing periods | StreamPay | Normalized for access checks while retaining the raw provider status. |
| User/organization/custom ownership | Your application | Stored in `referenceId` and `referenceType`; cross-reference actions require authorization. |
| Plan name, version, group, entitlements | Plugin configuration | Correlated to the provider product ID and snapshotted/projected locally. |
| Webhook attempt state | Your database | Controlled by the plugin's lease, retry, completion, and dead-letter state machine. |

Never use the local amount as a payment ledger and never overwrite provider-confirmed quantities
with an optimistic browser value. StreamPay's [subscription update API](https://docs.streampay.sa/api/v2-subscriptions-update/)
and [webhooks](https://docs.streampay.sa/webhooks/) are the billing source of truth.

## Better Auth user extension

Better Auth owns the normal user columns. The StreamPay plugin adds one field:

| Column | Shape | Meaning |
| --- | --- | --- |
| `streampayConsumerId` | nullable string, server-managed | StreamPay organization-consumer UUID linked to this user. It is created lazily by default, cleared when a confirmed upstream 404 makes the link stale, and never accepted from client input. |

This belongs on the user because it is an identity link. It is repeated on subscription rows as a
historical/correlation snapshot because a subscription can also belong to an organization or
custom application reference.

## `subscription` table

Better Auth supplies the string `id` primary key. "Nullable" means the value is unknown, not
applicable, or has not yet been confirmed upstream.

| Column | Shape / default | What it means and why it exists |
| --- | --- | --- |
| `id` | string, primary key | Stable application-side identifier generated through the Better Auth adapter. Client mutation APIs accept this ID (and ownership is always rechecked). |
| `referenceId` | string, required, indexed | App-owned subject receiving the subscription: a user ID, organization ID, or custom ID. This is the main ownership key. |
| `referenceType` | string, default `user` | Interprets `referenceId` as `user`, `organization`, or `custom`; prevents IDs from different namespaces colliding. |
| `activeSlotKey` | nullable string, unique, server-managed | SHA-256 key of reference type + ID + plan group. Enforces one live/in-progress subscription per billing slot and makes concurrent checkout safe. Cleared for terminal rows. |
| `streampaySubscriptionId` | nullable string, unique, server-managed | Provider subscription UUID. Null while hosted checkout has not produced a subscription. Used for lifecycle API calls and webhook lookup. |
| `streampayConsumerId` | nullable string, indexed, server-managed | Provider consumer UUID used for checkout and fallback reconciliation. Kept on the row even for non-user references. |
| `streampayPaymentLinkId` | nullable string, unique, server-managed | Hosted-checkout correlation/recovery ID. Lets an idempotent upgrade return the existing URL and helps verify success reconciliation. |
| `plan` | string, required | Stable application-facing plan name. Code should use this instead of a raw provider product ID. |
| `planVersion` | nullable string | Optional catalog/config version snapshot for auditing which plan definition was active. |
| `productId` | nullable string, indexed | Current configured StreamPay product UUID. Webhooks use it to infer `plan`; it may remain populated even if the plan is later removed from configuration. |
| `group` | nullable string, indexed | Mutually exclusive plan family such as `main` or `workspace`. Combined with the reference to form the active slot. |
| `seats` | number, default `1` | Current provider-confirmed quantity for the configured plan product. This is billed quantity, not an entitlement limit. |
| `amountInSmallestUnit` | nullable number | Current full subscription amount after discounts, in halalas/cents/etc. It can include seats and add-ons; do not treat it as unit price. |
| `originalAmountInSmallestUnit` | nullable number | Current full amount before discounts, also in the smallest currency unit. |
| `currency` | nullable string, default `SAR` | ISO currency from the provider/plan. Amount columns are meaningless without it. |
| `billingInterval` | nullable string | Provider recurrence (`WEEK`, `MONTH`, `QUARTER`, or `YEAR`). |
| `billingIntervalCount` | nullable number, default `1` | Multiplier for the recurrence, for example every 3 months. |
| `status` | string, default `incomplete`, indexed | Normalized application status: `incomplete`, `incomplete_expired`, `trial_pending`, `trialing`, `active`, `inactive`, `expired`, `canceled`, `frozen`, or `past_due`. |
| `providerStatus` | nullable string | Raw StreamPay subscription status. Retained so normalization does not discard provider detail. |
| `billingStatus` | string, default `current`, indexed | Payment health overlay: `current` or `past_due`. A renewal failure can deny/limit access without inventing a provider lifecycle status. |
| `periodStart` | nullable date | Start of the current provider billing period. |
| `periodEnd` | nullable date | End of the current provider billing period and usual effective time for a deferred change. |
| `currentCycleNumber` | nullable number | Provider cycle counter; helps identify genuine renewals and avoid duplicate renewal callbacks. |
| `trialStart` | nullable date | Start of a known trial. Also records trial history for one-trial-per-group eligibility. |
| `trialEnd` | nullable date | Provider trial end. |
| `cancelAtPeriodEnd` | boolean, default `false` | Whether renewal is scheduled to stop after the current period. |
| `cancelAt` | nullable date | Expected cancellation effective time, normally `periodEnd`. |
| `cancelScheduledAt` | nullable date | When the plugin first observed the cancellation schedule. Useful for audit/UI wording. |
| `canceledAt` | nullable date | When final canceled state was first confirmed. |
| `pendingPlan` | nullable string | Target application plan for a real product/plan change. Remains null for quantity-only changes. |
| `pendingProductId` | nullable string, indexed | Target provider product UUID for a real plan change. Remains null for quantity-only changes. |
| `pendingPlanEffectiveAt` | nullable date | Provider effective time for the pending plan/product change. |
| `pendingSeats` | nullable number | Quantity of the configured target plan item after the pending change. May accompany a plan change or exist alone. |
| `pendingSeatsEffectiveAt` | nullable date | Provider effective time for `pendingSeats`. Kept explicit so the UI need not infer it from a plan-only field. |
| `endedAt` | nullable date | Provider end timestamp for a terminal subscription. |
| `frozenAt` | nullable date | Start of the active provider freeze, when status is frozen. |
| `freezeEndAt` | nullable date | Scheduled end of the active freeze, or null for open-ended freezes. |
| `providerUpdatedAt` | nullable date | Provider update timestamp used to reject stale lifecycle effects from older webhook deliveries. |
| `syncedAt` | nullable date, indexed | Last time the plugin successfully projected a provider subscription response. Useful for freshness monitoring. |
| `createdAt` | nullable date, server-managed | Local row creation time. Also bounds checkout fallback correlation and idempotency. |
| `updatedAt` | nullable date, indexed, server-managed | Last local projection/mutation time. |

### Why current and pending fields are separate

StreamPay documents item, quantity, coupon, and interval updates as deferred to the current period
end. Replacing `seats` immediately would grant the new number of licenses before the provider says
the quantity is active. The two-state representation makes the UI and access policy explicit:

```text
seats=5, pendingSeats=12, pendingSeatsEffectiveAt=2026-08-01
```

The application should enforce five seats until a provider response/webhook changes `seats` to 12.
Canceling the pending change clears the pending fields but leaves the current fields untouched.

## `streampayWebhookEvent` table

StreamPay signs deliveries, but signatures do not make delivery exactly-once. This table makes
processing idempotent and observable.

| Column | Shape / default | What it means and why it exists |
| --- | --- | --- |
| `id` | string, primary key | Internal Better Auth adapter row identifier. `eventId`, not this value, is the delivery deduplication key. |
| `eventId` | string, required, unique | Deterministic identity for deduplication. A completed delivery with the same ID is skipped. |
| `eventType` | string, required | StreamPay event such as `SUBSCRIPTION_PLAN_UPDATED`. Useful for routing, debugging, and operations. |
| `receivedAt` | date, required, indexed | First receipt time. |
| `lastAttemptAt` | nullable date, indexed | Most recent processing/replay attempt. |
| `nextAttemptAt` | nullable date, indexed | Earliest automatic retry time after transient failure. |
| `completedAt` | nullable date, indexed | Successful completion time. Completed events no longer retain replay payload/signature data. |
| `deadLetteredAt` | nullable date, indexed | Time a permanent failure or exhausted retry budget moved the event to manual review. |
| `lockedAt` | nullable date, indexed | Start time of the current processing lease. Stale leases can be safely reclaimed. |
| `lockedBy` | nullable string | Unique lease owner token. Prevents an old worker from completing a lease reclaimed by another worker. |
| `status` | string, default `pending`, indexed | `pending`, `completed`, or `dead_letter`. |
| `attemptCount` | number, default `1` | Number of processing claims, including manual replay. |
| `rawPayload` | nullable string | Exact stored JSON for retry/replay after failure. Cleared after clean completion to reduce sensitive retention. |
| `signatureHeader` | nullable string | Original signature header retained only with a failed payload for forensic replay. |
| `lastError` | nullable string | Last failure message for operators. |
| `lastErrorCode` | nullable string, indexed | Stable/classified error code for filtering and alerting. |

Set `enableWebhookEventTable: false` only if another durable queue/inbox provides equivalent
deduplication, leasing, retry, and dead-letter behavior. Application lifecycle callbacks should
still be idempotent.

## Seat API

Configure plan bounds separately from feature limits:

```ts
subscriptions({
  plans: [{
    name: "team-monthly",
    productId: process.env.STREAMPAY_TEAM_PRODUCT_ID!,
    priceInSmallestUnit: 4_900, // price for one seat
    currency: "SAR",
    billingInterval: "MONTH",
    group: "workspace",
    seatBilling: {
      default: 5,
      minimum: 2,
      maximum: 100,
      customerEditable: false,
    },
    limits: { reports: true },
  }],
});
```

`customerEditable: true` maps to StreamPay payment-link `allow_custom_quantity` and sends the
inclusive `min_quantity`/`max_quantity` bounds documented by the
[payment-link API](https://docs.streampay.sa/api/v2-payment-links-create/). Server-selected seats
work regardless of that flag.

```ts
await authClient.subscription.upgrade({ plan: "team-monthly", seats: 8 });

await authClient.subscription.updateSeats({ subscriptionId, seats: 12 });

await authClient.subscription.changePlan({
  subscriptionId,
  plan: "team-yearly",
  seats: 20,
});

await authClient.subscription.pendingChange.cancel({ subscriptionId });
```

Plan changes preserve the current quantity when `seats` is omitted. Both plan and seat updates
send the complete current StreamPay item list and subscription coupon list because the provider's
update contract replaces them. Unrelated add-ons stay in place. Coupon IDs visible in the
provider's calculation metadata are retained; if StreamPay does not expose historical item-level
coupon identity in a response, no client can perfectly reconstruct that hidden state.

The provider response remains authoritative if its accepted current or pending quantity differs
from the request. A subscription containing more than one configured plan product is rejected as
ambiguous instead of guessing which item is billed as the plan. Canceling a pending change is
idempotent: if StreamPay already cleared it, the endpoint reconciles local state and succeeds with
`reused: true`.

## Checkout and webhook sequence

```text
upgrade(seats)
  -> validate plan/bounds and reserve unique local slot
  -> create StreamPay payment link with item.quantity
  -> customer pays (and may edit quantity only when explicitly enabled)
  -> signed webhook or success fallback fetches the subscription
  -> provider items[].quantity overwrites local seats

updateSeats(newSeats)
  -> fetch provider subscription
  -> preserve every item/coupon and replace configured item quantity
  -> StreamPay returns pending_change (or an immediate authoritative state)
  -> persist current seats + pendingSeats separately
  -> later webhook fetches provider state and applies/clears pending seats
```

The upgrade reservation is idempotent by plan **and** seat count. A second request for a different
quantity cannot accidentally recover an earlier checkout URL; it returns a conflict until that
reservation expires.

## Migration

Adding seat support adds three subscription columns:

```text
seats                    number, default 1
pendingSeats             nullable number
pendingSeatsEffectiveAt  nullable date
```

Generate/apply the normal Better Auth migration:

```bash
npx auth@latest migrate --config path/to/auth.ts
```

For an existing application, prefer `npx auth@latest generate --config path/to/auth.ts`, review the
generated schema, and create the equivalent application migration through your ORM. This is
required for Drizzle and Prisma and is safer for SQLite upgrades because SQLite cannot express
every constraint change with `ALTER TABLE`.

The application migration must add the three columns and explicitly backfill existing rows:

```sql
UPDATE subscription SET seats = 1 WHERE seats IS NULL;
```

Better Auth's plugin-level `defaultValue: 1` protects new writes but its generated SQL currently
creates `seats` as a nullable integer without a database default. Keep the backfill in the same
reviewed migration as the new columns, and deploy that migration before code that reads `seats`.

This follows Better Auth's plugin contract: this package declares the complete schema and release
notes, while the consuming application controls database credentials, rollout order, backups, and
the actual migration. The plugin never performs DDL automatically during startup or a request.

## Industry-standard comparison

| Practice | This plugin | Common billing practice |
| --- | --- | --- |
| Quantity is attached to a subscription item | Yes; public `seats` maps to StreamPay item `quantity`. | Stripe also models quantities on subscription items ([quantities guide](https://docs.stripe.com/billing/subscriptions/quantities)). |
| Hosted customer quantity editing is opt-in and bounded | Yes; `customerEditable` plus required min/max. | Stripe Checkout similarly uses opt-in adjustable quantity and min/max ([adjustable quantity](https://docs.stripe.com/payments/checkout/adjustable-quantity)). |
| App stores a provider projection | Yes. | Standard webhook-driven SaaS design; avoids remote calls on every authorization. |
| Current and scheduled state are distinct | Yes. | Required whenever provider changes are deferred/prorated/scheduled. |
| Full-replacement update preserves unrelated items | Yes. | Required by StreamPay's documented update contract. |
| Webhooks are deduplicated with durable retry state | Yes, by default. | Standard inbox/idempotent-consumer pattern for at-least-once webhooks. |
| Billed seats and entitlement limits are separate | Yes: `seats` versus `limits`. | Prevents silently multiplying every limit when only licensed members should scale. |
| Better Auth Stripe-style `seats` request vocabulary | Yes. | Matches the Better Auth [Stripe plugin](https://www.better-auth.com/docs/plugins/stripe) while retaining StreamPay semantics. |

No local model can make a remote payment provider transactional with your application database.
The industry-standard answer is what this plugin implements: protected metadata, unique local
reservations, provider-authoritative reconciliation, signed idempotent webhooks, retry/dead-letter
state, and explicit UI for pending changes.
