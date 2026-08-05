---
"better-auth-streampay": minor
---

Organization billing and server-initiated billing endpoints.

Who gets billed needs no configuration: HTTP endpoints bill the session user; the new server-only endpoints bill the reference.

- `organization: { enabled: true }` on the StreamPay options makes organization references billable: the org gets its own StreamPay consumer, stored on a new `organization.streampayConsumerId` column (schema contribution, gated behind the option). Optional `organization.getBillingDetails` supplies contact/tax fields; `name`, `email`, and `external_id` stay plugin-owned. Org consumers carry `external_id: "ref:organization:<orgId>"`.
- New server-only endpoint `auth.api.upgradeSubscriptionForReference` (no HTTP route, better-auth `createAuthEndpoint.serverOnly`): trusted server code starts a subscription checkout billed to any user or organization. No session, no `authorizeReference` — the caller is the gate — while every validation and billability check still runs.
- New server-only endpoint `auth.api.checkoutForReference`: the one-time-payment counterpart — creates a payment link billed to any user or organization, with validated `referenceId`/`referenceType` attribution in the link's `custom_metadata`. The HTTP `checkout` endpoint is unchanged.
- New typed error codes: `SUBSCRIPTION_ORG_BILLING_NOT_ENABLED`, `ORG_NOT_FOUND`, `BILLING_CONTACT_REQUIRED`, `SUBSCRIPTION_REFERENCE_USER_NOT_FOUND`, `SUBSCRIPTION_REFERENCE_USER_NOT_BILLABLE`.
- Requires better-auth ≥ 1.6.23 (`createAuthEndpoint.serverOnly`).
