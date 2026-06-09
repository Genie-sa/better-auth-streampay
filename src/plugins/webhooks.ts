import { APIError, createAuthEndpoint } from "better-auth/api";
import type { StreamPayOptions } from "../types";
import { getLogger } from "../utils/logger";
import { dispatchWebhook, type WebhookHandlers } from "../webhooks/dispatcher";
import type { StreamPayWebhookPayload } from "../webhooks/events";
import { StreamPayWebhookError, verifyWebhookOrThrow } from "../webhooks/verify";
import type { StreamPayPluginRegistry } from "./subscriptions";

/** Options for `webhooks()`: the signing `secret` (single or rotated), freshness `toleranceSeconds`, and per-event handlers. */
export interface WebhooksOptions extends WebhookHandlers {
	secret: string | readonly string[];
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

/** Signed-webhook sub-plugin. Verifies StreamPay signatures and dispatches `POST /streampay/webhooks` to your handlers. */
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
						const logger = getLogger(ctx);
						const hasSecret =
							typeof secret === "string" ? secret.length > 0 : secret.some((s) => s.length > 0);
						if (!hasSecret) {
							logger.error("webhook secret is not configured.");
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
								logger.warn(`webhook rejected: ${err.reason}`);
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

						if (registry?.subscriptionWebhookSync) {
							try {
								await registry.subscriptionWebhookSync(ctx, payload, {
									rawBody,
									signatureHeader,
								});
							} catch (err: unknown) {
								const message = err instanceof Error ? err.message : String(err);
								logger.error(`subscription sync failed: ${message}`);
								throw new APIError("INTERNAL_SERVER_ERROR", {
									message: "Webhook sync failed. See server logs.",
								});
							}
						}

						try {
							await dispatchWebhook(payload, handlers);
						} catch (err: unknown) {
							const message = err instanceof Error ? err.message : String(err);
							logger.error(`webhook handler failed: ${message}`);
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
