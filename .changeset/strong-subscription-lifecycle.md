---
"better-auth-streampay": major
---

Update subscriptions for StreamPay SDK 1.1.3.

- Change plans on the same subscription.
- Cancel a pending plan change or period-end cancellation.
- Support trials, freezes, plan groups, and app-owned billing references.
- Store subscription billing and lifecycle state and prevent duplicate active checkouts.
- Check, retry, and replay subscription webhooks.
- Add typed handlers for all documented StreamPay subscription events.

This release needs Better Auth `^1.5.0` and changes the subscription tables. Generate and run the
database changes before starting the app. Node.js `20.19.0` or newer is required.
