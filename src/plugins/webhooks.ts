import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import type { StreamPayOptions } from "../types";
import { getLogger } from "../utils/logger";
import { dispatchWebhook, type WebhookHandlers } from "../webhooks/dispatcher";
import { isKnownStreamPayWebhookPayload, isStreamPayWebhookEnvelope } from "../webhooks/events";
import { StreamPayWebhookError, verifyWebhookOrThrow } from "../webhooks/verify";
import type { StreamPayPluginRegistry } from "./subscriptions";
import { webhookEventTable } from "./subscriptions/schema";
import {
	claimOrAdvanceWebhookEvent,
	claimWebhookEventForReplay,
	DEFAULT_MAX_WEBHOOK_ATTEMPTS,
	findDueWebhookEvents,
	markWebhookEventCompleted,
	recordWebhookEventFailure,
	type SyncContext,
	WEBHOOK_EVENT_MODEL,
	WebhookEventInProgressError,
	type WebhookEventRow,
} from "./subscriptions/sync";

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

	return (_options: StreamPayOptions, registry?: StreamPayPluginRegistry) => {
		const { secret, toleranceSeconds, deduplicate = false, ...handlers } = webhooksOptions;
		if (deduplicate && registry) {
			registry.replayWebhookHandler = async (ctx, eventId, replayOptions) => {
				const syncContext = { context: ctx.context as SyncContext["context"] };
				const row = await syncContext.context.adapter.findOne<WebhookEventRow>({
					model: WEBHOOK_EVENT_MODEL,
					where: [{ field: "eventId", value: eventId }],
				});
				if (!eventId.startsWith("handlers:") || !row)
					throw new APIError("NOT_FOUND", { message: "Webhook callback event not found." });
				if (!row.rawPayload)
					throw new APIError("BAD_REQUEST", { message: "Webhook callback has no stored payload." });
				let payload: unknown;
				try {
					payload = JSON.parse(row.rawPayload);
				} catch {
					throw new APIError("BAD_REQUEST", {
						message: "Stored webhook payload is not valid JSON.",
					});
				}
				if (!isStreamPayWebhookEnvelope(payload))
					throw new APIError("BAD_REQUEST", {
						message: "Stored webhook payload is not a valid event envelope.",
					});
				const claimed = await claimWebhookEventForReplay(syncContext, row);
				if (!claimed?.lockedBy)
					throw new APIError("CONFLICT", {
						message: "Webhook callback is already being processed.",
					});
				try {
					await dispatchWebhook(payload, handlers);
					await markWebhookEventCompleted(syncContext, claimed.id, claimed.lockedBy);
				} catch (err) {
					await recordWebhookEventFailure(
						syncContext,
						claimed.id,
						row.rawPayload,
						row.signatureHeader,
						err,
						claimed.lockedBy,
						!replayOptions?.retryUntilExhausted ||
							claimed.attemptCount >= DEFAULT_MAX_WEBHOOK_ATTEMPTS,
					);
					throw err;
				}
				return { replayed: true, eventId };
			};
			registry.replayWebhookEvent ??= registry.replayWebhookHandler;
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
								const message = err instanceof Error ? err.message : String(err);
								logger.error(`subscription sync failed: ${message}`);
								throw new APIError("INTERNAL_SERVER_ERROR", {
									message: "Webhook sync failed. See server logs.",
								});
							}
						}

						const syncContext = { context: ctx.context as SyncContext["context"] };
						const claim = deduplicate
							? await claimOrAdvanceWebhookEvent(
									syncContext,
									payload,
									rawBody,
									signatureHeader,
									DEFAULT_MAX_WEBHOOK_ATTEMPTS,
									"handlers",
								)
							: null;
						if (claim?.action === "skip" && claim.reason === "in_progress") throw inProgressError();
						if (claim && claim.action !== "process") return ctx.json({ received: true });
						const row = claim?.action === "process" ? claim.row : null;
						try {
							await dispatchWebhook(payload, handlers);
							if (row)
								await markWebhookEventCompleted(syncContext, row.id, row.lockedBy ?? undefined);
						} catch (err: unknown) {
							if (row)
								await recordWebhookEventFailure(
									syncContext,
									row.id,
									rawBody,
									signatureHeader,
									err,
									row.lockedBy ?? undefined,
									row.attemptCount >= DEFAULT_MAX_WEBHOOK_ATTEMPTS,
								);
							const message = err instanceof Error ? err.message : String(err);
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
						const replay = registry?.replayWebhookEvent;
						if (!replay) {
							throw new APIError("BAD_REQUEST", {
								message:
									"Retry processing requires the webhook inbox: enable subscriptions or webhooks({ deduplicate: true }).",
							});
						}
						const syncContext = { context: ctx.context as SyncContext["context"] };
						const due = await findDueWebhookEvents(
							syncContext,
							new Date(),
							ctx.body?.limit ?? DEFAULT_DUE_WEBHOOK_BATCH,
						);
						const succeeded: string[] = [];
						const failed: Array<{ eventId: string; error: string }> = [];
						for (const row of due) {
							try {
								await replay(ctx, row.eventId, { retryUntilExhausted: true });
								succeeded.push(row.eventId);
							} catch (err: unknown) {
								if (err instanceof APIError && err.status === "CONFLICT") continue;
								failed.push({
									eventId: row.eventId,
									error: err instanceof Error ? err.message : String(err),
								});
							}
						}
						if (failed.length > 0) {
							getLogger(ctx).error(
								`webhook retry: ${failed.length} of ${due.length} due events failed again`,
							);
						}
						return ctx.json({ succeeded, failed });
					},
				),
			},
		};
	};
};
