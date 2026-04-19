import type {
	InvoiceListItem,
	InvoiceListResponse,
	PaginationParams,
	SubscriptionDetailed,
	SubscriptionListResponse,
} from "@streamsdk/typescript";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import type { StreamPayClient, StreamPayOptions } from "../types";
import { findConsumerByExternalId } from "../utils/consumer";
import { resolveConsumerLookupMaxPages } from "../utils/ensure-consumer";
import { rejectUnauthorized, toAPIError } from "../utils/errors";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";

export interface PortalOptions {
	/**
	 * Overrides the top-level `StreamPayOptions.consumerLookupMaxPages`
	 * for portal reads only. Useful when the portal's list-filtering
	 * cost profile differs from the rest of the plugin's lookup paths.
	 */
	consumerLookupMaxPages?: number;
}

/**
 * Portal reads never eagerly create a consumer — a user with no
 * StreamPay footprint has no billing data to show, so we return an
 * empty `{ hasConsumer: false, ... }` shape. The legacy list-scan
 * covers users who predate the schema extension. Anonymous sessions
 * are rejected up front to avoid leaking an orphan consumer row.
 */
async function getConsumerIdOrNull(
	client: StreamPayClient,
	user: StreamPaySessionUser | null,
	maxPages: number,
): Promise<string | null> {
	rejectUnauthorized(user, "Anonymous users cannot access the billing portal.");
	if (user.streampayConsumerId) return user.streampayConsumerId;
	return findConsumerByExternalId(client, {
		externalId: user.id,
		maxPages,
	});
}

/**
 * Walk `fetchPage` one page at a time, collecting every item whose
 * `organization_consumer_id` matches `consumerId`. Stops when the SDK
 * reports `has_next_page: false` or the page cap is reached — the cap
 * is the same knob (`consumerLookupMaxPages`) that governs consumer
 * recovery scans, tied to StreamPay's 100-item page ceiling.
 *
 * Why this exists: the StreamPay REST API supports
 * `?organization_consumer_id=<id>` on `/subscriptions` and `/invoices`,
 * but `@streamsdk/typescript` narrows those list methods to
 * `PaginationParams` only. Until the SDK widens, the only contract-
 * compatible way to return all of a user's items is to paginate and
 * filter in memory. This fixes the latent truncation-at-100 bug the
 * single-page filter used to have.
 */
async function collectByConsumer<T extends { organization_consumer_id?: string | null }>(
	fetchPage: (params: PaginationParams) => Promise<{
		data?: T[];
		pagination?: { has_next_page?: boolean };
	}>,
	consumerId: string,
	maxPages: number,
): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; page <= maxPages; page++) {
		const response = await fetchPage({ page, size: 100 });
		for (const item of response.data ?? []) {
			if (item.organization_consumer_id === consumerId) out.push(item);
		}
		if (response.pagination?.has_next_page !== true) break;
	}
	return out;
}

export const portal =
	({ consumerLookupMaxPages }: PortalOptions = {}) =>
	(options: StreamPayOptions) => {
		const client = options.client;
		const maxPages = resolveConsumerLookupMaxPages(options, consumerLookupMaxPages);
		return {
			state: createAuthEndpoint(
				"/consumer/state",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					const user = asSessionUser(ctx.context.session?.user);
					const consumerId = await getConsumerIdOrNull(client, user, maxPages);
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
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					const user = asSessionUser(ctx.context.session?.user);
					const consumerId = await getConsumerIdOrNull(client, user, maxPages);
					if (!consumerId) {
						return ctx.json({ hasConsumer: false, data: [] });
					}
					try {
						const items = await collectByConsumer<SubscriptionDetailed>(
							(params) =>
								client.listSubscriptions(params) as Promise<
									Pick<SubscriptionListResponse, "data" | "pagination">
								>,
							consumerId,
							maxPages,
						);
						return ctx.json({ hasConsumer: true, data: items });
					} catch (err) {
						toAPIError("StreamPay listSubscriptions failed.", err, ctx.context.logger);
					}
				},
			),

			invoices: createAuthEndpoint(
				"/consumer/invoices/list",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					const user = asSessionUser(ctx.context.session?.user);
					const consumerId = await getConsumerIdOrNull(client, user, maxPages);
					if (!consumerId) {
						return ctx.json({ hasConsumer: false, data: [] });
					}
					try {
						const items = await collectByConsumer<InvoiceListItem>(
							(params) =>
								client.listInvoices(params) as Promise<
									Pick<InvoiceListResponse, "data" | "pagination">
								>,
							consumerId,
							maxPages,
						);
						return ctx.json({ hasConsumer: true, data: items });
					} catch (err) {
						toAPIError("StreamPay listInvoices failed.", err, ctx.context.logger);
					}
				},
			),
		};
	};

