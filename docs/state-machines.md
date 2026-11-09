# State machines

This document lists every state machine in the plugin, including the ones that exist only as a
combination of columns. Each section gives the states, the invariants, and a transition table
that points to the code that performs each transition. The last sections record the invalid
states and transitions found in the November 2026 audit, how each one is reachable, and where it
is fixed.

Keep this file in sync with the code. A change to a status value, a slot rule, a lease rule, or a
compare-and-set `where` clause must update the matching table here and add a regression test.

## Conventions

- **CAS** means a conditional `adapter.update` whose `where` clause includes the expected current
  values. A `null` result means another writer changed the row first.
- **Slot** means `subscription.activeSlotKey`, a unique key derived from
  `(referenceType, referenceId, group)` by `subscriptionSlotKey` in
  `src/plugins/subscriptions/types.ts`.
- **Provider** means StreamPay. Provider state is fetched again on every webhook. The webhook body
  is only a trigger and a source of signed checkout metadata.

## Inventory

| # | Machine | Kind | State lives in | Main code |
| --- | --- | --- | --- | --- |
| 1 | Subscription lifecycle | Explicit `status`, plus overlays | `subscription.status`, `billingStatus`, `activeSlotKey` | `subscriptions/sync.ts`, `reconcile.ts`, `endpoints.ts` |
| 2 | Checkout reservation | Implicit sub-machine of 1 | `status = incomplete*`, `streampayPaymentLinkId`, `createdAt` | `subscriptions/checkout-reservation.ts`, `endpoints.ts` (`upgradeSubscription`) |
| 3 | Cancellation schedule | Implicit | `cancelAtPeriodEnd`, `cancelAt`, `cancelScheduledAt`, `canceledAt` | `reconcile.ts`, `sync.ts` |
| 4 | Pending plan/seat change | Implicit | `pendingPlan`, `pendingProductId`, `pendingSeats`, `pending*EffectiveAt` | `reconcile.ts` (`projectPlanFields`), `endpoints.ts` |
| 5 | Freeze | Provider-driven projection | `status = frozen`, `frozenAt`, `freezeEndAt` | `endpoints.ts`, `lifecycle.ts` |
| 6 | Renewal callback ownership | Implicit lock | `subscription.renewalCallbackEventId` | `sync.ts` (`handleRenewalEvidence`) |
| 7 | Webhook inbox event | Explicit `status`, plus lease | `streampayWebhookEvent.status`, `lockedAt`, `lockedBy`, `attemptCount` | `sync.ts`, `webhooks.ts`, `subscriptions/index.ts`, `admin.ts` |
| 8 | Webhook request pipeline | Implicit ordering | Request scope | `plugins/webhooks.ts` |
| 9 | Consumer link | Implicit | `user.streampayConsumerId` (unique) | `hooks/consumer.ts`, `utils/ensure-consumer.ts`, `utils/session.ts` |
| 10 | One-time checkout link | Request-scoped saga | Provider payment link | `plugins/checkout.ts` |

## 1. Subscription lifecycle

### States

| Class | Local `status` | Provider status | Slot | Access by default |
| --- | --- | --- | --- | --- |
| Reservation | `incomplete` | none yet, or an unknown value | held | no |
| Released reservation | `incomplete_expired` | none | null | no |
| Live | `trial_pending` | `TRIAL_PENDING` | held | no |
| Live | `trialing` | `TRIALING` | held | yes |
| Live | `active` | `ACTIVE` | held | yes |
| Live | `frozen` | `FROZEN` | held | yes |
| Live overlay | `past_due` | `ACTIVE` while `billingStatus = past_due` | held | yes |
| Terminal | `inactive` | `INACTIVE` | null | no |
| Terminal | `expired` | `EXPIRED` | null | no |
| Terminal | `canceled` | `CANCELED` | null | no |

`toLocalStatus` (`status.ts`) maps provider values. Any value it does not know maps to
`incomplete`. `isTerminalSubscriptionStatus` (`status.ts`) defines the terminal class.
`catalogMapped = false` removes access in every status (`plans.ts`, `hasSubscriptionAccess`).

`billingStatus` is a second axis with two values, `current` and `past_due`. It is a local
overlay: StreamPay keeps reporting `ACTIVE` while a renewal payment is outstanding.

### Invariants

| ID | Invariant | Enforced by |
| --- | --- | --- |
| S1 | `activeSlotKey` is non-null exactly when the status is not terminal. | `projectSubscriptionFields` clears the slot for terminal statuses. Releases set `incomplete_expired` and a null slot together. Webhook reconciliation backfills a missing slot for live rows. |
| S2 | At most one row holds a slot. | Database unique constraint on `activeSlotKey`. |
| S3 | A provider subscription maps to at most one row. A payment link maps to at most one row. | Unique `streampaySubscriptionId` and `streampayPaymentLinkId`. |
| S4 | A provider-confirmed subscription outranks an unpaid reservation (`incomplete` with no StreamPay subscription ID) for the same slot. Two live subscriptions in one slot are never written silently. | `updateReconciledSubscription` runs `takeSlotFromReservation` after its stale-state check (`sync.ts`). |
| S5 | `billingStatus = past_due` and provider `ACTIVE` imply local `past_due`. | `reconcileProjectionAgainstExisting` (`reconcile.ts`), the renewal stale branch (`sync.ts`). |
| S6 | `providerUpdatedAt` never moves backwards. | The webhook path throws and retries (`updateReconciledSubscription`). The endpoint path keeps the newer local row (`persistSubscriptionProjection`). |
| S7 | Every lifecycle write is a CAS on `providerUpdatedAt`, `status`, `billingStatus`, and the correlation IDs. | `updateReconciledSubscription`, `persistSubscriptionProjection`, `handleRenewalEvidence`. |

### Transitions

| # | Trigger | From | To | Guard and code |
| --- | --- | --- | --- | --- |
| L1 | Paid checkout confirmed by webhook | `incomplete`, `incomplete_expired`, or no row | provider status | Signed metadata row ID, then a payment-link match, then the newest matching reservation (`reconcileFromStreamPay`). Takes the slot from an unpaid holder (S4). The `/subscription/success` fallback also confirms, but only for an `incomplete` row that still holds its slot, matched by consumer, product, and link (`isCheckoutSubscriptionCandidate`). |
| L2 | `SUBSCRIPTION_CYCLE_RENEWAL_FAILED`, not stale | `active` | `past_due`, billing `past_due` | `sync.ts` |
| L3 | `INVOICE_COMPLETED` or `SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY`, not stale | `past_due` | `active`, billing `current` | `handleRenewalEvidence` (`sync.ts`) |
| L4 | Any other projection while billing is `past_due` | `past_due` | `past_due` | S5 |
| L5 | Provider reports `CANCELED`, `EXPIRED`, or `INACTIVE` | any | terminal, slot null | `projectSubscriptionFields`. `canceledAt` is stamped once. |
| L6 | Provider revives a terminal subscription (for example `INACTIVE` to `ACTIVE`) | terminal | live, slot reacquired | `sync.ts` existing-row branch. An unpaid holder is released. A live holder raises `SubscriptionCorrelationError`, a permanent failure that dead-letters for manual review. |
| L7 | Freeze, unfreeze, or freeze cancel | `active` and `frozen` | per provider | `endpoints.ts`, then `syncSubscriptionFromUpstream` |
| L8 | Customer endpoint action (cancel, uncancel, change plan, seats) | live | provider response | `persistSubscriptionProjection`. On CAS loss it keeps the newer local row and logs. The provider action is not rolled back. |
| L9 | Unmapped product (`catalogMapped = false`) | any | same status, no access | `projectPlanFields` |

Stale events (event timestamp older than `providerUpdatedAt`) still write the freshly fetched
provider state, but they skip lifecycle callbacks and timestamp stamping.

## 2. Checkout reservation

A reservation is the `incomplete` part of machine 1. It holds the slot while the customer is on
StreamPay's hosted checkout. The idempotency window is
`UPGRADE_IDEMPOTENCY_WINDOW_MS` (15 minutes).

### States

| State | Shape |
| --- | --- |
| R0 none | no row for the slot |
| R1 reserved | `incomplete`, slot held, `streampayPaymentLinkId = null` |
| R2 linked | `incomplete`, slot held, link ID set |
| R3 released | `incomplete_expired`, slot null, link inactive or unpayable |
| R4 confirmed | live status (machine 1) |

### Invariants

| ID | Invariant | Enforced by |
| --- | --- | --- |
| C1 | A request recovers a reservation only for the same plan and seat count. | `matchesCheckout` in `resumeOrReserveCheckoutSlot` |
| C2 | A released reservation has no payable link. | `deactivatePaymentLink` (`lifecycle.ts`) runs before every release of a linked reservation. On upgrade, a deactivation failure keeps the reservation and fails the request. On the webhook takeover it is best effort and logged for manual action, so it never blocks the paid subscription. StreamPay still completes a payment already in progress, which S4 covers. |
| C3 | A checkout URL is returned only while its reservation is still live, or after the customer has already paid it, unless the link persistence write itself fails. | `upgradeSubscription` checks the row returned by the link persistence update (`endpoints.ts`). The takeover's release also matches the holder's link ID, so a link persisted concurrently makes the webhook retry. |

### Transitions

| # | Trigger | From | To | Code |
| --- | --- | --- | --- | --- |
| C-a | `upgrade` with no holder | R0 | R1 | `adapter.create` with the slot |
| C-b | `createPaymentLink` succeeds | R1 | R2 | CAS on `id`, `referenceId`, `referenceType`, consumer, `link = null` |
| C-c | `createPaymentLink` throws | R1 | R0 (row deleted) | `deleteReservedSubscription` |
| C-d | Link has no URL | R1 | R3 | CAS on `status = incomplete` |
| C-e | Same plan and seats within the window, URL recoverable | R2 | R2 (`reused: true`) | `recoverCheckoutUrl` |
| C-f | Same plan and seats, link gone (404 or no URL) | R2 | R3, then C-a | CAS on `status = incomplete` |
| C-g | Different plan or seats within the window | R1/R2 | R1/R2, request gets `SUBSCRIPTION_CHECKOUT_IN_PROGRESS` | by design |
| C-h | Any request after the window | R1/R2 | R3, then C-a | Deactivate the link, then CAS on `id`, `status`, slot |
| C-i | Reservation released while its link was being created | R1 (released) | R3, request gets `SUBSCRIPTION_CHECKOUT_IN_PROGRESS` | New link deactivated |
| C-j | Paid subscription arrives for another row of the same slot | R1/R2 | R3 | `takeSlotFromReservation` |
| C-k | A live row holds the slot when the reservation is created | R0 | R0, request gets `SUBSCRIPTION_ALREADY_ACTIVE` | Previously surfaced the raw unique-constraint error |
| C-l | Webhook | R1/R2/R3 | R4 | machine 1, L1 |
| C-m | `/subscription/success` fallback | R1/R2 | R4 | machine 1, L1 |

## 3. Cancellation schedule

| State | `cancelAtPeriodEnd` | `cancelAt` | `cancelScheduledAt` | `canceledAt` |
| --- | --- | --- | --- | --- |
| Renewing | false | null | null | null |
| Scheduled | true | `periodEnd` | first schedule time | null |
| Canceled | any | any | any | first confirmation time |

| Trigger | From | To | Code |
| --- | --- | --- | --- |
| `/subscription/cancel` on an active subscription, or `SUBSCRIPTION_CANCEL_AT_PERIOD_END` | Renewing | Scheduled | `reconcileProjectionAgainstExisting` stamps `cancelScheduledAt` if it is still null |
| Any other webhook that sees `cancel_at_period_end` first | Renewing | Scheduled without a stamp | Not fixed: the later cancel event usually counts as stale and does not stamp (F8, R7) |
| `/subscription/uncancel` | Scheduled | Renewing | `projectSubscriptionFields` clears `cancelScheduledAt` |
| Provider `CANCELED` | any | Canceled | `canceledAt` is stamped once |

Plan and seat changes are rejected while the subscription is Scheduled.

## 4. Pending plan or seat change

States: **None** (all `pending*` null) and **Scheduled** (fields copied from the provider's
`pending_change.target_items`). The provider is the only source. `projectPlanFields` recomputes
the fields from every fetched subscription, so a webhook after the effective date clears them.
`change-plan` and `update-seats` return `reused: true` when the provider already has the same
target. They reject a different target with `*_ALREADY_SCHEDULED`. Both cancel endpoints are
idempotent.

## 5. Freeze

The plugin does not store a freeze machine of its own. `frozenAt` and `freezeEndAt` are set only
while the provider status is `FROZEN`. Future (scheduled) freezes exist only at StreamPay.
`unfreeze` ends the active freeze at "now". `freeze/cancel` treats StreamPay's "Cannot delete
non-latest freeze entry" 403 response as already canceled.

## 6. Renewal callback ownership

`renewalCallbackEventId` is a per-subscription lock that makes `onSubscriptionRenewed` survive
retries without firing for two events of the same cycle.

| From | Trigger | To | Code |
| --- | --- | --- | --- |
| null | Fresh renewal evidence advances the period or cycle and a callback is configured | event ID (CAS with the projection) | `handleRenewalEvidence` |
| event E | Callback succeeds | null (CAS on E) | same |
| event E | Callback throws with `retryOnCallbackError` | E (event recorded as failed) | same |
| event E | Redelivery or replay of E | E, then null after success | `pendingCallback === eventId` branch |
| event E | Renewal evidence for another event | E (other event fails and retries) | `pendingCallback !== eventId` |
| event E | Admin discards E | null | `adminDiscardWebhookEvent` |

Invariant: while the lock is set, its cycle's callback has not been delivered. Other renewal
evidence for that subscription waits until the lock clears.

## 7. Webhook inbox event

One table serves two scopes. Subscription sync uses
`<event_type>:<entity_id>:<timestamp>`. Generic handlers (`webhooks({ deduplicate: true })`) use
the same ID with a `handlers:` prefix.

### States

| State | `status` | Lease | Payload |
| --- | --- | --- | --- |
| E0 absent | none | none | none |
| E1 leased | `pending` | `lockedAt` under 2 minutes old, `lockedBy` set | stored |
| E2 retryable | `pending` | none (failure recorded) or expired (crash) | stored |
| E3 completed | `completed` | none | cleared |
| E4 dead letter | `dead_letter` | none | stored |

### Invariants

| ID | Invariant | Enforced by |
| --- | --- | --- |
| W1 | At most one worker holds a live lease. | `eventId` is unique. Claims are CAS on `status` and `lockedAt`. |
| W2 | Only the lease owner can complete or fail an event. | `markWebhookEventCompleted` and `recordWebhookEventFailure` filter on `lockedBy`. |
| W3 | Completed and dead-lettered events are never processed by delivery, only by replay. | `claimOrAdvanceWebhookEvent` skips them. |
| W4 | A replay failure never takes an event out of provider retry unless the event was already dead-lettered, has exhausted its attempts, or failed permanently. | Replay functions in `subscriptions/index.ts` and `webhooks.ts` (#27). |

### Transitions

| # | Trigger | From | To | Code |
| --- | --- | --- | --- | --- |
| W-a | First delivery | E0 | E1 | `claimOrAdvanceWebhookEvent` create |
| W-b | Duplicate delivery during the lease | E1 | E1 (duplicate gets HTTP 503 so StreamPay redelivers) | `WebhookEventInProgressError` |
| W-c | Delivery after a failure or expired lease, attempts left | E2 | E1 | CAS on `status` and `lockedAt` |
| W-d | Delivery with attempts exhausted | E2 | E4 | same CAS |
| W-e | Processing succeeds | E1 | E3 | `markWebhookEventCompleted(lockedBy)` |
| W-f | Transient failure, attempts left | E1 | E2 (`nextAttemptAt` set) | `recordWebhookEventFailure` |
| W-g | Permanent failure (`SubscriptionCorrelationError`, including two live subscriptions in one slot, or a provider 4xx other than 404 and 429), or attempts exhausted | E1 | E4 | same |
| W-h | Admin replay, or `processDueStreampayWebhookEvents` for E2 events whose `nextAttemptAt` passed or whose lease expired | E2 or E4 | E1 | `claimWebhookEventForReplay`, `findDueWebhookEvents` |
| W-i | Replay fails | E1 | E2 if it came from E2 with attempts left and a transient error, else E4 | #27. Before it, every admin replay failure dead-lettered. |
| W-j | Admin discard | any | E3 | `adminDiscardWebhookEvent`. Ignores a live lease by design. |

E2 events move on a StreamPay redelivery, an admin replay, or a scheduled call to
`processDueStreampayWebhookEvents`, which selects them by `nextAttemptAt` and expired leases.

## 8. Webhook request pipeline

```text
verify signature and tolerance -> parse envelope
  -> subscription sync (own inbox row; in-progress returns 503, permanent failure 200, transient 500)
  -> generic handlers (own `handlers:` inbox row when deduplicate is on)
  -> 200
```

A sync failure stops the request before the handlers run. StreamPay's redelivery then skips the
completed sync row and retries the handlers. A handler failure returns 500 after a successful
sync, and the redelivery skips the sync row.

## 9. Consumer link

| State | `user.streampayConsumerId` |
| --- | --- |
| Unlinked | null |
| Linked | StreamPay consumer UUID (unique) |

| Trigger | From | To | Code |
| --- | --- | --- | --- |
| Sign-up with `createConsumerOnSignUp` | Unlinked | Linked (inside the user insert) | `onBeforeUserCreate`. `onAfterUserCreate` backfills `external_id`. |
| First checkout or upgrade | Unlinked | Linked | `ensureConsumerForUser`: recover by `external_id`, create, or claim a duplicate |
| Claim backfill fails | Linked | Unlinked (CAS on the claimed ID) | `ensure-consumer.ts` duplicate branch |
| Provider 404 on profile sync | Linked | Unlinked (CAS) | `onUserUpdate` |
| Admin deletes the consumer | Linked | Unlinked (CAS) | `adminDeleteConsumer` |
| Cached session carries an old ID | n/a | the database value wins | `getCurrentConsumerUser` |
| Portal call while unlinked | Unlinked | Unlinked (reads by `external_id`, never writes) | `portal.ts` |

Invariants: one consumer per user and one user per consumer (unique column and
`assertConsumerUnclaimed`). Client input never sets the link (`input: false`).

## 10. One-time checkout link

`POST /checkout` creates a payment link, then runs `onCheckoutCreated`. If URL resolution or the
callback fails, the link is deactivated best-effort and the request fails. No local state is
written.

## Audit findings

Severity reflects customer and money impact. Each finding has unit tests and end-to-end tests that
drive a real Better Auth instance through HTTP with signed webhooks. All of them fail on the code
before the fix and pass after it. CI runs them on SQLite; they were also run locally on
PostgreSQL 17. Run the end-to-end tests on PostgreSQL with `STREAMPAY_E2E_DB=postgres` and a database at
`postgres://user:password@localhost:5432/better_auth` (hardcoded by `better-auth/test`).

| ID | Severity | Machine | Invalid state or transition | How it is reached | Before the fix | Fix |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | High | 2 → 1 | A paid subscription is never recorded, so the customer has no access. A second payment is also possible. | Checkout A (link L1) is left open for more than 15 minutes. The customer starts checkout B with another plan or seat count. C-h releases A without deactivating L1, and B takes the slot. The customer pays L1. The webhook correlates to A and tries to take the slot from B, which fails the unique constraint on every attempt. | Five deliveries return 500, then the event dead-letters with a raw unique-constraint error. `/subscription/success` does not link it either. `/subscription/current` returns `null`, and L2 stays payable. Reproduced live in the StreamPay sandbox. | C2 and S4, in the PR that adds this document |
| F2 | Low | 1 | Two live subscriptions compete for one slot, and the failure is retried as if it were transient. | StreamPay reactivates a locally terminal subscription (StreamPay documents `SUBSCRIPTION_ACTIVATED` as "initial activation or reactivation") after a replacement took the slot (L6). | Five deliveries return 500, then the event dead-letters with a misleading code. When the holder is an unpaid reservation, this is F1. | Dead letter on the first attempt as `SubscriptionCorrelationError` |
| F3 | n/a | 2 | A checkout URL is returned for a reservation that was already released. | Reachable only through the S4 takeover, while an upgrade is creating its link. | n/a | Guard C3, shipped with the F1 fix |
| F4 | Low | 2 | The raw database unique-constraint error reaches the client. | A webhook activates the user's pending checkout while a second upgrade is between its active-subscription check and its reservation insert (for example during `isTrialEligible`). | HTTP 500 with an empty body. | 409 `SUBSCRIPTION_ALREADY_ACTIVE` (C-k) |
| F5 | Medium | 7 | E2 → E4 on a transient admin replay failure. StreamPay redeliveries and the due-event processor skip the event. | An operator replays a pending subscription event during a StreamPay or database outage. | The redelivery returns 200, the event stays dead-lettered, and no subscription row is created. | #27 |
| F6 | Medium | 7 | Same as F5 for generic handler events. | Replay of a pending `handlers:` event whose callback fails. | The callback never runs again on redelivery. | #27 |
| F7 | Low | 7 | Replay ignored `retryOnCallbackError: false`. | Any admin replay or due-event retry with that option set. | The replay returns 500 and dead-letters, although the projection was written. | #27 |
| F8 | Low | 3 | `cancelAtPeriodEnd = true` with `cancelScheduledAt = null`, permanently. | A webhook other than `SUBSCRIPTION_CANCEL_AT_PERIOD_END` (for example `SUBSCRIPTION_PLAN_UPDATED`) is processed first after a cancellation made in the StreamPay dashboard. That webhook stores a `providerUpdatedAt` later than the cancel event, so the cancel event is stale. | `cancelScheduledAt` stays `null`. | Not fixed (R7). Relaxing the stamp condition alone let endpoints stamp the time of an unrelated later call. |

### Live sandbox evidence for F1

Run on 2026-11-09 in a Stream sandbox organization with a 3DS test-card payment.

| Step | Original `main` | With the fix |
| --- | --- | --- |
| Replace a checkout reservation older than 15 minutes | StreamPay reports the abandoned link `ACTIVE` | StreamPay reports it `INACTIVE`; its hosted page shows "Payment link is inactive" with no card form |
| Pay the abandoned link (original build only) | StreamPay creates an `ACTIVE` subscription whose `latest_invoice.payment_link_id` is the abandoned link | n/a: the link refuses payment |
| Process `SUBSCRIPTION_ACTIVATED` for that subscription | Five HTTP 500 responses, then a dead letter on `activeSlotKey`; `/subscription/current` is `null`; the replacement link stays `ACTIVE` | First delivery returns 200; the paid row is active; the replacement reservation is released and StreamPay reports its link `INACTIVE` |

The sandbox API keys cannot register webhooks, so StreamPay's delivery hop was replaced: the event
was signed locally, and its `data.metadata` is the `custom_metadata` StreamPay stored on the paid
link. The plugin re-fetched the subscription from StreamPay as usual. The fixed run used a copy of
the original run's database with the inbox cleared, as if the fix had been deployed first.

### Grouped issues

**Issue 1, P1: Released checkout reservations stay payable and block the paid subscription (F1,
F2, F4, and guard F3).** Deactivate a linked reservation's payment link before releasing it. Let a
provider-confirmed subscription take its slot from an unpaid reservation. Dead-letter a genuine
duplicate as a permanent failure. Map a live slot holder to `SUBSCRIPTION_ALREADY_ACTIVE`.

**Issue 2, P2: Manual replay dead-letters events that StreamPay is still retrying (F5–F7).** Fixed
by #27.

**Issue 3, P3: The cancellation schedule time is lost when events arrive out of order (F8).** Open.
A correct fix must stamp from the cancel event even when it is stale against `providerUpdatedAt`,
without letting endpoint projections stamp unrelated call times.

### Open risks (not confirmed, not changed)

| ID | Risk | Why it is not fixed here |
| --- | --- | --- |
| R1 | `past_due` can stay set after recovery. If a non-renewal webhook or customer action stores a `providerUpdatedAt` later than the timestamp of the recovering `INVOICE_COMPLETED`, that evidence counts as stale and the stale branch keeps `past_due` (`handleRenewalEvidence`). | Depends on how StreamPay orders `updated_at` against event timestamps. A correct fix needs the failure time stored (a schema change). Access is unaffected by default because `past_due` grants access. |
| R2 | `persistConsumerId` writes with `updateUser`, not a CAS on a null link. Two concurrent first checkouts can each create a consumer if StreamPay does not reject the duplicate email or `external_id`. | Unconfirmed provider behavior. Recovery by `external_id` covers the common case. |
| R3 | An unknown future provider status maps to `incomplete` on a live row. The row keeps its slot but loses access. | Fails closed. Handle new statuses explicitly when StreamPay adds them. |
| R4 | A dead-lettered renewal callback owner (machine 6) blocks renewal evidence for that subscription until it is replayed or discarded. | Intentional, to avoid a double callback. The operator needs to act. |
| R5 | Generic handler deliveries always use 5 attempts and ignore `maxWebhookAttempts`. | That option belongs to `subscriptions()`. Changing it is an API decision. |
| R6 | A callback that runs longer than the 2-minute lease can run concurrently with a redelivery. | Documented. Callbacks must be idempotent. |
| R7 | F8: `cancelScheduledAt` stays `null` when another webhook records the scheduled cancellation before the cancel event. | See Issue 3. The column is informational; access and slots are unaffected. |
| R8 | A pending inbox row that fails before it is claimed for replay (no stored payload, or a payload that is no longer valid) is never retried or dead-lettered. `processDueStreampayWebhookEvents` selects it oldest first on every run, so enough such rows fill every batch. | Pre-existing. Needs its own fix: dead-letter unreplayable rows when the processor finds them. |
