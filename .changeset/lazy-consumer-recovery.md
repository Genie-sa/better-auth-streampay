---
"better-auth-streampay": patch
---

Recover lazy consumer provisioning after a network or server failure by searching the auth user's exact external ID and enforcing the existing local ownership checks, without repeating the create request. Preserve provider validation, rate-limit, and unresolved duplicate-consumer statuses (422, 429, 409) instead of always returning a generic 500, and include provider status, code, and request ID in the existing error log.
