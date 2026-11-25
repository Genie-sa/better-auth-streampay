import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import type { StreamPayOptions } from "../types";
import { summarizeStreamPayError } from "../utils/format-error";
import { getLogger } from "../utils/logger";
import { dispatchWebhook, type WebhookHandlers } from "../webhooks/dispatcher";
import { isKnownStreamPayWebhookPayload, isStreamPayWebhookEnvelope } from "../webhooks/events";
import {
	DEFAULT_MAX_WEBHOOK_ATTEMPTS,
	deliverWebhookEvent,
	HANDLERS_EVENT_ID_PREFIX,
	WebhookEventInProgressError,
	type WebhookInboxScope,
} from "../webhooks/inbox";
import { StreamPayWebhookError, verifyWebhookOrThrow } from "../webhooks/verify";
import { registerWebhookInboxScope, type StreamPayPluginRegistry } from "./subscriptions";
import { toSyncContext } from "./subscriptions/adapter";
import { webhookEventTable } from "./subscriptions/schema";

const DEFAULT_DUE_WEBHOOK_BATCH = 25;

const ProcessDueWebhookEventsBody = z
	.object({ limit: z.number().int().min(1).max(100).optional() })
	.optional();

function inProgressError(): APIError {
	return new APIError("SERVICE_UNAVAILABLE", {
		message: "Webhook event is already being processed. Retry later.",
	});
}

export interface WebhooksOptions extends WebhookHandlers {
	secret: string | readonly string[];
	toleranceSeconds?: number;
	/** Persist and deduplicate callback deliveries. Requires the webhook inbox migration. */
	deduplicate?: boolean;
	/** Deliveries of a deduplicated callback event before it is dead-lettered. Defaults to 5. */
	maxWebhookAttempts?: number;
}

function toErrorCode(reason: StreamPayWebhookError["reason"]): "UNAUTHORIZED" | "BAD_REQUEST" {
	return reason === "MISSING_HEADER" || reason === "INVALID_SIGNATURE" || reason === "EXPIRED"
		? "UNAUTHORIZED"
		: "BAD_REQUEST";
}

export const webhooks = (webhooksOptions: WebhooksOptions) => {
	const configuredSecrets =
		typeof webhooksOptions.secret === "string" ? [webhooksOptions.secret] : webhooksOptions.secret;
	if (configuredSecrets.length === 0 || configuredSecrets.some((secret) => secret.length === 0)) {
		throw new TypeError("webhooks(): `secret` must contain only non-empty values.");
	}
	if (
		webhooksOptions.toleranceSeconds !== undefined &&
		(!Number.isFinite(webhooksOptions.toleranceSeconds) || webhooksOptions.toleranceSeconds < 0)
	) {
		throw new TypeError("webhooks(): `toleranceSeconds` must be a non-negative number.");
	}
	if (
		webhooksOptions.maxWebhookAttempts !== undefined &&
		(!Number.isInteger(webhooksOptions.maxWebhookAttempts) ||
			webhooksOptions.maxWebhookAttempts < 1)
	) {
		throw new TypeError("webhooks(): `maxWebhookAttempts` must be a positive integer.");
	}

	return (_options: StreamPayOptions, registry?: StreamPayPluginRegistry) => {
		const {
			secret,
			toleranceSeconds,
			deduplicate = false,
			maxWebhookAttempts = DEFAULT_MAX_WEBHOOK_ATTEMPTS,
			...handlers
		} = webhooksOptions;
		const handlersScope: WebhookInboxScope = {
			eventIdPrefix: HANDLERS_EVENT_ID_PREFIX,
			maxAttempts: maxWebhookAttempts,
			isPermanentFailure: () => false,
			prepare: (payload) => async () => dispatchWebhook(payload, handlers),
		};
		if (deduplicate && registry) {
			registerWebhookInboxScope(registry, handlersScope, { replayable: true });
		}

		return {
			schema: deduplicate ? webhookEventTable : {},
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

						if (!isStreamPayWebhookEnvelope(parsed)) {
							throw new APIError("BAD_REQUEST", {
								message: "Webhook body is not a valid StreamPay event envelope.",
							});
						}
						const payload = parsed;

						if (registry?.subscriptionWebhookSync && isKnownStreamPayWebhookPayload(payload)) {
							try {
								await registry.subscriptionWebhookSync(ctx, payload, {
									rawBody,
									signatureHeader,
								});
							} catch (err: unknown) {
								if (err instanceof WebhookEventInProgressError) throw inProgressError();
								const message = summarizeStreamPayError(err);
								logger.error(`subscription sync failed: ${message}`);
								throw new APIError("INTERNAL_SERVER_ERROR", {
									message: "Webhook sync failed. See server logs.",
								});
							}
						}

						try {
							if (deduplicate) {
								await deliverWebhookEvent(toSyncContext(ctx), handlersScope, payload, {
									rawBody,
									signatureHeader,
								});
							} else {
								await dispatchWebhook(payload, handlers);
							}
						} catch (err: unknown) {
							if (err instanceof WebhookEventInProgressError) throw inProgressError();
							const message = summarizeStreamPayError(err);
							logger.error(`webhook handler failed: ${message}`);
							throw new APIError("INTERNAL_SERVER_ERROR", {
								message: "Webhook handler failed. See server logs.",
							});
						}

						return ctx.json({ received: true });
					},
				),
				processDueStreampayWebhookEvents: createAuthEndpoint(
					"/streampay/webhooks/process-due",
					{
						method: "POST",
						body: ProcessDueWebhookEventsBody,
						metadata: { SERVER_ONLY: true },
					},
					async (ctx) => {
						const inbox = registry?.webhookInbox;
						if (!inbox?.isEnabled()) {
							throw new APIError("BAD_REQUEST", {
								message:
									"Retry processing requires the webhook inbox: enable subscriptions or webhooks({ deduplicate: true }).",
							});
						}
						const { succeeded, failed } = await inbox.processDue(
							toSyncContext(ctx),
							ctx.body?.limit ?? DEFAULT_DUE_WEBHOOK_BATCH,
						);
						if (failed.length > 0) {
							getLogger(ctx).error(
								`webhook retry: ${failed.length} of ${succeeded.length + failed.length} due events failed again`,
							);
						}
						return ctx.json({ succeeded, failed });
					},
				),
			},
		};
	};
};
