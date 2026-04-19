import type { FreezeSubscriptionCreateRequest, SubscriptionCancel } from "@streamsdk/typescript";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { APIError } from "better-auth/api";
import { z } from "zod";
import type { StreamPayOptions } from "../types";
import type { EnsureConsumerContext } from "../utils/ensure-consumer";
import { rejectUnauthorized, toAPIError } from "../utils/errors";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";

/**
 * Reserved for future sub-plugin options. Today the sub-plugin reads
 * from top-level `StreamPayOptions` only (notably
 * `consumerLookupMaxPages`).
 */
export type SubscriptionsOptions = Record<string, never>;

/**
 * Request body for POST /consumer/subscriptions/cancel. Field names
 * mirror StreamPay's `SubscriptionCancel` schema.
 */
const CancelBody = z.object({
	subscriptionId: z.string().uuid(),
	cancelRelatedInvoices: z.boolean().optional(),
});

/**
 * Request body for POST /consumer/subscriptions/freeze. Mirrors
 * StreamPay's `FreezeSubscriptionCreateRequest`.
 */
const FreezeBody = z.object({
	subscriptionId: z.string().uuid(),
	freezeStartDatetime: z.string().datetime(),
	freezeEndDatetime: z.string().datetime().nullable().optional(),
	notes: z.string().optional(),
});

/**
 * Assert the caller owns the subscription before allowing a mutation.
 *
 * Short-circuits with FORBIDDEN when the user has no
 * `streampayConsumerId` — without this guard, an authenticated user
 * who POSTs a random subscription UUID would cause
 * `ensureConsumerForUser` to lazy-create a StreamPay consumer they
 * never needed. The ownership check would then correctly reject, but
 * the plugin just minted an orphan row. Users who need a lazy-create
 * path already get one via `/checkout`; this endpoint only serves
 * users who own existing subscriptions, which implies a linked id.
 */
async function assertOwnsSubscription(
	options: StreamPayOptions,
	_ctx: EnsureConsumerContext,
	user: StreamPaySessionUser | null,
	subscriptionId: string,
): Promise<void> {
	rejectUnauthorized(user, "Anonymous users cannot manage subscriptions.");

	if (!user.streampayConsumerId) {
		throw new APIError("FORBIDDEN", {
			message: "Subscription does not belong to this user.",
		});
	}

	const subscription = await options.client.getSubscription(subscriptionId);
	if (subscription.organization_consumer_id !== user.streampayConsumerId) {
		throw new APIError("FORBIDDEN", {
			message: "Subscription does not belong to this user.",
		});
	}
}

export const subscriptions =
	(_subscriptionsOptions: SubscriptionsOptions = {}) =>
	(options: StreamPayOptions) => {
		const client = options.client;
		return {
			cancelSubscription: createAuthEndpoint(
				"/consumer/subscriptions/cancel",
				{
					method: "POST",
					body: CancelBody,
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const sessionUser = asSessionUser(ctx.context.session?.user);
					await assertOwnsSubscription(options, ctx, sessionUser, ctx.body.subscriptionId);

					const payload: SubscriptionCancel = {
						cancel_related_invoices: ctx.body.cancelRelatedInvoices ?? false,
					};

					try {
						const result = await client.cancelSubscription(ctx.body.subscriptionId, payload);
						return ctx.json(result);
					} catch (err) {
						toAPIError(
							{
								logPrefix: "StreamPay cancelSubscription failed:",
								userMessage: "Subscription cancellation failed.",
							},
							err,
							ctx.context.logger,
						);
					}
				},
			),

			freezeSubscription: createAuthEndpoint(
				"/consumer/subscriptions/freeze",
				{
					method: "POST",
					body: FreezeBody,
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const sessionUser = asSessionUser(ctx.context.session?.user);
					await assertOwnsSubscription(options, ctx, sessionUser, ctx.body.subscriptionId);

					// exactOptionalPropertyTypes: set fields only when provided.
					const payload: FreezeSubscriptionCreateRequest = {
						freeze_start_datetime: ctx.body.freezeStartDatetime,
					};
					if (ctx.body.freezeEndDatetime !== undefined) {
						payload.freeze_end_datetime = ctx.body.freezeEndDatetime;
					}
					if (ctx.body.notes !== undefined) {
						payload.notes = ctx.body.notes;
					}

					try {
						const result = await client.freezeSubscription(ctx.body.subscriptionId, payload);
						return ctx.json(result);
					} catch (err) {
						toAPIError(
							{
								logPrefix: "StreamPay freezeSubscription failed:",
								userMessage: "Subscription freeze failed.",
							},
							err,
							ctx.context.logger,
						);
					}
				},
			),
		};
	};
