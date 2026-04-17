# Claude Code skills

Claude Code skills that automate workflows for this plugin.

## Available

### `better-auth-streampay-integration`

End-to-end integration workflow: auto-detects your framework and ORM, interviews you for the rest via `AskUserQuestion`, then wires `streampay()` into your Better Auth config — server, client, env, migrations, and webhook handlers.

## Install

Copy the skill directory into your Claude Code skills folder:

```bash
# clone this repo, or just copy the skills/ dir
cp -R skills/better-auth-streampay-integration ~/.claude/skills/
```

Then in any project, tell Claude something like:

> "Integrate better-auth-streampay into this app."

Claude will auto-load the skill, run Phase 1 detection against your repo, and walk through the interview.

## What the skill covers

- All sub-plugins: `checkout()`, `portal()`, `subscriptions()`, `webhooks()`
- `createConsumerOnSignUp` + `claimExistingConsumerBy` reclaim policy
- Custom consumer fields via `getConsumerCreateParams`
- Full webhook event catalog with handler patterns
- Framework templates for Next.js (App + Pages), Hono, Elysia, Express
- Migrations for Better Auth CLI, Drizzle, Prisma
- Troubleshooting for `DUPLICATE_CONSUMER`, signature failures, and anonymous-user skips

## External docs

- Plugin repo: <https://github.com/Genie-sa/better-auth-streampay>
- StreamPay API docs: <https://docs.streampay.sa/>
- Better Auth: <https://better-auth.com>
