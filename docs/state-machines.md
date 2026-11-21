# State machines

This document lists every state machine in the plugin, including the ones that exist only as a
combination of columns. Each section gives the states, the invariants, and a transition table
that points to the code that performs each transition. The last sections record the invalid
states and transitions found in the November 2026 audits, how each one is reachable, and where it
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
- **Stale event** means an event whose timestamp is older than the stored `providerUpdatedAt`.
  StreamPay stamps an event shortly after the write it reports (0.3 to 1.2 seconds in the
  sandbox), so an event becomes stale only when a later write reaches the row before the event is
  processed: a retry, a reordered concurrent delivery, or a customer action in between.

## Inventory

| # | Machine | Kind | State lives in | Main code |
| --- | --- | --- | --- | --- |
| 1 | Subscription lifecycle | Explicit `status`, plus overlays | `subscription.status`, `billingStatus`, `activeSlotKey` | `subscriptions/sync.ts`, `reconcile.ts`, `endpoints.ts` |
| 2 | Checkout reservation | Implicit sub-machine of 1 | `status = incomplete*`, `streampayPaymentLinkId`, `createdAt` | `subscriptions/checkout-reservation.ts`, `endpoints.ts` (`upgradeSubscription`) |
| 3 | Cancellation schedule | Implicit | `cancelAtPeriodEnd`, `cancelAt`, `cancelScheduledAt`, `canceledAt` | `reconcile.ts`, `sync.ts` |
| 4 | Pending plan/seat change | Implicit | `pendingPlan`, `pendingProductId`, `pendingSeats`, `pending*EffectiveAt` | `reconcile.ts` (`projectPlanFields`), `endpoints.ts` |
| 5 | Freeze | Provider-driven projection | `status = frozen`, `frozenAt`, `freezeEndAt` | `endpoints.ts`, `lifecycle.ts` |
| 6 | Renewal callback ownership | Implicit lock plus cycle marker | `subscription.renewalCallbackEventId`, `renewedCycleNumber` | `sync.ts` (`handleRenewalEvidence`) |
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
| S1 | `activeSlotKey` is non-null exactly when the status is not terminal. | `projectSubscriptionFields` clears the slot for terminal statuses. Releases set `incomplete_expired` and a null slot together. Webhook reconciliation and renewal evidence backfill a missing slot for live rows through `liveSlotKey` and the S4 takeover (`sync.ts`). Endpoint projections take a free slot when they observe a revival, and skip the write when another row holds it, leaving the conflict to the webhook path (`persistSubscriptionProjection`, F17). |
| S2 | At most one row holds a slot. | Database unique constraint on `activeSlotKey`. |
| S3 | A provider subscription maps to at most one row. A payment link maps to at most one row. | Unique `streampaySubscriptionId` and `streampayPaymentLinkId`. |
| S4 | A provider-confirmed subscription outranks an unpaid reservation (`incomplete` with no StreamPay subscription ID) for the same slot. Two live subscriptions in one slot are never written silently. | `updateReconciledSubscription` and `handleRenewalEvidence` run `takeSlotFromReservation` after their stale-state checks (`sync.ts`). |
| S5 | `billingStatus = past_due` and provider `ACTIVE` imply local `past_due`. | `reconcileProjectionAgainstExisting` (`reconcile.ts`), the renewal stale branch (`sync.ts`). |
| S6 | `providerUpdatedAt` never moves backwards. | The webhook path throws and retries (`updateReconciledSubscription`). The endpoint path keeps the newer local row (`persistSubscriptionProjection`). |
| S7 | Every lifecycle write is a CAS on `providerUpdatedAt`, `status`, `billingStatus`, and the correlation IDs. | `updateReconciledSubscription`, `persistSubscriptionProjection`, `handleRenewalEvidence`. |
| S8 | A stale event loses its lifecycle effects (callback, `past_due`, timestamp stamps) only when the fresh provider snapshot contradicts it. | `providerStateConfirmsEvent` in `reconcileFromStreamPay`; the latest-invoice check in `handleRenewalEvidence` (`sync.ts`). |

### Transitions

| # | Trigger | From | To | Guard and code |
| --- | --- | --- | --- | --- |
| L1 | Paid checkout confirmed by webhook | `incomplete`, `incomplete_expired`, or no row | provider status | Signed metadata row ID, then a payment-link match, then the newest matching reservation (`reconcileFromStreamPay`). Takes the slot from an unpaid holder (S4). The `/subscription/success` fallback also confirms, but only for an `incomplete` row that still holds its slot, matched by consumer, product, and link (`isCheckoutSubscriptionCandidate`). |
| L2 | `SUBSCRIPTION_CYCLE_RENEWAL_FAILED`, not stale | `active` | `past_due`, billing `past_due` | `sync.ts` |
| L3 | `INVOICE_COMPLETED` or `SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY`, not stale, or stale while its invoice is the provider's `COMPLETED` `latest_invoice` | `past_due` | `active`, billing `current` | `handleRenewalEvidence` (`sync.ts`) |
| L4 | Any other projection while billing is `past_due` | `past_due` | `past_due` | S5 |
| L5 | Provider reports `CANCELED`, `EXPIRED`, or `INACTIVE` | any | terminal, slot null | `projectSubscriptionFields`. `canceledAt` is stamped once. |
| L6 | Provider revives a terminal subscription (for example `INACTIVE` to `ACTIVE`) | terminal | live, slot reacquired | `sync.ts` existing-row branch and `handleRenewalEvidence`. An unpaid holder is released. A live holder raises `SubscriptionCorrelationError`, a permanent failure that dead-letters for manual review. |
| L7 | Freeze, unfreeze, or freeze cancel | `active` and `frozen` | per provider | `endpoints.ts`, then `syncSubscriptionFromUpstream` |
| L8 | Customer endpoint action (cancel, uncancel, change plan, seats) | live | provider response | `persistSubscriptionProjection`. On CAS loss it keeps the newer local row and logs. The provider action is not rolled back. |
| L9 | Unmapped product (`catalogMapped = false`) | any | same status, no access | `projectPlanFields` |

Stale events still write the freshly fetched provider state. Their lifecycle callback, the
`past_due` overlay, and the `cancelScheduledAt` and `canceledAt` stamps apply only when the fresh
snapshot confirms the event (S8):

| Event | Confirmed when the provider shows |
| --- | --- |
| `SUBSCRIPTION_CREATED` | always |
| `SUBSCRIPTION_ACTIVATED`, `SUBSCRIPTION_UNFREEZE_NOW` | `ACTIVE` or `TRIALING` |
| `SUBSCRIPTION_CANCELED` | `CANCELED` |
| `SUBSCRIPTION_INACTIVATED` | `INACTIVE` |
| `SUBSCRIPTION_CANCEL_AT_PERIOD_END` | `cancel_at_period_end` on a live subscription |
| `SUBSCRIPTION_FROZEN`, `SUBSCRIPTION_FREEZE_NOW` | `FROZEN` |
| `SUBSCRIPTION_PLAN_CHANGE_SCHEDULED` / `_CANCELED` | a pending change / no pending change |
| Every other event, including `SUBSCRIPTION_CYCLE_RENEWAL_FAILED` | never (stale effects stay suppressed) |

`SUBSCRIPTION_CYCLE_RENEWAL_FAILED` stays suppressed because a late failure event cannot be told
apart from a failure that was already recovered.

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
| C-e | Same plan and seats within the window, link not `INACTIVE` and URL recoverable | R2 | R2 (`reused: true`) | `recoverCheckoutUrl` |
| C-f | Same plan and seats, link gone (404, `INACTIVE`, or no URL) | R2 | R3, then C-a | CAS on `status = incomplete` |
| C-g | Different plan or seats within the window | R1/R2 | R1/R2, request gets `SUBSCRIPTION_CHECKOUT_IN_PROGRESS` | by design |
| C-h | Any request after the window, including the same plan and seats | R1/R2 | R3, then C-a | Deactivate the link, then CAS on `id`, `status`, slot. The same-plan conflict path skipped this before F20. |
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
| Any other webhook that sees `cancel_at_period_end` first | Renewing | Scheduled without a stamp | Transient. The cancel event stamps its own timestamp when it arrives, even when stale (S8, F8) |
| `SUBSCRIPTION_CANCEL_AT_PERIOD_END` after that | Scheduled without a stamp | Scheduled | `reconcileFromStreamPay` stamps the event time. Endpoints never fill a missing stamp, so it is never the time of an unrelated call. |
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
| null | Renewal evidence that applies (S8) sees a provider cycle above `renewedCycleNumber`, or a later period when StreamPay sends no cycle numbers, and a callback is configured | event ID, with `renewedCycleNumber` advanced (one CAS with the projection) | `handleRenewalEvidence` |
| event E | Callback succeeds | null (CAS on E) | same |
| event E | Callback throws with `retryOnCallbackError` | E (event recorded as failed) | same |
| event E | Redelivery or replay of E | E, then null after success | `pendingCallback === eventId` branch |
| event E | Renewal evidence for another event | E (other event fails and retries) | `pendingCallback !== eventId` |
| event E | Admin discards E | null | `adminDiscardWebhookEvent` |

Invariants: while the lock is set, its cycle's callback has not been delivered, and other renewal
evidence for that subscription waits until the lock clears. Only renewal evidence advances
`renewedCycleNumber`. Every other projection leaves it untouched, or initializes it to the row's
current cycle when it is still null on a legacy row, so a webhook or endpoint that writes the new
cycle first cannot absorb the renewal (F13). Every lifecycle CAS includes the marker, so a
projection prepared before a renewal callback cannot roll it back and let a second renewal event
deliver the callback again (F14). StreamPay's cycle counter is the renewal identity because period
boundaries drift: live sandbox subscriptions started in July read cycle 5 in November, and their
periods start up to 9 minutes after `started_at`.

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
| E2p parked | `pending`, `nextAttemptAt = null`, `lastErrorCode = UNREPLAYABLE_PAYLOAD` | none | missing or unparseable |
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
| W-c | Delivery after a failure or expired lease, attempts left | E2 or E2p | E1, storing the delivered payload | CAS on `status`, `lockedAt`, and `attemptCount` (F23) |
| W-d | Delivery with attempts exhausted | E2 | E4, keeping the stored payload when the delivery has none (F22) | same CAS |
| W-e | Processing succeeds | E1 | E3 | `markWebhookEventCompleted(lockedBy)` |
| W-f | Transient failure, attempts left | E1 | E2 (`nextAttemptAt` set) | `recordWebhookEventFailure` |
| W-g | Permanent failure (`SubscriptionCorrelationError`, including two live subscriptions in one slot, or a provider 4xx other than 404 and 429), or attempts exhausted | E1 | E4 | same |
| W-h | Admin replay, or `processDueStreampayWebhookEvents` for E2 events whose `nextAttemptAt` passed or whose lease expired | E2 or E4 (admin), E2 still at the selected attempt and still due (processor) | E1 | `claimWebhookEventForReplay` (CAS on `status`, `lockedAt`, and `attemptCount`), `findDueWebhookEvents`, `isStillDueWebhookEvent` (F15) |
| W-i | Replay fails | E1 | E2 if it came from E2 with attempts left and a transient error, else E4 | #27. Before it, every admin replay failure dead-lettered. |
| W-j | Admin discard | any except E1 | E3 | `completeUnchangedWebhookEvent`, a CAS on the observed `status`, `lockedAt`, and `attemptCount`; 409 on a live lease or a lost CAS. The renewal callback lock is cleared only after the event is completed (F21). |
| W-k | Replay or due-event processing finds no replayable payload | E2 | E2p (request gets 400) | `parkUnreplayableWebhookEvent`, a CAS on `status`, `lockedAt`, and `attemptCount`, so a redelivery that repaired the row in between wins (F16). Before it, the row stayed due and filled every batch (F12). |

E2 events move on a StreamPay redelivery, an admin replay, or a scheduled call to
`processDueStreampayWebhookEvents`, which selects them by `nextAttemptAt` and expired leases. E2p
events wait for a StreamPay redelivery or an admin discard. StreamPay stops after its fifth retry
(about 20 hours), so an E2p row that outlives that window needs an admin discard. Only rows written without a raw body
reach E2p: callers of the exported `syncWebhookPayload` that omit `rawBody`, or rows from older
versions.

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

Severity reflects customer and money impact. Each finding has end-to-end tests that drive a real
Better Auth instance through HTTP with signed webhooks, and F1 to F7 also have unit tests. All of
them fail on the code before the fix and pass after it. CI runs them on SQLite; they were also run locally on
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
| F8 | Low | 3 | `cancelAtPeriodEnd = true` with `cancelScheduledAt = null`, permanently. | A webhook other than `SUBSCRIPTION_CANCEL_AT_PERIOD_END` (for example `SUBSCRIPTION_PLAN_UPDATED`) is processed first after a cancellation made in the StreamPay dashboard. That webhook stores a `providerUpdatedAt` later than the cancel event, so the cancel event is stale. | `cancelScheduledAt` stays `null`. | S8 (Issue 4). The stamp comes only from the cancel event, so endpoints still never stamp an unrelated call time. Supersedes draft #28. |
| F9 | High | 1, 7 | A paid, live subscription whose lifecycle callback never succeeds, while its inbox event is `completed`. | The first delivery of `SUBSCRIPTION_ACTIVATED` fails (the callback throws, or StreamPay or the database is briefly down), or a sibling event is processed first. Before the retry, any later write reaches the row, for example the customer scheduling a period-end cancellation. The retry is stale, so the callback is skipped and the event completes. Same for `SUBSCRIPTION_CREATED`, `_CANCELED`, `_FROZEN`, and the others in the S8 table. | `onSubscriptionActivated`, the documented place to provision the customer, never runs. Nothing dead-letters, so nobody is alerted. The October sandbox run shows the trigger: `SUBSCRIPTION_ACTIVATED` (16:33:08.45) and `SUBSCRIPTION_CANCEL_AT_PERIOD_END` (16:33:10.41) were processed 4 ms apart, the activation after the cancellation write. Reproduced live; see below. | S8 (Issue 4) |
| F10 | Medium | 1 | `past_due` (and billing `past_due`) after StreamPay recorded the payment. | A renewal fails. The customer pays the outstanding invoice, then some other write reaches the row before `INVOICE_COMPLETED` is processed (a retry after a failed first delivery, or a customer action). The invoice event is stale and the stale branch keeps `past_due`. This is R1. | `past_due` until the next successful cycle. Apps whose `accessStatuses` exclude `past_due` lock out a paying customer, and `onSubscriptionRenewed` is skipped for that evidence. | S8: stale evidence still clears `past_due` when its invoice is the provider's `latest_invoice` and that invoice is `COMPLETED` (Issue 4) |
| F11 | Low | 1 | S1 broken: a live status with `activeSlotKey = null`, and a revival that skips S4's duplicate check. | StreamPay revives a terminal subscription and `INVOICE_COMPLETED` (or `SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY`) is processed before any other subscription event. `handleRenewalEvidence` wrote the projection without the slot logic of the reconcile path. | The row is `active` without a slot until another webhook backfills it. If a replacement subscription holds the slot, two live subscriptions exist, and the renewal path never raises the correlation error, so the customer can be billed twice unnoticed. | `liveSlotKey` plus `takeSlotFromReservation` in `handleRenewalEvidence` (Issue 5) |
| F13 | Medium | 6 | A renewed cycle whose `onSubscriptionRenewed` never runs. | Another writer stores the new cycle before the renewal evidence is processed: `SUBSCRIPTION_PLAN_CHANGED` when a scheduled change applies at renewal, any other subscription event, or a customer action, including during a retry backoff of `INVOICE_COMPLETED`. The evidence then compares against the already advanced row and sees no renewal. This is R9. | No renewal callback for that cycle, so apps that grant per-cycle credits or send receipts skip it silently. | `renewedCycleNumber` (Issue 7). Needs the migration in the integration guide. |
| F18 | High | 1, 7 | A paid subscription's `SUBSCRIPTION_ACTIVATED` dead-lettered on its first attempt. | Found by Gemini 4 Neon; pre-existing. No live reservation matches (the metadata row is gone or carries no row ID), so two concurrent first deliveries (`SUBSCRIPTION_CREATED` and `SUBSCRIPTION_ACTIVATED`) both take the create path. The second found the first one's new row in the slot and raised `SubscriptionCorrelationError` against its own subscription. | Permanent dead letter, HTTP 200, so StreamPay never retries and `onSubscriptionActivated` never runs. | `takeSlotFromReservation` treats a holder with the same StreamPay subscription ID as a concurrent link and fails transiently |
| F19 | Medium | 1, 6 | `past_due` and a lost `onSubscriptionRenewed` after a late `SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY`. | Found by Gemini 4 Neon in the F10 fix. The renewal-success event names no invoice, so the latest-invoice check never applied to it when it was stale. | Same as F10 and F13, for StreamPay's renewal-success event. | Stale renewal evidence that names no invoice applies when the latest invoice is `COMPLETED` |
| F20 | Medium | 2 | An unpayable or long-abandoned checkout returned as `reused: true`, forever. | Found by Gemini 4 Neon; pre-existing. After the 15-minute window, a same-plan, same-seat upgrade hit the slot conflict and resumed the old link without checking its age (C-h). `getPaymentUrl` also returns a URL for `INACTIVE` links (verified in SDK 1.1.3), so a link deactivated in the dashboard was resumed on every retry. | The customer cannot start a payable checkout for that plan and seat count. | The conflict path resumes only inside the window, and an `INACTIVE` link counts as expired (`recoverCheckoutUrl`) |
| F21 | Low | 6, 7 | `renewalCallbackEventId` left set by an event that is already `completed`. | Found by Gemini 4 Neon; pre-existing. An admin discard ran while a worker held the lease, before the worker wrote the callback lock. | Every later renewal event for that subscription fails with "renewal callback is pending" until the event is discarded again. | Discard returns 409 while a live lease exists, and completes only through a CAS on the observed status, lease, and attempt; the lock is cleared after that succeeds (the re-review found a worker could claim between the read and the write) |
| F22 | Low | 7 | A dead-lettered event with its stored payload erased. | Found by Gemini 4 Neon. The exhausted-attempts branch of `claimOrAdvanceWebhookEvent` wrote the delivery body even when a direct `syncWebhookPayload` caller passed none. | The dead letter cannot be replayed. | Keep the stored payload when the delivery has no body |
| F23 | Medium | 7 | One attempt run twice, past the attempt budget. | Found by GPT-6.2 Astra on re-review; pre-existing. Two redeliveries read pending attempt N. The first claims N+1, fails, and releases the lease; the second's claim still matched `pending` and `lockedAt = null`. | Extra provider calls and callback runs. | Delivery claims compare `attemptCount` |
| F24 | Low | 2 | A same-plan upgrade refused with `SUBSCRIPTION_CHECKOUT_IN_PROGRESS` while the slot is held by a reservation whose link is gone. | Found by GPT-6.2 Astra on re-review; pre-existing. The request misses the reservation in its first read, loses the insert race, and finds the link `INACTIVE` or 404. | The customer cannot start a checkout until the 15-minute window passes. | The conflict path releases a reservation with an expired link and reserves again (C-f) |
| F14 | High | 6 | `renewedCycleNumber` rolled back after its callback ran, so a second renewal event delivers `onSubscriptionRenewed` again. | Found in review of the F13 fix. A customer endpoint (or webhook) reads the row, `INVOICE_COMPLETED` then advances the marker and runs the callback, and the endpoint write restores the old marker. Its CAS matched because the provider timestamp was unchanged. `SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY` then counted as a new renewal. | Duplicate per-cycle side effects. | Projections only initialize the marker, and every CAS includes it |
| F15 | Medium | 7 | A due-queue retry before its backoff, or an automatic retry of a dead letter. | Pre-existing. Two overlapping `processDueStreampayWebhookEvents` runs select the same row. The first claims it and fails. The second replayed by event ID, re-read the updated row, and claimed it again at once, even after it was dead-lettered. | Extra provider calls and callback runs, and dead letters leaving manual review. | The processor passes the selected attempt (`dueAttemptCount`); replay requires the row to still be that pending attempt and due, and the claim CAS includes `attemptCount` |
| F16 | Medium | 7 | A repaired event parked as unreplayable. | Found in review of F12. Replay reads a pending row without payload; a redelivery then claims it, stores its payload, fails, and schedules a retry; the stale parking write still matched `pending` and `lockedAt = null`. | The retry time is erased, so the due processor never retries the event. | Parking CAS includes `attemptCount` |
| F17 | Medium | 1 | Two live subscriptions in one slot, written silently by a customer endpoint. | StreamPay revives subscription A after replacement B took its slot. A customer action on A (for example `/subscription/uncancel`) projects A live with a null slot. This was R10. | Both rows grant access; nothing flags the duplicate billing until a later webhook dead-letters. | Endpoints take the slot when it is free and otherwise skip the write and log; only webhooks resolve slot conflicts |
| F12 | Low | 7 | A pending inbox row that can never be replayed stays due forever. | A row without a replayable payload (see E2p) gets a `nextAttemptAt`. Replay rejects it before claiming, so nothing changes, and `processDueStreampayWebhookEvents` selects it first on every run. This is R8. | Enough such rows fill every batch, and other due events are never retried. A redelivery that reclaimed the row also did not store its payload. | W-k and W-c (Issue 6) |

### Live sandbox evidence for F9 and StreamPay timing

Run on 2026-11-21 against the Stream sandbox through the Railway `staging` variables of
`genie-courses-web`. Every StreamPay call was read-only except the R2 probe, which created one
test consumer and deleted it.

**Event timing.** Real objects compared with the real deliveries recorded in October:

| Object | Provider write | Event timestamp | Lag |
| --- | --- | --- | --- |
| Subscription `39143aaa` created | `created_at` 14:53:27.100 | `SUBSCRIPTION_CREATED` 14:53:28.316 | 1.2 s |
| Its first invoice completed | `updated_at` 14:53:27.887 | `INVOICE_COMPLETED` 14:53:28.583 | 0.7 s |
| Subscription `1e5bca28` canceled | `updated_at` 14:13:50.437 | `SUBSCRIPTION_CANCELED` 14:13:50.814 | 0.4 s |

StreamPay delivers a burst concurrently: the plugin started processing `INVOICE_COMPLETED`
3 ms before `SUBSCRIPTION_CREATED`. One burst is therefore not stale against itself; a later write
is what makes an event stale.

**F9.** `probe-f9-live.mjs` runs each build against sandbox subscription `619e3b9e`. It was
activated at 09:23:32 and its period-end cancellation was scheduled at 09:26:30, so its
`updated_at` is the cancellation write. `SUBSCRIPTION_ACTIVATED` is signed with the observed lag
(09:23:33.3) and delivered twice; the first `onSubscriptionActivated` call throws.

| Step | Original `main` | With the fix |
| --- | --- | --- |
| First delivery | 500, callback threw, row `active` | same |
| Retry | 200, callback skipped as stale | 200, callback delivered with `cancelAtPeriodEnd: true` |
| Inbox | `completed` after 2 attempts | `completed` after 2 attempts |
| Successful callbacks | 0 | 1 |

**F13.** `probe-f13-live.mjs` runs each build against sandbox subscription `a74dcc6a`, which
StreamPay renewed from cycle 4 to 5 on 2026-11-12. The local row starts at cycle 4. A
`SUBSCRIPTION_PLAN_UPDATED` is processed first (it writes cycle 5), then `INVOICE_COMPLETED` for
the real latest invoice (`COMPLETED`, `subscription_id` matching).

| Build | `onSubscriptionRenewed` calls | Row after |
| --- | --- | --- |
| Original `main` | none | cycle 5 |
| With the fix | one, for cycle 5 | cycle 5, `renewedCycleNumber` 5 |

**StreamPay documentation, checked 2026-11-21.** The [webhook guide](https://docs.streampay.sa/webhooks/)
confirms the assumptions above: `SUBSCRIPTION_ACTIVATED` covers "initial activation or
reactivation" (L6, F11), failed deliveries are retried up to 5 times after 5 minutes, 30 minutes,
2, 6, and 12 hours (the plugin uses the same schedule; the first gap is the F9 window), and
`SUBSCRIPTION_PLAN_CHANGED` fires when a scheduled change is applied at period end (the F13
trigger). The guide gives no ordering guarantee and no event ID, so the inbox keys stay
`event_type:entity_id:timestamp`. It documents renewal as `INVOICE_CREATED`, `PAYMENT_SUCCEEDED`,
`INVOICE_COMPLETED` and does not place `SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY` in that sequence,
which is why both are treated as renewal evidence. The [cancel API](https://docs.streampay.sa/api/v2-subscriptions-cancel/)
confirms `INACTIVE`, `TRIALING`, and `TRIAL_PENDING` are cancelled immediately and `ACTIVE` at
period end.

**F10.** The sandbox exposes `latest_invoice` with `id` and `status` on the subscription, and a
paid invoice reads `COMPLETED` (subscription `39143aaa`). An invoice's `period_end` does not match
the subscription's (12 seconds apart), so the fix compares invoice IDs, not periods.

**R2, disproved.** Two concurrent `createConsumer` calls with the same email and `external_id`
returned one consumer and one `DUPLICATE_CONSUMER`. A third call returned `DUPLICATE_CONSUMER`.
The plugin's duplicate recovery then resolves the same consumer, so concurrent first checkouts
converge. The test consumer was deleted.

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

**Issue 3, P3: The cancellation schedule time is lost when events arrive out of order (F8).**
Folded into Issue 4, which has the same cause.

**Issue 4, P1: Stale-event suppression drops effects that StreamPay still confirms (F9, F10, F8).**
Staleness was measured against the provider's latest `updated_at`, so any later write turned a
retried or reordered event into a no-op. Judge a stale event against the fresh snapshot instead
(S8), and let stale renewal evidence clear `past_due` when it settles the latest invoice.

**Issue 5, P2: Renewal evidence revives a subscription without its billing slot (F11).** Share the
slot projection and S4 takeover between the reconcile and renewal paths.

**Issue 6, P3: Unreplayable pending events starve the due-event processor (F12).** Park them out of
the due queue, keep them open to StreamPay redelivery, and store the payload a redelivery carries.

**Issue 7, P2: Renewal callbacks are absorbed by other writers (F13).** Track the last handled
cycle in its own column, advanced only by renewal evidence.

**Issue 8, P1: Review findings (F14 to F24).** GPT-6.2 Astra and Gemini 4 Neon (high) reviewed
the branch independently, then re-reviewed the fixes. Both found F14. The re-review found F21's
first fix incomplete, plus F23 and F24. F14, F16, and F19 were gaps in the new code; the rest
were pre-existing.

Issues 4 to 8 are fixed on `ali/fix-stale-lifecycle-effects`. Regression tests:
`tests/integration/stale-lifecycle.test.ts` (F8 to F11, plus two guards: a contradicted stale
cancellation stays suppressed, and a late invoice that is not the latest keeps `past_due`) and
`tests/integration/due-queue.test.ts` (F12). The `renewal callbacks` tests in the first file cover
F13 and F14, including a legacy row without the marker; the revival tests cover F17; the due-queue
file covers F15 and F16; `tests/integration/review-findings.test.ts` covers F18 to F24. Every bug test fails on the code before its fix and passes after it.

### Open risks (not confirmed, not changed)

| ID | Risk | Why it is not fixed here |
| --- | --- | --- |
| R1 | Confirmed as F10 and fixed. | |
| R2 | `persistConsumerId` writes with `updateUser`, not a CAS on a null link. | Disproved live: StreamPay rejects a concurrent duplicate email or `external_id`, so both requests link the same consumer. |
| R3 | An unknown future provider status maps to `incomplete` on a live row. The row keeps its slot but loses access. | Fails closed. Handle new statuses explicitly when StreamPay adds them. |
| R4 | A dead-lettered renewal callback owner (machine 6) blocks renewal evidence for that subscription until it is replayed or discarded. | Intentional, to avoid a double callback. The operator needs to act. |
| R5 | Generic handler deliveries always use 5 attempts and ignore `maxWebhookAttempts`. | That option belongs to `subscriptions()`. Changing it is an API decision. |
| R6 | A callback that runs longer than the 2-minute lease can run concurrently with a redelivery. | Documented. Callbacks must be idempotent. |
| R7 | Fixed with F8 (Issue 4). | |
| R8 | Confirmed as F12 and fixed. Parked rather than dead-lettered, so StreamPay retries still count (W4). | |
| R9 | Confirmed as F13 and fixed. | |
| R10 | Confirmed as F17 and fixed. | |
| R11 | Renewal evidence for a subscription that is not yet linked to a local row is completed and dropped (`handleRenewalEvidence` finds no row). If the creation events fail past StreamPay's retry window and are replayed after a renewal, that cycle's `onSubscriptionRenewed` never runs. | Needs creation events to fail for about 20 hours across a billing boundary. Invoice events carry no plugin metadata, so the fix is to hold uncorrelated evidence for retry; left for a separate change. |
