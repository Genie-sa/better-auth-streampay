# Claude Code skills

Skills shipped with this plugin, in the
[skills.sh](https://skills.sh) format.

## Available

### `better-auth-streampay-integration`

End-to-end integration workflow. Reads the plugin source and the
user's repo first, runs an adaptive interview only for what neither
shows, then composes `streampay()` from the chosen sub-plugins
(checkout, portal, subscriptions, admin, webhooks). Wires server,
client, env, migrations, and webhook handler scaffolds.

## Install

Via the [skills CLI](https://skills.sh):

```bash
npx skills add Genie-sa/better-auth-streampay
```

Or manually:

```bash
cp -R skills/better-auth-streampay-integration ~/.claude/skills/
```

Then in any project:

> Integrate better-auth-streampay into this app.

The skill auto-loads, detects framework / ORM / Better Auth install
point, asks only what's still unknown, and walks the implementation.

## What's covered

- All sub-plugins: `checkout`, `portal`, `subscriptions`, `admin`, `webhooks`
- Consumer creation policy (eager / lazy) and reclaim rules
- Subscription plan catalog with groups and limits
- Admin gate via Better Auth role field or custom `isAdmin` callback
- Webhook signature verification with rolling-secret rotation
- Templates for Next.js (App + Pages), Hono, Elysia, Express, SvelteKit
- Migrations for Better Auth CLI, Drizzle, Prisma — including the BYO-schema regen step
- Common failure modes (duplicate consumers, signature failures, missing handler exports, plan validation)

The skill is a navigation hub — it reads the plugin source for option
shapes rather than carrying a frozen copy. References stay accurate
across plugin versions.

## External docs

- Plugin: https://github.com/Genie-sa/better-auth-streampay
- StreamPay API: https://docs.streampay.sa
- Better Auth: https://better-auth.com
- skills.sh: https://skills.sh
