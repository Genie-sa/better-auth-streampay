# What each piece does

Use this when the user asks "what do I actually need?". Plain-language
descriptions first, technical details second. The plugin source under
`node_modules/better-auth-streampay/dist` is the source of truth.

## How they fit together

`streampay({ client, use: [...] })` is the root. You add only the
pieces the user picked — extras add endpoints and (for subscriptions)
database tables, so don't enable things "just in case".

## Checkout — `checkout()`

**Plain English**: "When someone clicks Buy, we send them to a hosted
StreamPay checkout page. They pay, StreamPay redirects them back."

**Use it when**: the app sells anything — one-time purchases, paid
tiers, top-ups, donations.

**Pairs nicely with**: `webhooks()` (so you know when payment
succeeds), `portal()` (so users can see their receipts).

**Skip it when**: subscriptions are managed entirely from the
dashboard with no in-app purchase flow.

## Customer portal — `portal()`

**Plain English**: "Read-only views for the logged-in user — their
subscriptions, their invoices, their payments."

**Use it when**: the app has a "Billing", "My subscription", or
"Receipts" page.

**Pairs nicely with**: `subscriptions()` (so users can also cancel or
freeze from the same page).

**Skip it when**: there's no user-facing billing UI.

## Subscriptions — `subscriptions()`

**Plain English**: "Recurring tiers like Free / Pro / Team, with
upgrade, change-plan, cancel, freeze, and feature gating helpers
(`hasFeature`, `checkLimit`)."

**Use it when**: the app has recurring pricing tiers with feature
gates or usage limits.

**Pairs nicely with**: `webhooks()` (basically required — without it,
the local subscription state will drift from StreamPay), `portal()`.

**What the user provides**: a `plans` array (or async factory) — each
plan has a `name`, `productId`, `priceHalalat`, `billingInterval`,
optional `group`, optional `limits`. The plugin checks the shape at
startup and throws on duplicates or missing fields.

**Owns these tables**: `subscription` (per-user state) and
`streampayWebhookEvent` (used to dedupe webhook deliveries).

**Skip it when**: subs are handled outside the app and you only need
to react to webhook events.

## Admin / back-office — `admin()`

**Plain English**: "Internal-only endpoints for support staff and ops
— refunds, looking up consumers, managing products and coupons."

**Use it when**: the team needs an internal back-office (support
issuing refunds, ops creating coupons, finance pulling invoice data).

**How admins are identified**: by default the plugin checks for
`adminRoles: ["admin"]` against `user.role` (matches Better Auth's
`admin()` plugin's role field). For anything custom (an email
allow-list, organization membership, etc.), pass an `isAdmin(user,
ctx)` callback.

**Skip it when**: admin work happens entirely in the StreamPay
dashboard.

## Webhooks — `webhooks()`

**Plain English**: "StreamPay tells your server when something
happens — payment succeeded, subscription renewed, invoice paid. The
plugin verifies the signature and routes each event to your handler."

**Use it when**: the app reacts to anything that happens off-session.

**Required when**: `subscriptions()` is enabled. Without webhooks,
local subscription state won't stay in sync with StreamPay.

**Skip it when**: the app is read-only (lists data but never reacts
to changes).

**Standalone alternative**: if the user doesn't want a Better Auth
handler at all, the package exports `verifyWebhook` /
`verifyWebhookOrThrow` for manual verification.

## Quick "which do I need?"

| The user wants… | Suggest |
|---|---|
| Sell a one-time product / take a payment | `checkout` + `webhooks`. Add `portal` if you show receipts. |
| Pricing tiers (Free / Pro / Team) | `subscriptions` + `webhooks` + `portal` (+ `checkout` if you also sell add-ons) |
| An internal refund or support tool | `admin` (on top of whatever else) |
| Just verify webhook signatures, no plugin | None — point them at the `verifyWebhook` standalone export |
| Manage everything in the dashboard, app just reacts | `webhooks` only |

## What none of them do

- Create things in the StreamPay dashboard (products, coupons, webhook endpoints) — that's a dashboard task.
- Implement business logic — handlers come scaffolded with TODO bodies.
- Manage API keys.
- Replace Better Auth's own `admin()` plugin role field — StreamPay's `admin()` is a back-office tool, not a general role manager.
