---
"better-auth-streampay": major
---

Add authenticated hosted customer portal sessions, consumer-owned pagination, durable generic
webhook deduplication/replay, and typed partial-refund and successful-renewal handlers. Preserve
verified payloads before processing, reject invalid usage counts, and deny access for unmapped
provider products. A conditional database update prevents concurrent invoice and subscription
events from invoking the renewal callback twice for the same cycle. Inbox conflicts without a
visible row now retry instead of processing untracked callbacks. Persist the renewal callback
owner with the cycle update so replay recovers interrupted callbacks. Reject payment-link and
consumer mismatches when correlating checkout reservations. Explicitly map the no-argument
portal client call to POST.
Follow paginated consumer searches before creating a new consumer, and fence checkout cleanup
so a late provider failure cannot expire or delete a confirmed subscription.
Translate pagination to the current API's limit parameter and prevent stale lifecycle responses
from overwriting newer subscription state.
Dead-letter exhausted generic callbacks on the final permitted failure.

Require Better Auth 1.6.0 or later: 1.5's built-in SQL adapter compares NULL with equals, breaking
ungrouped billing reads and replay claims. Apply and explicitly backfill catalogMapped before
deployment; older migration generators omit static defaults. Add nullable renewalCallbackEventId
before deploying. Apply the inbox migration before
enabling generic callback deduplication.

Preserve consumed trial history and guard endpoint projections against concurrent webhook updates.
Handle active freeze windows and incomplete freeze pagination without false success. Accept RFC3339
offsets and reject unsafe integers and non-finite checkout metadata under both supported Zod majors.
Protect consumer identity from callback overrides, condition admin consumer deletion on its current
local owner, and safely decode discarded webhook IDs. Map server-resolved checkout to POST.
Register all supported events in the staging demo and accept checkout redirect query parameters.

Add an optional paginated freeze-history REST adapter for SDK 1.1.3. Cancellation and unfreeze
search later pages with progress checks and a bounded page count; configure the adapter to
resolve freezes beyond the SDK's first page.
