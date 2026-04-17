# Interview Questions

The 7–10 `AskUserQuestion` prompts this skill uses in Phase 2. Ask each question only if Phase 1 detection could not answer it. Questions marked **conditional** depend on earlier answers — skip them when the gate is not met.

## General rules

- Use one `AskUserQuestion` call per question (don't batch unrelated questions).
- Prefer `multiSelect: false` unless the question is genuinely multi-pick.
- Always include an `Other` or `Skip` option when the answer isn't known; never force a guess.
- If the user says "whatever you recommend," pick the safest default listed in each question below.

## Q1 — Framework (skip if auto-detected)

- **header**: `Framework`
- **question**: `Which HTTP framework is this app using?`
- **multiSelect**: `false`
- **options**:
  - `Next.js (App Router)` — Next 13+, route handlers in `app/`
  - `Next.js (Pages Router)` — `pages/api/`
  - `Hono`
  - `Elysia`
  - `Express`
  - `SvelteKit`
  - `Other` — ask follow-up for the framework name

**Drives**: webhook route file location (Phase 8), import style in `auth.ts`.

## Q2 — ORM (skip if auto-detected)

- **header**: `Database tooling`
- **question**: `How do you manage database schema?`
- **multiSelect**: `false`
- **options**:
  - `Drizzle` — has `drizzle.config.*`
  - `Prisma` — has `prisma/schema.prisma`
  - `Better Auth CLI` — let Better Auth own migrations
  - `Other / manual SQL`

**Drives**: Phase 7 migration command.

## Q3 — Sub-plugins to enable

- **header**: `Features`
- **question**: `Which StreamPay features do you want?`
- **multiSelect**: `true`
- **options** (all default-on unless the user deselects):
  - `Checkout` — payment links from slugs or product IDs
  - `Portal` — consumer state, subscriptions, invoices, payments read APIs
  - `Subscriptions` — cancel/freeze subscriptions from the client
  - `Webhooks` — receive signed events (payments, subs, invoices)
  - `Consumer sync only` — no sub-plugins, just create/update/delete consumers

**Drives**: the `use: [...]` array in `auth.ts` (Phase 4), whether Phase 8 runs, which env vars are needed (Phase 6).

## Q4 — When to provision StreamPay consumers

- **header**: `Consumer creation`
- **question**: `When should the plugin create a StreamPay Consumer for a user?`
- **multiSelect**: `false`
- **options**:
  - `Lazily, on first checkout (recommended)` — `createConsumerOnSignUp: false` (the default). Matches Stripe/Polar/Dodo conventions; signup stays off the StreamPay hot path, and users who never pay don't clutter the consumer table.
  - `Eagerly, at sign-up` — `createConsumerOnSignUp: true`. Use when your product needs portal/subscription data for a brand-new user before any payment has happened.

**Drives**: `createConsumerOnSignUp` boolean. Q5 (duplicate reclaim) and Q6 (custom fields) still apply in both modes — they run during both eager (`onBeforeUserCreate`) and lazy (`ensureConsumerForUser`) provisioning paths.

## Q5 — Duplicate reclaim policy (applies in both Q4 modes)

- **header**: `Duplicate consumers`
- **question**: `If a sign-up hits DUPLICATE_CONSUMER on StreamPay and the match is already linked to another external_id, how should the plugin behave?`
- **multiSelect**: `false`
- **options**:
  - `Never reclaim (safest default)` — omit `claimExistingConsumerBy` (or `[]`). Only reuses stranded consumers (empty external_id).
  - `Reclaim by email` — `["email"]`. Reassigns the linked consumer when its email matches.
  - `Reclaim by phone` — `["phone"]`.
  - `Reclaim by either email or phone` — `["email", "phone"]`.

**Drives**: `claimExistingConsumerBy` option. Explain the security trade-off inline (reclaim is convenient but lets a new user inherit a previous user's billing history — only enable when the app controls both sides of the identifier).

## Q6 — Custom consumer fields (applies in both Q4 modes)

- **header**: `Custom consumer fields`
- **question**: `Send any custom fields when creating a consumer?`
- **multiSelect**: `true`
- **options**:
  - `Phone number` — the user will pass `phone_number` per signup
  - `Preferred language` — `preferred_language` (e.g., `ar`, `en`)
  - `IBAN`
  - `Communication methods` — `WHATSAPP` / `EMAIL` / `SMS`
  - `None`

**Drives**: whether `getConsumerCreateParams` is added and which fields it returns. If the user selects any, scaffold `getConsumerCreateParams` in Phase 4 with `TODO` placeholders for where the per-user values come from (request body, session, database).

## Q7 — Checkout products (conditional on Q3 includes Checkout)

- **header**: `Checkout products`
- **question**: `How do you want to declare products?`
- **multiSelect**: `false`
- **options**:
  - `Static slug list` — user provides `{ slug, productId }[]` pairs now
  - `Dynamic lookup` — pass a function that resolves slugs at request time (e.g., from DB)
  - `Skip for now` — scaffold empty and let user fill in later

If static, collect pairs via a follow-up free-form prompt. Don't invent product IDs.

## Q8 — Checkout access (conditional on Q3 includes Checkout)

- **header**: `Checkout access`
- **question**: `Who can start checkout?`
- **multiSelect**: `false`
- **options**:
  - `Authenticated users only` — `authenticatedUsersOnly: true`
  - `Guests allowed` — default; anonymous users allowed

Second follow-up if guests allowed:
- **header**: `Contact info`
- **question**: `Collect EMAIL or PHONE at checkout for guests?`
- **options**: `EMAIL`, `PHONE`, `Let StreamPay decide`

## Q9 — Webhook events (conditional on Q3 includes Webhooks)

- **header**: `Webhook events`
- **question**: `Which StreamPay events should have handlers scaffolded?`
- **multiSelect**: `true`
- **options** (pick a reasonable subset — don't list every event):
  - `Payments (succeeded/failed/refunded)` — provision & revoke access
  - `Subscriptions (created/activated/canceled)` — sync entitlements
  - `Subscription lifecycle (frozen/unfrozen/renewal failed)` — edge-case handling
  - `Invoices (created/completed/canceled)` — finance integrations
  - `Catch-all only` — just `onPayload`, user will dispatch manually
  - `All of the above`

See [webhook-events.md](webhook-events.md) for the full event list and handler shapes.

## Q10 — Anonymous plugin (skip if auto-detected)

- **header**: `Anonymous users`
- **question**: `Does this app use the Better Auth anonymous plugin (guest sessions that later upgrade to real accounts)?`
- **multiSelect**: `false`
- **options**:
  - `Yes` — note: the StreamPay plugin intentionally skips anonymous users; consumers are created on upgrade, not on anonymous session creation
  - `No`
  - `Not sure` — grep the auth config yourself

**Drives**: a one-line note in the final summary so the user understands why no consumer is created for anonymous sessions.

## How to present results back

After the interview, echo the user's choices as a bullet list and confirm once:

> I'm about to: install X, add `streampay({ ... })` to `auth.ts`, enable Y sub-plugins, scaffold webhook handlers for Z events, and run a Drizzle/Prisma/CLI migration. Proceed?

Only proceed after explicit yes. If the user changes their mind, re-run only the affected questions.
