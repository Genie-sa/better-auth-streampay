# Domain glossary

Names for the concepts the code is organized around. `docs/state-machines.md` holds the states,
invariants, and transitions for each one.

| Term | Meaning | Module |
| --- | --- | --- |
| Webhook inbox | The `streampayWebhookEvent` table and the only code that claims, leases, completes, fails, dead-letters, parks, replays, and discards its rows. | `src/webhooks/inbox.ts` |
| Inbox scope | One kind of work the inbox runs for a StreamPay event: subscription sync (unprefixed event IDs) or generic handlers (`handlers:` prefix). A scope supplies its work, failure classifier, attempt budget, and discard hook. | `subscriptionInboxScope` (`subscriptions/sync.ts`), `plugins/webhooks.ts` |
| Parked event | A pending inbox event that cannot be replayed. It leaves the due queue but stays pending so a StreamPay redelivery can complete it. | `webhooks/inbox.ts` |
| Slot | `subscription.activeSlotKey`: the unique key that lets one live or reserved subscription exist per reference and plan group. | `subscriptionSlotKey` (`subscriptions/types.ts`) |
| Checkout reservation | An `incomplete` subscription row that holds the slot while the customer is on StreamPay's hosted checkout. It owns its payment link and is released, replaced, or yielded to a paid subscription. | `subscriptions/checkout-reservation.ts` |
| Projection | The local subscription fields derived from a StreamPay snapshot and the plan catalog. Every projection write is guarded by the lifecycle write guard and resolves conflicts by retrying (webhooks) or keeping the newer local row (endpoints). | `subscriptions/reconcile.ts` |
| Consumer link | `user.streampayConsumerId`: the one-to-one link between a user and a StreamPay consumer. The stored value always wins over a session copy. | `src/utils/consumer-link.ts` |
