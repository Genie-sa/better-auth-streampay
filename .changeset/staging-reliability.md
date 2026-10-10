---
"better-auth-streampay": major
---

Add authenticated hosted customer portal sessions, consumer-owned pagination, durable generic
webhook deduplication/replay, and typed partial-refund and successful-renewal handlers. Preserve
verified payloads before processing, reject invalid usage counts, and deny access for unmapped
provider products. A conditional database update prevents concurrent invoice and subscription
events from invoking the renewal callback twice for the same cycle. Inbox conflicts without a
visible row now retry instead of processing untracked callbacks.

Require Better Auth 1.6.0 or later: 1.5's built-in SQL adapter compares NULL with equals, breaking
ungrouped billing reads and replay claims. Apply and explicitly backfill catalogMapped before
deployment; older migration generators omit static defaults. Apply the inbox migration before
enabling generic callback deduplication.
