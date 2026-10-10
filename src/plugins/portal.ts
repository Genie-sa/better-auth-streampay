import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import type { StreamPayClient, StreamPayOptions } from "../types";
import { findConsumerByExternalId } from "../utils/consumer";
import { rejectUnauthorized, toAPIError } from "../utils/errors";
import { getLogger } from "../utils/logger";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";

export interface PortalOptions {
	pageSize?: number;
	/** Server-side bridge for Stream's hosted portal API, which SDK 1.1.3 does not expose. */
	createSession?: (input: { organization_consumer_id: string }) => Promise<{ url: string }>;
}

const DEFAULT_PAGE_SIZE = 100;
const paginationQuery = z.object({
	page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
	size: z.coerce.number().int().min(1).max(100).optional(),
});

async function getConsumerIdOrNull(
	client: StreamPayClient,
	user: StreamPaySessionUser | null,
): Promise<string | null> {
	rejectUnauthorized(user, "Anonymous users cannot access the billing portal.");
	if (user.streampayConsumerId) return user.streampayConsumerId;
	return findConsumerByExternalId(client, { externalId: user.id });
}

export const portal =
	({ pageSize, createSession }: PortalOptions = {}) =>
	(options: StreamPayOptions) => {
		const client = options.client;
		const size = clampPageSize(pageSize);
		return {
			endpoints: {
				portalSession: createAuthEndpoint(
					"/consumer/portal/session",
					{ method: "POST", use: [sessionMiddleware] },
					async (ctx) => {
						ctx.setHeader("cache-control", "no-store");
						try {
							const consumerId = await getConsumerIdOrNull(
								client,
								asSessionUser(ctx.context.session?.user),
							);
							if (!consumerId)
								throw new APIError("NOT_FOUND", {
									message: "No StreamPay consumer is linked to this account.",
								});
							if (!createSession)
								throw new APIError("NOT_FOUND", {
									message: "Hosted customer portal is not configured.",
								});
							const session = await createSession({ organization_consumer_id: consumerId });
							const url = new URL(session.url);
							if (url.protocol !== "https:" || url.username || url.password)
								throw new Error("Invalid hosted portal URL.");
							return ctx.json({ url: url.href });
						} catch (err) {
							toAPIError("StreamPay createPortalSession failed.", err, getLogger(ctx));
						}
					},
				),
				state: createAuthEndpoint(
					"/consumer/state",
					{ method: "GET", use: [sessionMiddleware] },
					async (ctx) => {
						const user = asSessionUser(ctx.context.session?.user);
						try {
							const consumerId = await getConsumerIdOrNull(client, user);
							if (!consumerId) return ctx.json({ hasConsumer: false, consumer: null });
							const consumer = await client.getConsumer(consumerId);
							return ctx.json({ hasConsumer: true, consumer });
						} catch (err) {
							toAPIError("StreamPay getConsumer failed.", err, getLogger(ctx));
						}
					},
				),

				subscriptions: createAuthEndpoint(
					"/consumer/subscriptions/list",
					{ method: "GET", use: [sessionMiddleware], query: paginationQuery },
					async (ctx) => {
						const user = asSessionUser(ctx.context.session?.user);
						try {
							const consumerId = await getConsumerIdOrNull(client, user);
							if (!consumerId) return ctx.json({ hasConsumer: false, data: [] });
							const response = await client.listSubscriptions({
								organization_consumer_id: consumerId,
								page: ctx.query?.page ?? 1,
								size: ctx.query?.size ?? size,
							});
							return ctx.json({
								hasConsumer: true,
								data: response.data ?? [],
								pagination: response.pagination,
							});
						} catch (err) {
							toAPIError("StreamPay listSubscriptions failed.", err, getLogger(ctx));
						}
					},
				),

				invoices: createAuthEndpoint(
					"/consumer/invoices/list",
					{ method: "GET", use: [sessionMiddleware], query: paginationQuery },
					async (ctx) => {
						const user = asSessionUser(ctx.context.session?.user);
						try {
							const consumerId = await getConsumerIdOrNull(client, user);
							if (!consumerId) return ctx.json({ hasConsumer: false, data: [] });
							const response = await client.listInvoices({
								organization_consumer_id: consumerId,
								page: ctx.query?.page ?? 1,
								size: ctx.query?.size ?? size,
							});
							return ctx.json({
								hasConsumer: true,
								data: response.data ?? [],
								pagination: response.pagination,
							});
						} catch (err) {
							toAPIError("StreamPay listInvoices failed.", err, getLogger(ctx));
						}
					},
				),
			},
		};
	};

function clampPageSize(size: number | undefined): number {
	if (!size || !Number.isFinite(size) || size < 1) return DEFAULT_PAGE_SIZE;
	return Math.min(Math.floor(size), 100);
}
