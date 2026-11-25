---
"better-auth-streampay": patch
---

Validate admin refund requests and check StreamPay after a busy or uncertain refund response without repeating the write. Keep the payment response shape and return a stable conflict code when a refund needs review. Reject subscription checkout links whose reported quote or billing interval conflicts with the configured plan. Keep provider bodies and messages out of plugin logs.
