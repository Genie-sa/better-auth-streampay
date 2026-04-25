# What to figure out (and how)

Don't run this like a form. The user already told you something when
they made the request, and the repo answers a lot of the rest. Your
job is to know what's still unknown, and ask just that — in their
words, not these words.

## How to use this file

For each "thing to know", you'll see:

- **Signals** — what tells you the answer without asking
- **Ask only if** — when the question is actually needed
- **Suggested phrasing** — a template to adapt, not paste verbatim

Skip anything you already know. If the user's request itself answers
it ("add subscriptions to my app"), don't ask "do you want
subscriptions?" — you already know.

## Things to know before installing

### Which features the app needs

Maps to the `use: [...]` array — `checkout` / `portal` /
`subscriptions` / `admin` / `webhooks`.

**Signals**:
- The request itself ("add billing", "set up subscriptions", "I need a refund admin", "I just want to take payments") usually picks 1–3 sub-plugins on its own.
- Existing code can hint: a "Buy" button suggests checkout; a `/billing` route suggests portal; a "Free / Pro / Team" page suggests subscriptions; a `/admin` route suggests admin.
- If the user mentioned subscriptions and didn't mention webhooks, default to also enabling webhooks — they're effectively required for sub state to stay in sync.

**Ask only if**: the request is generic ("add StreamPay", "set up payments") and the repo gives no hints.

**Suggested phrasing**: "Based on what you said, I'd start with `<best guess>` — does that match what you have in mind, or do you want more / less?"

If the user is unsure, briefly explain each piece in one sentence (or load [plugins-overview.md](plugins-overview.md)).

---

### Whether to create customers eagerly or lazily

Maps to `createConsumerOnSignUp`.

**Signals**:
- If the app needs portal/billing data right after sign-up (e.g. shows pricing on first dashboard load), eager makes sense.
- For most apps, lazy is fine and less risky.
- The user might just say "I want them created immediately" or "only when they pay" — listen for that.

**Ask only if**: ambiguous from the request.

**Suggested phrasing**: "Should I create the StreamPay customer the moment someone signs up, or wait until they actually try to pay?"

---

### What to do about duplicate customers (if eager)

Maps to `claimExistingConsumerBy`.

**Signals**:
- If the app verifies email/phone before sign-up, "reuse on email" or "reuse on phone" is safer than usual.
- If sign-up is open with no verification, suggest the safe default (don't reuse).

**Ask only if**: eager creation is on AND the user hasn't already expressed a preference.

**Suggested phrasing**: "If someone signs up with an email/phone that already exists in StreamPay (linked to a different user), should I reuse that customer or keep them separate? Reusing transfers the old billing history — only safe if you verify email or phone at sign-up."

---

### Custom fields when creating customers

Maps to `getConsumerCreateParams`.

**Signals**:
- Look at the user table / sign-up form. If it collects phone, language preference, IBAN, etc., those are candidates.
- If nothing extra is collected at sign-up, skip the question entirely — don't add an empty `getConsumerCreateParams`.

**Ask only if**: there are clearly extra fields available AND the user hasn't said.

**Suggested phrasing**: "I see your sign-up collects `<fields you noticed>`. Do you want to send any of those to StreamPay? Otherwise we'll just send name and email."

---

### The pricing plan catalog (subscriptions only)

Maps to `subscriptions({ plans })`.

**Signals**:
- The user might already have a pricing page or a list of tiers they mentioned.
- If a config / database already has plan definitions, point them at the async-factory option.
- Product UUIDs only exist after the user creates products in the StreamPay dashboard — don't invent them.

**Ask only if**: subscriptions are enabled AND no plan info is available yet.

**Suggested phrasing**: "Tell me about your plans — what tiers, what they cost, monthly or yearly. If you don't have product IDs from the StreamPay dashboard yet, that's fine; I'll leave placeholders and you can fill them in."

---

### Checkout product mapping (checkout only)

Maps to `checkout({ products })`.

**Signals**:
- A small fixed catalog → static array.
- Products in a database / CMS → async resolver function.

**Ask only if**: checkout is on AND the request didn't make this obvious.

**Suggested phrasing**: "How many products are we talking about — a small fixed list, or do you load them from a database?"

---

### Whether checkout is open to guests

Maps to `checkout({ authenticatedUsersOnly })` and `contactInformationType`.

**Signals**:
- B2C marketplace → guests usually allowed.
- B2B SaaS → usually authenticated only.
- Anonymous plugin in the auth file → guest-friendly already.

**Ask only if**: not obvious from context.

**Suggested phrasing**: "Should checkout be locked to signed-in users, or can guests buy too? If guests, do you want to collect email or phone at checkout?"

---

### How admins are identified (admin only)

Maps to `admin({ adminRoles })` or `admin({ isAdmin })`.

**Signals**:
- Better Auth's `admin()` plugin in the auth file → role-based, default `["admin"]` works.
- A `role` column on `user` with custom values → `adminRoles` array.
- Admin determined some other way (specific email domain, organization membership, env allow-list) → `isAdmin` callback.

**Ask only if**: admin is on AND the existing auth file doesn't reveal the pattern.

**Suggested phrasing**: "How does the app know someone's an admin today? A role field on the user, an email allow-list, something else?"

---

### Which webhook events to scaffold

Maps to the per-event handlers on `webhooks({})`.

**Signals**:
- The features picked usually imply the events. Checkout → `onPaymentSucceeded` / `onPaymentRefunded`. Subscriptions → `onSubscriptionActivated` / `onSubscriptionCanceled` / `onSubscriptionCycleRenewalFailed`.
- If the user mentioned a specific outcome ("send a receipt when they pay", "revoke access on cancel"), scaffold that handler with the matching TODO.

**Ask only if**: webhooks are on AND the user hasn't expressed any specific behavior.

**Suggested phrasing**: "I'll scaffold `<events you'd guess>` based on what we're enabling. Want me to add anything else, or skip any?"

---

### Single secret vs rolling rotation

Maps to `webhooks({ secret })` (string vs array).

**Signals**:
- Almost everyone starts with a single secret. Rolling rotation is for teams that already rotate webhook secrets on a schedule.

**Ask only if**: the user mentioned secret rotation OR the project shows a pattern of secret-rotation infrastructure.

**Suggested phrasing**: usually skip and just go single. Don't ask unless prompted.

---

## Things to confirm before editing

After you've gathered enough to act, recap in plain English and wait
for "yes" before touching files. Adapt the wording — don't read it
like a script.

**Template** (adjust to what's actually planned):

> Here's what I'll do:
> - Install `<package>` in `<workspace>`
> - Add `streampay(...)` to `<auth file>` with these features: `<list>`
> - Add env vars `<list>` to `<env file path>` (placeholders only — you'll fill them from the dashboard)
> - `<schema regeneration step if BYO Drizzle/Prisma>`
> - Run a `<orm tool>` migration so the new tables exist
>
> Sound good? Anything you want to change?

If they push back on something, just rerun the affected decisions —
don't restart from scratch.

## Anti-patterns

- Asking a question whose answer is in the request the user just sent
- Asking a question whose answer is in the codebase you can read
- Batching unrelated questions into one wall of text
- Asking "what framework?" when the `package.json` is right there
- Reading these prompts verbatim — they're templates, write them in the user's words and tone
