---
name: better-auth-streampay-integration
description: Wires the better-auth-streampay plugin into a Better Auth project — consumers, hosted checkout, billing portal, subscription tiers, admin back-office, and signed webhooks. Use when the user asks to add StreamPay to a Better Auth app, install better-auth-streampay, scaffold checkout / portal / subscriptions / admin / webhooks, migrate from Stripe / Paddle / Lemon Squeezy to StreamPay, replace bespoke StreamPay code with the plugin, or upgrade an existing install. Reads the plugin source and the user's repo first; interviews only for what detection can't answer.
license: MIT
metadata:
  author: Genie-sa
  homepage: https://github.com/Genie-sa/better-auth-streampay
---

# Better Auth + StreamPay Integration

## When to skip this skill

- No Better Auth in the repo — point the user at https://better-auth.com first.
- The user only needs webhook signature verification with no plugin — use the standalone `verifyWebhook` export ([code-templates.md §Verifying webhooks without the plugin](references/code-templates.md#verifying-webhooks-without-the-plugin)).

## Reference files

| File | When to load |
|---|---|
| [plugins-overview.md](references/plugins-overview.md) | When the user asks "what does each piece do?" or "which do I need?" |
| [interview-questions.md](references/interview-questions.md) | The thing-to-know decisions and phrasing templates for `AskUserQuestion` |
| [plugin-reference.md](references/plugin-reference.md) | Option names and types for `streampay()` and every sub-plugin |
| [webhook-events.md](references/webhook-events.md) | The list of events StreamPay sends and what to do with each |
| [code-templates.md](references/code-templates.md) | Server / client / framework route / migration snippets |
| [env-setup.md](references/env-setup.md) | Which env vars to set and where to get the values |
| [troubleshooting.md](references/troubleshooting.md) | If something breaks, look here first |

External:

- Plugin: https://github.com/Genie-sa/better-auth-streampay
- StreamPay docs: https://docs.streampay.sa
- Better Auth: https://better-auth.com

## Instructions

Most users picking up this skill aren't payment experts. Do the
technical work yourself, ask only what the user can answer, explain
choices in plain language, and check in before editing.

### Working principles

- **Friendly tone.** Don't lecture or dump jargon. "We can do A or B — A is simpler, B is more flexible. Want me to pick?" beats "Compose the plan catalog with explicit `group` discriminators".
- **Read first.** The plugin source under `node_modules/better-auth-streampay/dist` and the user's own repo answer most of the questions. Don't put work on the user that you can do yourself.
- **Deep-read before client-side glue.** Cache invalidation, success-page handling, redirect detection depend entirely on the project's state library, router, and existing patterns. Read what they already use and mirror it — don't paste from training data.
- **Suggest, don't dictate.** Propose a sensible default and let the user redirect: "I'd start with checkout + webhooks for a typical store. Sound good?"
- **One question at a time.** Use `AskUserQuestion` per question. No giant forms.
- **Confirm before editing.** Recap the plan in plain English, wait for "yes".

### The plan

Copy this checklist; tick items as you go.

- [ ] Look at the user's repo
- [ ] Read the plugin (once installed)
- [ ] Ask any questions the repo didn't answer
- [ ] Recap what you're about to do, get a "yes"
- [ ] Install the plugin and write the changes
- [ ] Set up env vars and run the database migration
- [ ] Quick smoke test

### Step 1 — Look at the repo

Most of the interview is answerable by reading. Find:

- **Repo shape**: monorepo or single app. Auth and DB schema usually live in separate packages in monorepos.
- **Framework**: Next.js (app vs pages), Hono, Elysia, Express, SvelteKit, TanStack Start, …
- **ORM**: Drizzle, Prisma, or none (= Better Auth CLI manages schema).
- **Better Auth file**: the file that calls `betterAuth(...)`. Note the pattern — inline vs factory — and the existing `plugins: [...]`. If `streampay()` is already there, stop and check with the user.
- **Better Auth version**: must be `^1.4.0`. In monorepos check catalogs / workspace dependencies.
- **Package manager**: from the lockfile.
- **Client**: the file that calls `createAuthClient(...)`, if any.
- **State / data layer + return-URL handling**: what powers client-side data (TanStack Query, SWR, router loaders, plain fetch, …) and whether the app already handles a payment return URL. Need this before any post-checkout glue.
- **Handler mount**: where `/api/auth/*` is wired. If it only allows GET+POST, you'll need to widen to PATCH/PUT/DELETE for admin endpoints.
- **Env file location**: monorepos often put env in `apps/<server>/.env`, not root.
- **Existing payment code**: Stripe, Paddle, Lemon Squeezy, or bespoke StreamPay. If anything's there, list every touched file before proposing edits.

### Step 2 — Read the plugin

If the plugin isn't installed yet, install it first (Step 5's first
action) — that's the easiest way to see real types. If you can't
install yet, fetch from
`https://github.com/Genie-sa/better-auth-streampay` and read `src/`.

Once available, skim:

- `dist/index.d.ts` — every option, every export
- `dist/index.js` (or `src/`) — the actual endpoint paths each sub-plugin registers
- `WebhookHandlers` type — the exact handler keys (e.g. `onPaymentSucceeded`)

When this skill's references and the plugin source disagree, the
source wins.

### Step 3 — Ask only what's unknown

Not a fixed form. Work out what's still unknown after Step 1 and the
user's original request, then ask just those things — in the user's
own words.

[interview-questions.md](references/interview-questions.md) is the menu of
"things you might need to know" with signals that answer each one and
suggested phrasing. Use it as a checklist of decisions, not a script.

Rules of thumb:

- If the request itself answered it ("add subscriptions"), don't ask "do you want subscriptions?"
- If the codebase shows it (framework, ORM, existing payment code, role plugin), don't ask
- One `AskUserQuestion` per decision — never batch
- Propose your best guess first: "I'd start with checkout + webhooks based on what you described — sound right?"
- If the user is confused about a choice, load [plugins-overview.md](references/plugins-overview.md) and explain in one sentence per option

### Step 4 — Recap, get a "yes"

Show the user a short bullet list of what you plan to do — in plain
English. Example:

> Here's what I'll change:
> - Install `better-auth-streampay` in `packages/auth`
> - Add the plugin to your Better Auth config (checkout + webhooks)
> - Add `STREAMPAY_API_KEY` and `STREAMPAY_WEBHOOK_SECRET` to `apps/server/.env`
> - Regenerate your Drizzle schema and run a migration
>
> Want me to go ahead?

If replacing existing payment code, also list every file that'll be
touched. Wait for "yes" before editing.

### Step 5 — Make the changes

1. **Install** `better-auth-streampay @streamsdk/typescript` in the workspace where `auth.ts` lives (in monorepos, that's usually the auth package, not the root). Make sure peers `better-auth ^1.4.0` and `zod ^3.24 || ^4` are present.
2. **Edit the auth file**. Add only the sub-plugins the user picked. Templates: [code-templates.md](references/code-templates.md). Option names: [plugin-reference.md](references/plugin-reference.md).
3. **For factory patterns** (`createAuth() { return betterAuth({...}) }`), add `streampay()` to the inner `plugins: [...]` array — don't refactor the function shape.
4. **Initialize the StreamPay SDK once** at module scope and pass it in as `streampay({ client })`.
5. **If there's a Better Auth client file**, add `streampayClient()` to its plugins array.
6. **Write env vars** to the right `.env` (root for single apps, `apps/<server>/.env` for monorepos). Mirror in `.env.example` with empty values. See [env-setup.md](references/env-setup.md).
7. **Database**:
   - Better Auth CLI / no BYO schema: `npx @better-auth/cli migrate` adds plugin fields automatically.
   - BYO Drizzle/Prisma: `npx @better-auth/cli generate --config <path/to/auth.ts>` first, then run the ORM migration. Confirm `user.streampayConsumerId` exists, plus `subscription` and `streampayWebhookEvent` if subscriptions are enabled.
8. **Handler mount** at `/api/auth/*` with all HTTP methods (GET, POST, PATCH, PUT, DELETE). The webhook URL `/api/auth/streampay/webhooks` is automatic.
9. **Wire the client to refresh after checkout.** Webhooks update the server; the client keeps rendering the stale tier until something tells it to refetch. On the return URL, call `authClient.subscriptionSuccess({ subscriptionId })` and invalidate whatever cache the project already uses for subscription reads. Don't invent the pattern — read their state/router setup and mirror it. Concept-only notes: [code-templates.md §After checkout — refreshing the client](references/code-templates.md#after-checkout--refreshing-the-client).

### Step 6 — Quick smoke test

1. Run a typecheck.
2. Boot the dev server. If subscriptions are on with malformed plans, the plugin throws at startup — show that error verbatim, it's helpful.
3. Sign up a test user; confirm `streampayConsumerId` populates (or first checkout populates it, in lazy mode).
4. If webhooks are on: have the user register `https://<their-host>/api/auth/streampay/webhooks` in the StreamPay dashboard, paste the secret into `STREAMPAY_WEBHOOK_SECRET`, then send a test event from the dashboard. Confirm a 200.

**Local webhook testing.** StreamPay can't reach `localhost`. Expose
the dev server publicly with one of:

- `cloudflared tunnel --url http://localhost:<port>` (no signup; URL rotates per restart)
- `ngrok http <port>` (account required; stable URLs on paid plan)

Register the public URL + `/api/auth/streampay/webhooks` in the
dashboard, then paste the dashboard-shown signing secret into
`STREAMPAY_WEBHOOK_SECRET`.

### Step 7 — Wrap up

Send a friendly summary. Cover:

- Sub-plugins enabled
- Webhook handler bodies the user still needs to fill in (TODOs)
- Database changes
- Action items for the StreamPay dashboard (create products, register the webhook URL)

Keep it short. Encourage the user to come back if anything errors.

## Examples

### "Add StreamPay to my SaaS for subscriptions"

Best opening guess, before asking anything: `subscriptions + webhooks
+ portal`. Read the auth file, the package.json, the schema. If
everything is detectable, the only question worth asking is the plan
catalog — and even that may be skippable if the user mentions a
pricing page or sends tier names.

### "I have a Stripe integration, switch to StreamPay"

Open with an inventory: list every Stripe-touching file before
proposing edits. Ask the user what they want to keep, what they want
replaced. Set expectations: payment methods don't transfer between
providers; active subs need re-enrollment.

### "Just verify webhook signatures, no Better Auth wiring"

Don't run the workflow. Point at the standalone `verifyWebhook` /
`verifyWebhookOrThrow` exports and show a 5-line snippet from
[code-templates.md §Verifying webhooks without the plugin](references/code-templates.md#verifying-webhooks-without-the-plugin).

## Common Pitfalls

| Pitfall | Avoidance |
|---|---|
| BYO Drizzle/Prisma schemas don't auto-add the plugin's `streampayConsumerId` / `subscription` / `streampayWebhookEvent` | Run `npx @better-auth/cli generate --config <path/to/auth.ts>` after installing, before the migration |
| Handler mount only registers GET + POST | Admin endpoints use PATCH/PUT/DELETE — widen the methods |
| Skipping `webhooks()` when subscriptions are enabled | Subscription state silently drifts. Webhooks aren't optional in this combo |
| Inventing product UUIDs the user doesn't have yet | Leave placeholders; the user creates products in the StreamPay dashboard |
| Reading the interview questions verbatim | They're decision templates — adapt them to the user's tone and request |
| Eager-creating customers without verified email/phone + reclaim | Reclaim transfers billing history. Default to "don't reuse" unless verification is in place |
| Editing files before recap | Always confirm scope first |

See [troubleshooting.md](references/troubleshooting.md) for runtime failure
modes (signature errors, missing columns, plan validation, admin 405s,
duplicate webhooks).

## What this skill won't do

- Create products, coupons, or webhook endpoints in the StreamPay dashboard — the user does that in the dashboard UI.
- Fill in webhook handler bodies with business logic — leaves clearly-marked TODOs.
- Manage or rotate API keys.

## Done when

- [ ] Detection notes recorded
- [ ] Plugin source read for the surface being touched
- [ ] Interview answered (or skipped via detection)
- [ ] Plain-English recap shared and the user said yes
- [ ] Dependencies installed (peers verified)
- [ ] Auth file composes only the user-selected sub-plugins
- [ ] Client updated (if there is one)
- [ ] `.env` + `.env.example` updated
- [ ] Migration run; tables/columns confirmed
- [ ] Typecheck passes
- [ ] Friendly summary delivered with clear next steps
