import { APIError, createAuthEndpoint } from "better-auth/api";
import type { StreamPayOptions } from "../types";
import { dispatchWebhook, type WebhookHandlers } from "../webhooks/dispatcher";
import type { StreamPayWebhookPayload } from "../webhooks/events";
import { StreamPayWebhookError, verifyWebhookOrThrow } from "../webhooks/verify";
import type { StreamPayPluginRegistry } from "./subscriptions";

export interface WebhooksOptions extends WebhookHandlers {
	/**
	 * Shared secret configured in the StreamPay dashboard. Accepts a
	 * single value or an array of secrets for rolling rotation.
	 */
	secret: string | readonly string[];
	/** Maximum age (seconds) a signed payload is considered fresh. */
	toleranceSeconds?: number;
}

function isStreamPayWebhookPayload(value: unknown): value is StreamPayWebhookPayload {
	if (!value || typeof value !== "object") return false;
	return "event_type" in value && typeof value.event_type === "string";
}

function toErrorCode(reason: StreamPayWebhookError["reason"]): "UNAUTHORIZED" | "BAD_REQUEST" {
	return reason === "MISSING_HEADER" || reason === "INVALID_SIGNATURE" || reason === "EXPIRED"
		? "UNAUTHORIZED"
		: "BAD_REQUEST";
}

export const webhooks =
	(webhooksOptions: WebhooksOptions) =>
	(_options: StreamPayOptions, registry?: StreamPayPluginRegistry) => {
		const { secret, toleranceSeconds, ...handlers } = webhooksOptions;

		return {
			endpoints: {
				streampayWebhooks: createAuthEndpoint(
					"/streampay/webhooks",
					{
						method: "POST",
						metadata: { isAction: false },
						cloneRequest: true,
					},
					async (ctx) => {
						const hasSecret =
							typeof secret === "string" ? secret.length > 0 : secret.some((s) => s.length > 0);
						if (!hasSecret) {
							ctx.context.logger.error("StreamPay webhook secret is not configured.");
							throw new APIError("INTERNAL_SERVER_ERROR", {
								message: "StreamPay webhook secret is not configured.",
							});
						}
						if (!ctx.request) {
							throw new APIError("BAD_REQUEST", { message: "Missing request body." });
						}

						const rawBody = await ctx.request.text();
						const signatureHeader = ctx.request.headers.get("x-webhook-signature");

						try {
							verifyWebhookOrThrow({
								secret,
								rawBody,
								signatureHeader,
								toleranceSeconds: toleranceSeconds ?? 300,
							});
						} catch (err: unknown) {
							if (err instanceof StreamPayWebhookError) {
								ctx.context.logger.warn(`StreamPay webhook rejected: ${err.reason}`);
								throw new APIError(toErrorCode(err.reason), {
									message: `Webhook verification failed: ${err.reason}`,
								});
							}
							throw err;
						}

						let parsed: unknown;
						try {
							parsed = JSON.parse(rawBody);
						} catch {
							throw new APIError("BAD_REQUEST", {
								message: "Webhook body is not valid JSON.",
							});
						}

						if (!isStreamPayWebhookPayload(parsed)) {
							throw new APIError("BAD_REQUEST", {
								message: "Webhook body is missing `event_type`.",
							});
						}
						const payload = parsed;

						// Plugin sync runs BEFORE user handlers so userland sees
						// fresh state. Transient failures → 500 → StreamPay retries;
						// permanent failures are swallowed inside the sync wrapper.
						if (registry?.subscriptionWebhookSync) {
							try {
								await registry.subscriptionWebhookSync(ctx, payload);
							} catch (err: unknown) {
								const message = err instanceof Error ? err.message : String(err);
								ctx.context.logger.error(
									`StreamPay subscription sync failed: ${message}`,
								);
								throw new APIError("INTERNAL_SERVER_ERROR", {
									message: "Webhook sync failed. See server logs.",
								});
							}
						}

						try {
							await dispatchWebhook(payload, handlers);
						} catch (err: unknown) {
							const message = err instanceof Error ? err.message : String(err);
							ctx.context.logger.error(`StreamPay webhook handler failed: ${message}`);
							throw new APIError("INTERNAL_SERVER_ERROR", {
								message: "Webhook handler failed. See server logs.",
							});
						}

						return ctx.json({ received: true });
					},
				),
			},
		};
	};
