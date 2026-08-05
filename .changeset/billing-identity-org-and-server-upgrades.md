---
"better-auth-streampay": major
---

Organization billing and server-initiated billing endpoints.

Who gets billed needs no configuration: HTTP endpoints bill the session user; the new server-only endpoints bill the reference.

- `organization: { enabled: true }` on the StreamPay options makes organization references billable: the org gets its own StreamPay consumer, stored on a new `organization.streampayConsumerId` column (schema contribution, gated behind the option). Org consumers carry `external_id: "ref:organization:<orgId>"`. The Better Auth organization plugin is required; startup fails fast when it is missing or when its table name does not match `organization.modelName`.
- `organization.getBillingDetails` supplies contact and tax fields, including a billing `email` (organizations have none of their own); `name` and `external_id` stay plugin-owned. New exported types: `BillingOrganization`, `OrganizationBillingOptions`, `OrganizationConsumerOverrides`.
- New server-only endpoint `auth.api.upgradeSubscriptionForReference` (no HTTP route, better-auth `createAuthEndpoint.serverOnly`): trusted server code starts a subscription checkout billed to any user or organization. No session, no `authorizeReference` — the caller is the gate — while every validation and billability check still runs.
- New server-only endpoint `auth.api.checkoutForReference`: the one-time-payment counterpart — creates a payment link billed to any user or organization, with validated `referenceId`/`referenceType` attribution in the link's `custom_metadata` and in `onCheckoutCreated`. The link allows one payment by default (`maxNumberOfPayments` overrides). The HTTP `checkout` endpoint is unchanged.
- Pending subscription checkouts are only resumed when they bill the same StreamPay consumer — a link created for one payer is never handed to another. Webhook reconciliation refuses a provider subscription whose consumer differs from the stored payer (existing-ID, protected, and fallback paths), and a provider payload without a consumer never clears the stored payer.
- Consumer ownership is checked across models on every claim path — lazy provisioning, signup adoption (`createConsumerOnSignUp` + `claimExistingConsumerBy`), and organization provisioning — including after organization billing is later disabled. A cross-model claim fails with `STREAMPAY_CONSUMER_LINK_CONFLICT`. The checks are reads before writes, not a single transaction; a same-instant claim of one consumer from both models remains a known, narrow race.
- Organization consumer claims are compare-and-set: concurrent first checkouts settle on one consumer. A consumer created by a losing or failed claim is deleted best-effort, only after re-checking that no account linked it.
- Organization upgrades grant no trial when `isTrialEligible` is configured (the policy is user-scoped, so it fails closed); the default first-subscription trial still applies without the callback.
- `BILLING_CONTACT_REQUIRED` is raised only when StreamPay's field-level validation details name `email` or `phone_number`; other provider validation errors pass through unchanged.
- New typed error codes: `SUBSCRIPTION_ORG_BILLING_NOT_ENABLED`, `ORG_NOT_FOUND`, `BILLING_CONTACT_REQUIRED`, `SUBSCRIPTION_REFERENCE_USER_NOT_FOUND`, `SUBSCRIPTION_REFERENCE_USER_NOT_BILLABLE`.
- BREAKING: requires better-auth ≥ 1.6.17 (`createAuthEndpoint.serverOnly`); better-auth 1.5.x is no longer supported.
