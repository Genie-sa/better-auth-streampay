---
"better-auth-streampay": minor
---

Add server-authoritative checkout resolution, post-create persistence with payment-link
compensation, and fail-closed unique consumer linking.

Existing databases must add the generated unique index for `streampayConsumerId`; resolve duplicate
non-null values before applying that migration.

Consumer ownership conflicts and database failures now fail closed anywhere lazy consumer
provisioning runs, including checkout, portal, and subscriptions.
