import { APIError, createAuthEndpoint } from "better-auth/api";
import type { StreamPayClient } from "../types";
import { dispatchWebhook, type WebhookHandlers } from "../webhooks/dispatcher";
import type { StreamPayWebhookPayload } from "../webhooks/events";
import { StreamPayWebhookError, verifyWebhookOrThrow } from "../webhooks/verify";

export interface WebhooksOptions extends WebhookHandlers {
	/** Shared secret configured in the StreamPay dashboard. */
	secret: string;
	/** Maximum age (seconds) a signed payload is considered fresh. */
	toleranceSeconds?: number;
}

/**
 * TypeScript type predicate that narrows an unknown JSON-parsed value
 * to `StreamPayWebhookPayload`. The assertion is concentrated in the
 * return type annotation (`value is StreamPayWebhookPayload`) so the
 * function body reads as a straightforward `in` operator walk with no
 * inline type assertions.
 */
function isStreamPayWebhookPayload(value: unknown): value is StreamPayWebhookPayload {
	if (!value || typeof value !== "object") return false;
	return "event_type" in value && typeof value.event_type === "string";
}

/**
 * Narrow a raw JSON-parsed value to a `StreamPayWebhookPayload`.
 * Returns `null` when the shape is invalid so the caller can raise a
 * readable `BAD_REQUEST`. Only `event_type` is validated structurally
 * — downstream per-event handlers are free to narrow further on the
 * fields they actually use.
 */
function parseWebhookPayload(value: unknown): StreamPayWebhookPayload | null {
	return isStreamPayWebhookPayload(value) ? value : null;
}

function toErrorCode(reason: StreamPayWebhookError["reason"]): "UNAUTHORIZED" | "BAD_REQUEST" {
	return reason === "MISSING_HEADER" || reason === "INVALID_SIGNATURE" || reason === "EXPIRED"
		? "UNAUTHORIZED"
		: "BAD_REQUEST";
}

export const webhooks = (options: WebhooksOptions) => (_client: StreamPayClient) => {
	const { secret, toleranceSeconds, ...handlers } = options;

	return {
		streampayWebhooks: createAuthEndpoint(
			"/streampay/webhooks",
			{
				method: "POST",
				metadata: { isAction: false },
				cloneRequest: true,
			},
			async (ctx) => {
				if (!secret) {
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

				const payload = parseWebhookPayload(parsed);
				if (!payload) {
					throw new APIError("BAD_REQUEST", {
						message: "Webhook body is missing `event_type`.",
					});
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
	};
};
