import type { FreezeSubscriptionCreateRequest, SubscriptionCancel } from "@streamsdk/typescript";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import type { StreamPayOptions } from "../types";
import { type EnsureConsumerContext, ensureConsumerForUser } from "../utils/ensure-consumer";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";

export interface SubscriptionsOptions {
	consumerLookupMaxPages?: number;
}

/**
 * Request body for POST /consumer/subscriptions/cancel.
 *
 * Field names mirror StreamPay's `SubscriptionCancel` schema so callers
 * can pass `cancelRelatedInvoices` with the exact same semantics as the
 * upstream `cancel_related_invoices` flag.
 */
const CancelBody = z.object({
	subscriptionId: z.string().uuid(),
	cancelRelatedInvoices: z.boolean().optional(),
});

/**
 * Request body for POST /consumer/subscriptions/freeze.
 *
 * Mirrors StreamPay's `FreezeSubscriptionCreateRequest`: a required start
 * datetime, an optional end datetime (`null` = open-ended freeze), and an
 * optional `notes` field.
 */
const FreezeBody = z.object({
	subscriptionId: z.string().uuid(),
	freezeStartDatetime: z.string().datetime(),
	freezeEndDatetime: z.string().datetime().nullable().optional(),
	notes: z.string().optional(),
});

async function assertOwnsSubscription(
	options: StreamPayOptions,
	ctx: EnsureConsumerContext,
	user: StreamPaySessionUser | null,
	subscriptionId: string,
): Promise<void> {
	if (!user) {
		throw new APIError("UNAUTHORIZED", { message: "Session user is missing." });
	}
	// `ensureConsumerForUser` short-circuits on the already-linked case
	// (no StreamPay calls), and lazily creates on the unlinked case so
	// legacy users created before the schema extension still work. A
	// freshly-created consumer will never own `subscriptionId`, so the
	// ownership check below fires correctly.
	const { consumerId } = await ensureConsumerForUser(options, ctx, user);
	const subscription = await options.client.getSubscription(subscriptionId);
	if (subscription.organization_consumer_id !== consumerId) {
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
					} catch (err: unknown) {
						if (err instanceof APIError) throw err;
						const message = err instanceof Error ? err.message : String(err);
						ctx.context.logger.error(`StreamPay cancelSubscription failed: ${message}`);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Subscription cancellation failed.",
						});
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

					// Build the payload respecting `exactOptionalPropertyTypes`:
					// fields are only set when the caller provided them, so the
					// SDK never sees explicit `undefined` for an optional field.
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
					} catch (err: unknown) {
						if (err instanceof APIError) throw err;
						const message = err instanceof Error ? err.message : String(err);
						ctx.context.logger.error(`StreamPay freezeSubscription failed: ${message}`);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Subscription freeze failed.",
						});
					}
				},
			),
		};
	};
