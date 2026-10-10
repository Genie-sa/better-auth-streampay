---
"better-auth-streampay": minor
---

Add opt-in durable generic webhook deduplication and authenticated replay, authenticated hosted customer portal sessions, portal pagination, and
typed partial-refund/successful-renewal handlers. Preserve verified payloads before processing,
refresh dynamic catalogs, reject invalid limit counts, and deny access for unmapped provider
products. Apply the catalogMapped column migration before deployment and the webhook inbox
migration before enabling generic callback deduplication.
