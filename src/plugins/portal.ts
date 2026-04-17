import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import type { StreamPayClient, StreamPayOptions } from "../types";
import { findConsumerByExternalId } from "../utils/consumer";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";

export interface PortalOptions {
	/**
	 * Maximum pages to scan when falling back to list-based consumer lookup
	 * for sessions that predate the plugin's schema extension. Keep this
	 * small — the common path should be the stored `streampayConsumerId`.
	 */
	consumerLookupMaxPages?: number;
}

const PaginationQuery = z
	.object({
		page: z.coerce.number().int().positive().optional(),
		limit: z.coerce.number().int().positive().max(200).optional(),
	})
	.optional();

/**
 * Portal reads never eagerly create a consumer — a user with no
 * StreamPay footprint has no billing data to show, so we just return
 * an empty `{ hasConsumer: false, ... }` shape. The legacy list-scan
 * is preserved so users who predate the schema extension still
 * resolve correctly.
 */
async function getConsumerIdOrNull(
	client: StreamPayClient,
	user: StreamPaySessionUser | null,
	maxPages: number,
): Promise<string | null> {
	if (!user) {
		throw new APIError("UNAUTHORIZED", { message: "Session user is missing." });
	}
	if (user.streampayConsumerId) return user.streampayConsumerId;
	return findConsumerByExternalId(client, {
		externalId: user.id,
		maxPages,
	});
}

function toAPIError(
	message: string,
	err: unknown,
	logger: { error: (message: string) => void },
): never {
	if (err instanceof APIError) throw err;
	const detail = err instanceof Error ? err.message : String(err);
	logger.error(`${message} ${detail}`);
	throw new APIError("INTERNAL_SERVER_ERROR", { message });
}

function buildPagination(
	query: { page?: number | undefined; limit?: number | undefined } | undefined,
): { page?: number; size?: number } {
	const result: { page?: number; size?: number } = {};
	if (query?.page !== undefined) result.page = query.page;
	if (query?.limit !== undefined) result.size = query.limit;
	return result;
}

export const portal =
	({ consumerLookupMaxPages = 10 }: PortalOptions = {}) =>
	(options: StreamPayOptions) => {
		const client = options.client;
		return {
			state: createAuthEndpoint(
				"/consumer/state",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					const user = asSessionUser(ctx.context.session?.user);
					const consumerId = await getConsumerIdOrNull(client, user, consumerLookupMaxPages);
					if (!consumerId) return ctx.json({ hasConsumer: false, consumer: null });
					try {
						const consumer = await client.getConsumer(consumerId);
						return ctx.json({ hasConsumer: true, consumer });
					} catch (err) {
						toAPIError("StreamPay getConsumer failed.", err, ctx.context.logger);
					}
				},
			),

			subscriptions: createAuthEndpoint(
				"/consumer/subscriptions/list",
				{
					method: "GET",
					query: PaginationQuery,
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const user = asSessionUser(ctx.context.session?.user);
					const consumerId = await getConsumerIdOrNull(client, user, consumerLookupMaxPages);
					if (!consumerId) {
						return ctx.json({ hasConsumer: false, data: [], pagination: null });
					}
					try {
						const result = await client.listSubscriptions(buildPagination(ctx.query));
						const items = result.data ?? [];
						const filtered = items.filter((s) => s.organization_consumer_id === consumerId);
						return ctx.json({
							hasConsumer: true,
							data: filtered,
							pagination: result.pagination,
						});
					} catch (err) {
						toAPIError("StreamPay listSubscriptions failed.", err, ctx.context.logger);
					}
				},
			),

			invoices: createAuthEndpoint(
				"/consumer/invoices/list",
				{
					method: "GET",
					query: PaginationQuery,
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const user = asSessionUser(ctx.context.session?.user);
					const consumerId = await getConsumerIdOrNull(client, user, consumerLookupMaxPages);
					if (!consumerId) {
						return ctx.json({ hasConsumer: false, data: [], pagination: null });
					}
					try {
						const result = await client.listInvoices(buildPagination(ctx.query));
						const items = result.data ?? [];
						const filtered = items.filter(
							(invoice) => invoice.organization_consumer_id === consumerId,
						);
						return ctx.json({
							hasConsumer: true,
							data: filtered,
							pagination: result.pagination,
						});
					} catch (err) {
						toAPIError("StreamPay listInvoices failed.", err, ctx.context.logger);
					}
				},
			),

			payments: createAuthEndpoint(
				"/consumer/payments/list",
				{
					method: "GET",
					query: z
						.object({
							page: z.coerce.number().int().positive().optional(),
							limit: z.coerce.number().int().positive().max(200).optional(),
							invoiceId: z.string().uuid().optional(),
						})
						.optional(),
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const user = asSessionUser(ctx.context.session?.user);
					const consumerId = await getConsumerIdOrNull(client, user, consumerLookupMaxPages);
					if (!consumerId) {
						return ctx.json({ hasConsumer: false, data: [], pagination: null });
					}
					const invoiceId = ctx.query?.invoiceId;
					try {
						const params: { invoice_id?: string } = {};
						if (invoiceId) params.invoice_id = invoiceId;
						const result = await client.listPayments(params);
						return ctx.json({
							hasConsumer: true,
							data: result.data,
							pagination: result.pagination,
						});
					} catch (err) {
						toAPIError("StreamPay listPayments failed.", err, ctx.context.logger);
					}
				},
			),
		};
	};
