---
"better-auth-streampay": patch
---

Reject eager consumer recovery when another local account owns the consumer. Secure the unique
local claim before updating StreamPay's external ID during lazy recovery, and release failed
claims without erasing a replacement link. Check current database links before using cached
session consumer IDs in checkout, subscription creation, and portal requests. Clear missing
consumer links conditionally so concurrent relinking survives.

Simplify the README and move detailed examples into the integration guide.
