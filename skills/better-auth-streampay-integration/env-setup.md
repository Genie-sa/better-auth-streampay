# Environment Variables

Every env var the plugin (or its test suite) reads, where to obtain each, and format constraints. Use this as the authoritative checklist when generating `.env` during Phase 6.

## Required at runtime

| Variable | Source | Format | Notes |
|---|---|---|---|
| `STREAMPAY_API_KEY` | StreamPay dashboard → API keys | Base64-encoded `apiKey:apiSecret` pair (single string) | Don't split it — pass the full Base64 blob to `StreamSDK.init()`. Rotating requires a re-deploy. |
| `BETTER_AUTH_SECRET` | Generated locally | Random string, **minimum 32 chars** | `openssl rand -hex 32` produces a good value. Used to sign Better Auth sessions; rotating it invalidates all current sessions. |
| `BETTER_AUTH_URL` | Your deployment | Absolute public URL | Required in prod. Dev can omit. Must match what the browser sees (`https://app.example.com`), not internal service names. |

## Required only when `webhooks()` is enabled

| Variable | Source | Format | Notes |
|---|---|---|---|
| `STREAMPAY_WEBHOOK_SECRET` | StreamPay dashboard → Webhooks → (your endpoint) → signing secret | Opaque string | Must be the secret for THIS endpoint, not a global one. Rotate by generating a new value in the dashboard and updating env atomically. |

## Optional / sandbox / testing

| Variable | Default | When to set |
|---|---|---|
| `STREAMPAY_BASE_URL` | `https://stream-app-service.streampay.sa` | Only when pointing at a non-prod StreamPay environment. Most users never set this. |
| `STREAMPAY_LIVE` | unset | Set to `1` to opt into the plugin's live integration test suite. Never set in prod. |
| `STREAMPAY_TEST_PRODUCT_ID` | unset | Real product UUID used by the optional live payment-link test. Required only if you want that test to run. |

## How to obtain each from the dashboard

1. **API key** — https://streampay.sa → API keys → "Generate". Copy the Base64 blob once; it's not shown again.
2. **Webhook signing key** — https://streampay.sa → Webhooks → create an endpoint pointing at `https://<your-domain>/api/auth/streampay/webhooks` → the signing key is revealed on creation.
3. **Product UUIDs** (for `checkout()`'s `products` list) — Products tab in the dashboard. Map each to a stable client-facing slug in code.

Full API reference: https://docs.streampay.sa/

## `.env.example` template (paste into the repo)

```env
# --- StreamPay ---
# Base64(apiKey:apiSecret) from https://streampay.sa → API keys
STREAMPAY_API_KEY=

# Webhook endpoint signing value (only if webhooks() is enabled)
# Register the URL https://<your-domain>/api/auth/streampay/webhooks first.
STREAMPAY_WEBHOOK_SECRET=

# --- Better Auth ---
# `openssl rand -hex 32` — min 32 chars
BETTER_AUTH_SECRET=
# Public URL of the app (required in production)
BETTER_AUTH_URL=
```

Mirror every key in a committed `.env.example` with blank values; keep real values only in `.env.local` / deployment stores.

## Handling rules

- **Never commit `.env` / `.env.local`.** Add them to `.gitignore` before the first commit.
- **Never log** `STREAMPAY_API_KEY` or `STREAMPAY_WEBHOOK_SECRET`. If a handler throws during dev, scrub these from stack dumps.
- **Rotate on personnel change.** Both StreamPay values can be rotated from the dashboard; do it any time access should be revoked.
- **Separate sandbox and prod keys.** Don't reuse a prod API key in staging; create a dedicated sandbox key and pair it with `STREAMPAY_BASE_URL` if your deployment needs it.
- **Use a managed store in prod.** Vercel, Railway, Fly, AWS — any sealed store. Raw `.env` files in CI are an anti-pattern.

## Quick verification

After setting values, a live sanity check:

```ts
import StreamSDK from "@streamsdk/typescript"
const client = StreamSDK.init(process.env.STREAMPAY_API_KEY!)
const consumers = await client.listConsumers({ page: 1, page_size: 1 })
console.log(consumers.meta) // should return a count, no throw
```

If this throws `HTTP 401/403`, the API key is wrong or revoked. If it throws a network error, check `STREAMPAY_BASE_URL`.

## What this plugin does NOT touch

- Database URL (managed by Better Auth / your ORM; typically `DATABASE_URL`)
- OAuth provider values (Google, Apple, etc. — Better Auth's concern)
- SMTP / transactional email (Better Auth or your own stack)

Only the four primary variables above are the plugin's responsibility.
