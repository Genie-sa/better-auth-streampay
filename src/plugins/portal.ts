import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import type { StreamPayClient, StreamPayOptions } from "../types";
import { findConsumerByExternalId } from "../utils/consumer";
import { rejectUnauthorized, toAPIError } from "../utils/errors";
import { getLogger } from "../utils/logger";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";

export interface PortalOptions {
	pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;

async function getConsumerIdOrNull(
	client: StreamPayClient,
	user: StreamPaySessionUser | null,
): Promise<string | null> {
	rejectUnauthorized(user, "Anonymous users cannot access the billing portal.");
	if (user.streampayConsumerId) return user.streampayConsumerId;
	return findConsumerByExternalId(client, { externalId: user.id });
}

export const portal =
	({ pageSize }: PortalOptions = {}) =>
	(options: StreamPayOptions) => {
		const client = options.client;
		const size = clampPageSize(pageSize);
		return {
			endpoints: {
				state: createAuthEndpoint(
					"/consumer/state",
					{ method: "GET", use: [sessionMiddleware] },
					async (ctx) => {
						const user = asSessionUser(ctx.context.session?.user);
						const consumerId = await getConsumerIdOrNull(client, user);
						if (!consumerId) return ctx.json({ hasConsumer: false, consumer: null });
						try {
							const consumer = await client.getConsumer(consumerId);
							return ctx.json({ hasConsumer: true, consumer });
						} catch (err) {
							toAPIError("StreamPay getConsumer failed.", err, getLogger(ctx));
						}
					},
				),

				subscriptions: createAuthEndpoint(
					"/consumer/subscriptions/list",
					{ method: "GET", use: [sessionMiddleware] },
					async (ctx) => {
						const user = asSessionUser(ctx.context.session?.user);
						const consumerId = await getConsumerIdOrNull(client, user);
						if (!consumerId) return ctx.json({ hasConsumer: false, data: [] });
						try {
							const response = await client.listSubscriptions({
								organization_consumer_id: consumerId,
								page: 1,
								size,
							});
							return ctx.json({ hasConsumer: true, data: response.data ?? [] });
						} catch (err) {
							toAPIError("StreamPay listSubscriptions failed.", err, getLogger(ctx));
						}
					},
				),

				invoices: createAuthEndpoint(
					"/consumer/invoices/list",
					{ method: "GET", use: [sessionMiddleware] },
					async (ctx) => {
						const user = asSessionUser(ctx.context.session?.user);
						const consumerId = await getConsumerIdOrNull(client, user);
						if (!consumerId) return ctx.json({ hasConsumer: false, data: [] });
						try {
							const response = await client.listInvoices({
								organization_consumer_id: consumerId,
								page: 1,
								size,
							});
							return ctx.json({ hasConsumer: true, data: response.data ?? [] });
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
