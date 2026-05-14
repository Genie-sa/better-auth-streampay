# Environment variables

Which env vars the plugin needs, where to grab the values, and how to
keep them safe. Always use placeholders — never paste real secrets
into files.

## Always required

| Variable | Where it comes from | What it looks like |
|---|---|---|
| `STREAMPAY_API_KEY` | StreamPay dashboard → API keys → Generate | One Base64 blob (it's `apiKey:apiSecret` encoded together — pass it as-is to `StreamSDK.init()`) |
| `BETTER_AUTH_SECRET` | Generate locally with `openssl rand -hex 32` | 32+ random characters |
| `BETTER_AUTH_URL` | Your deployment | The full public URL, e.g. `https://app.example.com`. Required in production |

## Required only when webhooks are on

| Variable | When | Notes |
|---|---|---|
| `STREAMPAY_WEBHOOK_SECRET` | If `webhooks()` is in `use: [...]` | The signing secret for the webhook endpoint you just registered. Set this AFTER registering `https://<host>/api/auth/streampay/webhooks` in the StreamPay dashboard |

## Optional / sandbox

| Variable | When |
|---|---|
| `STREAMPAY_BASE_URL` | Pointing at a non-production StreamPay environment |
| `STREAMPAY_LIVE` | Plugin's own integration tests (don't set in user apps) |
| `STREAMPAY_TEST_PRODUCT_ID` | Plugin's own test suite |

## Where to find each in the dashboard

- **API key** — https://streampay.sa → API keys → Generate. Shown ONCE — copy it the moment it appears.
- **Webhook signing secret** — https://streampay.sa → Webhooks → create endpoint → secret revealed on creation.
- **Product UUIDs** (for plans / checkout product list) — Products tab.

## `.env.example` template

```env
# StreamPay
STREAMPAY_API_KEY=
STREAMPAY_WEBHOOK_SECRET=

# Better Auth
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
```

Mirror every key in `.env.example` with empty values. Real values
stay in `.env.local` (or whichever local env file Better Auth reads,
which can be `apps/server/.env` in a monorepo) and in the deployment
provider.

## A few rules to share with the user

- Never commit `.env` / `.env.local`
- Don't log `STREAMPAY_API_KEY` or `STREAMPAY_WEBHOOK_SECRET` — even in error logs
- Rotate from the dashboard when teammates leave
- Use a different API key for sandbox and production (and pair sandbox with `STREAMPAY_BASE_URL` if your environment requires it)

## Loading env before `@better-auth/cli generate`

The CLI imports the auth file, which usually validates env at
module-load time (via `@t3-oss/env-core`, `envsafe`, or similar). If
the env isn't in the process when the CLI runs, the import throws
before the CLI can even read the config.

Source the env file into the shell first:

```
set -a; source apps/server/.env; set +a
npx @better-auth/cli generate --config apps/server/src/auth.ts
```

Same trick works for `migrate`. Skip this only when the auth file
has no env validator.

## Quick sanity check

After setting the API key:

```ts
const client = StreamSDK.init(process.env.STREAMPAY_API_KEY!)
await client.listConsumers({ page: 1, page_size: 1 })
```

`401` / `403` = wrong or revoked key. Network error = check
`STREAMPAY_BASE_URL`.

## What this plugin doesn't touch

`DATABASE_URL`, OAuth provider creds, SMTP — all Better Auth's
concern, not this plugin's.
