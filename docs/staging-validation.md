# Staging validation

Validated on 2026-10-10 against Stream sandbox, SDK 1.1.3 and Better Auth 1.7.7.
The minimum supported Better Auth version is 1.6.0; Zod 3.24 and Zod 4 are supported.
Tests cover the plugin's implemented features, not every feature of the Stream platform.

## Live coverage

| Feature | Evidence | Boundary |
| --- | --- | --- |
| Consumers | Authenticated creation and lookup; admin PATCH, read and delete passed. | Concurrent relinking and untrusted external IDs are covered by database regressions. |
| Hosted portal | A server-created session opened the dedicated consumer's portal in a browser. | Portal settings and catalog mappings control available self-service actions. |
| Recurring checkout | Declined and successful cards passed through sandbox 3DS; real events activated the local reservation. | No synthetic correlation was needed for activation. |
| One-off checkout | Server-resolved checkout, quantity two, required custom field, reference, metadata and 10% coupon produced a paid 1.80 SAR invoice. | Empty custom field blocked payment; the link allowed one payment. |
| Multi-product checkout | Two SAR products, quantity handling and a fixed coupon produced 3.80 SAR through the plugin and real API. | Quote/link validation only; this link was deactivated without payment. |
| Refunds | Partial refund, separate full refunds, admin refund and repeated-refund rejection passed. | This organization rejected a second refund after a partial refund; see discrepancy below. |
| Subscription cancellation | Cancel at period end, uncancel and repeated requests passed. | Stream does not immediately cancel an active subscription. |
| Seats and plans | Seat bounds, unchanged seats, scheduled seat increase, plan switch and cancellation of pending changes passed. | Changes were accepted for the next period; the future billing boundary was not observed. |
| Freezes | Scheduled freeze, cancel, repeated cancel, immediate freeze and unfreeze passed. | Same-calendar-day start/end was rejected by Stream, despite distinct timestamps. |
| Admin | Unauthenticated and ordinary users were rejected; all seven lists respected size=1; product/coupon CRUD and consumer update/delete passed. | Mutations used dedicated fixtures, which were deleted afterward. |
| Webhooks | Registration through the API accepted all 31 supported event types; real payment, invoice, subscription and refund deliveries reached the tunnel. | Registration does not prove all 31 event types were emitted in real flows. |
| Demo redirects | Success/failure query parameters are accepted by the local home route. | The tunnel exposes only the webhook route; interactive testing uses localhost. |

## Regression coverage

| Risk | Regression or staging proof |
| --- | --- |
| Unknown product retains old access | Plan projection and authenticated SQLite tests deny access while retaining billing diagnostics. |
| Generic callbacks run twice | SQLite integration overlaps deliveries; PostgreSQL gives one of eight contenders the claim. Admin replay works with either plugin order. |
| Crash loses payload | Initial claim retains payload/signature; PostgreSQL recovers an expired lease and fences stale completion/failure writes. |
| Inbox conflict loses tracking | A unique conflict with no visible row raises a retryable failure instead of running untracked callbacks. |
| Exhausted generic callback stays pending | The fifth failed delivery is durably dead-lettered immediately; later delivery does not run the callback again. |
| Invalid usage count grants access | Invalid numeric counts fail closed; live HTTP rejects negative, fractional, non-finite, and unsafe counts. |
| Hosted portal opens another consumer | Caller IDs are ignored; sessions require authentication, HTTPS, and no-store. Real portal opened as the dedicated consumer. |
| Portal hides later pages | Authenticated page 2 preserves ownership and returns provider pagination; invalid live page/size requests return 400. |
| Dynamic catalog stays stale | The upstream 2.2.1 resolver fix is retained and tested. |
| Renewal evidence invokes callbacks twice | PostgreSQL aligns invoice and subscription events at the same old cycle; a conditional update gives one callback winner. |
| Crash skips a renewal callback | SQLite simulates a lost update response and an interrupted worker; replay uses the durable callback owner. |
| Checkout activates the wrong reservation | Known payment-link and consumer mismatches cannot bind a pending checkout. |
| Portal client sends the wrong HTTP method | The real Better Auth client sends POST for the documented no-argument session call. |
| Consumer lookup misses an existing account | Exact identity searches follow pagination; later-page failures and repeated provider pages fail instead of creating a duplicate consumer. |
| Checkout cleanup overwrites activation | Conditional expiry/deletion preserves a reservation activated while a provider request is in flight. |
| Older response restores canceled access | A provider timestamp check and conditional projection prevent older activation writes from overwriting newer cancellation state. |
| Missing refund/renewal handlers | Dispatcher regressions cover both events; real partial/full-refund events reached the inbox. |
| Forged webhooks mutate billing | Missing, invalid, expired, or tampered signatures and malformed JSON were rejected through the public tunnel without adding inbox rows. |

The browser exercised a declined card through sandbox 3DS, then successful recurring checkout.
Repeated subscription upgrade reused its checkout link. Provider-created subscription, invoice,
payment, and activation events reconciled the local reservation into an active subscription without
synthetic correlation. A 1 SAR partial refund of the 80 SAR test payment returned
`PARTIALLY_REFUNDED`; a separate 1 SAR payment was fully refunded and returned `REFUNDED`.
Both invoices remained completed, as documented. Generic refund callbacks do not automatically
cancel a subscription; applications own their refund/access policy.

Provider discrepancy: refunding the remaining 79 SAR after the partial refund returned HTTP 400
`PAYMENT_REFUNDED_ALREADY`, both with an explicit amount and with the amount omitted. Stream's
current [webhook guide](https://docs.streampay.sa/webhooks/) describes cumulative refunds, but
this staging organization did not permit them. Do not assume multiple-refund support without
confirming it with Stream.

The paid subscription was scheduled to cancel at period end; Stream does not support immediate
cancellation of active subscriptions. Both checkout links completed their single allowed payment.

A same-price product switch was accepted and deferred to the next billing period; its pending
change was removed afterward. The earlier trial switch was blocked because it was scheduled to
cancel. Immediate transitions to an unmapped product are proven by deterministic tests, not by
waiting for a live billing boundary. General live write tests remain skipped to protect shared
fixtures. Long-duration renewal scheduling, real process termination during external side effects,
and all supported third-party database adapters remain outside this validation. Callbacks must
remain idempotent; these checks do not establish zero bugs.


## Remaining limits

SDK 1.1.3 does not expose pagination arguments for subscription freeze history. The plugin now
accepts a server-side `subscriptions({ listSubscriptionFreezes })` REST adapter to traverse pages
for cancellation and unfreeze. The demo configures it. Without the adapter, SDK-only integrations
retain the authoritative latest-freeze fallback and 409 when later pages cannot be resolved safely.
Live isolated plugin/API testing with one item per page canceled the scheduled freeze on page 5,
returned reused success on repeat, and unfroze the active freeze on page 6. The fixture returned
to ACTIVE with cancellation scheduled at period end.

Traversal rejects malformed/nonadvancing pages and stops after 100 pages; it never reports
absence after a partial or failed read.

| Freeze pagination risk | Protection |
| --- | --- |
| Later-page freeze is missed | Cancellation and unfreeze regressions find a target on page two. |
| Missing target falsely reported canceled after failed read | Later-page failures reject both actions without provider mutation. |
| Repeated or malformed pages | Invalid metadata/data, empty advancing pages and repeated IDs return 409. |
| Unbounded history traversal | A 100-page ceiling rejects continued history without mutation. |
| Foreign subscription leaks to REST callback | Ownership denial happens before the callback. |

Natural renewals, future scheduled transitions, every hosted-portal permission combination,
every payment method/currency, and every third-party database adapter have not been verified
end to end. Fixed-coupon application passed for SAR; the paid coupon flow used a percentage coupon.
USD product creation returned HTTP 400 in this organization, so USD checkout is not verified.
KWD product creation encountered an upstream HTTP 502; KWD checkout remains unverified.
Deterministic tests cover provider failures, ownership boundaries, duplicate/reordered events,
trial history, stale endpoint responses and database races. These checks cannot establish zero bugs.

Sources: [customer portal](https://docs.streampay.sa/customer-portal/),
[webhooks](https://docs.streampay.sa/webhooks/), and the current public API reference.
