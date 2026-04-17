---
name: better-auth-streampay-integration
description: >
  Set up the `better-auth-streampay` plugin end-to-end in a Better Auth app —
  consumers, checkout, portal, subscriptions, and signed webhooks. Use when
  the user asks to integrate StreamPay with Better Auth, add payments to
  their auth flow, install `better-auth-streampay`, wire up the StreamPay
  webhook, scaffold a checkout flow backed by Better Auth, or set up the
  consumer portal. Covers framework detection, a guided interview via
  AskUserQuestion, the sub-plugin reference, webhook event catalog, code
  templates for Next.js / Hono / Elysia / Express, migrations per ORM, and
  troubleshooting for duplicate consumers and webhook signature failures.
---

# Better Auth + StreamPay Integration

Interview the user to learn what they're building, then wire the
`better-auth-streampay` plugin into their app: consumer creation on
sign-up, checkout flow, customer portal, subscription management, and
signature-verified webhooks. Do NOT guess answers the repo can tell you —
detect first, ask only what can't be inferred.

## Reference files

- [interview-questions.md](interview-questions.md) — the 7–10 `AskUserQuestion` prompts with exact options and conditionals
- [plugin-reference.md](plugin-reference.md) — every option across `streampay()` and the sub-plugins, with types
- [webhook-events.md](webhook-events.md) — full event catalog + recommended handler patterns
- [code-templates.md](code-templates.md) — copy-adapt snippets: server `auth.ts`, client, webhook route per framework, env, migrations
- [troubleshooting.md](troubleshooting.md) — `DUPLICATE_CONSUMER`, webhook signature failures, missing columns, anonymous users

## External docs (fetch if you hit an unknown)

- Plugin source + README: https://github.com/y0u-0/better-auth-streampay
- StreamPay API docs: https://docs.streampay.sa/
- StreamPay dashboard: https://streampay.sa
- Better Auth: https://better-auth.com

## Workflow

### Phase 1 — Detect (no questions yet)

Read the repo before asking anything. Skip questions the answer to which is already on disk.

1. Framework — from `package.json` dependencies:
   - `next` → Next.js (check `app/` vs `pages/` for router)
   - `hono` → Hono
   - `elysia` → Elysia
   - `express` → Express
   - `@sveltejs/kit` → SvelteKit
   - none obvious → ask in Phase 2
2. ORM — from the repo root:
   - `drizzle.config.*` → Drizzle
   - `prisma/schema.prisma` → Prisma
   - neither → assume Better Auth CLI migration
3. Better Auth install point — grep for `betterAuth(` to find `auth.ts` / `lib/auth.ts` / `server/auth.ts`. Note the exact file path for edits.
4. Existing plugins — scan the `plugins: [...]` array. Note: `anonymous()` presence, existing `streampay()` (abort if present).
5. Package manager — lockfile: `bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm.

Record findings before moving to Phase 2.

### Phase 2 — Interview

Ask the questions in [interview-questions.md](interview-questions.md) via `AskUserQuestion`. Skip any question the Phase 1 detection already answered. Some questions are conditional — read the file.

### Phase 3 — Install dependencies

Install using the detected package manager. See [code-templates.md](code-templates.md) §Dependencies for the exact commands.

```
better-auth-streampay @streamsdk/typescript
```

Also ensure `better-auth` and `zod` are present (peer deps).

### Phase 4 — Wire the server

Edit the user's `auth.ts` (located in Phase 1). Compose only the sub-plugins the user selected. Use the server template in [code-templates.md](code-templates.md) §Server. Key decisions already answered by the interview:

- `createConsumerOnSignUp` — boolean
- `claimExistingConsumerBy` — `"email" | "phone" | "both" | null`
- `getConsumerCreateParams` — include only if custom fields were selected
- `use: [...]` — only the sub-plugins the user picked

Full option list: [plugin-reference.md](plugin-reference.md).

### Phase 5 — Wire the client

If the app has a Better Auth client (`createAuthClient`), add `streampayClient()` to its `plugins` array. See [code-templates.md](code-templates.md) §Client.

### Phase 6 — Environment

Add to `.env` (or `.env.local` for Next.js). Never print secrets; leave placeholder values. See [code-templates.md](code-templates.md) §Environment.

- `STREAMPAY_API_KEY=`
- `STREAMPAY_WEBHOOK_SECRET=` (only if `webhooks()` selected)

### Phase 7 — Database migration

The plugin adds a `streampayConsumerId` column to `user`. Run the migration using the ORM detected in Phase 1. See [code-templates.md](code-templates.md) §Migrations.

### Phase 8 — Webhook route (if `webhooks()` selected)

The plugin exposes the webhook at `/api/auth/streampay/webhooks` via Better Auth's handler — no manual route needed if the Better Auth handler is already mounted. Verify it IS mounted; if not, wire it per [code-templates.md](code-templates.md) §Framework routes.

Then tell the user: register `https://<their-domain>/api/auth/streampay/webhooks` in the StreamPay dashboard and copy the webhook secret back to `.env`.

### Phase 9 — Verify

1. Run typecheck: `tsc --noEmit` (or the project's equivalent).
2. Run the dev server and visit an auth route — confirm no boot errors.
3. If `createConsumerOnSignUp` is on, sign up a test user; confirm `streampayConsumerId` is populated on the `user` row.
4. Summarize for the user: which sub-plugins were enabled, which webhook events are handled, where to add business logic.

## Decision tree (quick)

- No Better Auth in repo? → abort, tell the user to set up Better Auth first (point to https://better-auth.com).
- `streampay()` already in the plugins array? → abort, ask whether to reconfigure vs leave alone.
- User needs only webhook verification (no Better Auth integration)? → point them at the standalone `verifyWebhook` export; do NOT run this workflow.

## Non-goals

- Does NOT create StreamPay dashboard objects (products, webhook endpoints) — user does that in the StreamPay UI.
- Does NOT write business logic inside webhook handlers — only scaffolds the handler shape.
- Does NOT manage StreamPay API keys or rotate secrets.
- Does NOT migrate an existing Stripe/Paddle/etc. integration to StreamPay — fresh setups only.

## Completion criteria

- [ ] Phase 1 detection recorded (framework, ORM, auth file path, package manager)
- [ ] Interview answered (or skipped via detection) per [interview-questions.md](interview-questions.md)
- [ ] `better-auth-streampay` + `@streamsdk/typescript` installed
- [ ] Server `auth.ts` imports and composes `streampay(...)` with only the user-selected sub-plugins
- [ ] Client `createAuthClient` includes `streampayClient()` (if a client exists)
- [ ] `.env` has `STREAMPAY_API_KEY` (and `STREAMPAY_WEBHOOK_SECRET` if webhooks selected)
- [ ] Migration run; `user.streampayConsumerId` column exists
- [ ] `tsc --noEmit` passes on edited files
- [ ] Final summary given: what was enabled, what the user must do in the StreamPay dashboard, which handler bodies they still need to implement
