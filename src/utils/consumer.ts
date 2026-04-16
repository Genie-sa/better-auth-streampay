import type { ConsumerResponse } from "@streamsdk/typescript";
import type { StreamPayClient } from "../types";

/**
 * StreamPay's /consumers list endpoint exposes a `search_term` query
 * parameter for fuzzy matching, but the semantics (which fields it
 * searches, how it ranks) are not contractually documented and we
 * need exact identifier matches here — not fuzzy ones. These helpers
 * paginate through the consumer table and match in memory so the
 * comparison is always an exact string equality.
 *
 * The scan is capped so behavior stays predictable on large orgs.
 * The `onBeforeUserCreate` hook only invokes these helpers when it
 * hits a DUPLICATE_CONSUMER error, so the scan cost is paid rarely,
 * not on every signup.
 */

export interface FindConsumerByExternalIdOptions {
	externalId: string;
	maxPages?: number;
	pageSize?: number;
}

export async function findConsumerByExternalId(
	client: StreamPayClient,
	{ externalId, maxPages = 10, pageSize = 100 }: FindConsumerByExternalIdOptions,
): Promise<string | null> {
	const hit = await scanConsumers(
		client,
		{ maxPages, pageSize },
		(c) => c.external_id === externalId,
	);
	return hit?.id ?? null;
}

/**
 * The set of identifiers StreamPay treats as unique on a consumer.
 * `DUPLICATE_CONSUMER` can fire on any of them, so the reuse-after-
 * duplicate path matches on whichever ones the caller sent.
 */
export interface ConsumerIdentifiers {
	email?: string | null;
	phone_number?: string | null;
	external_id?: string | null;
	iban?: string | null;
}

/**
 * Paginated scan that returns the first consumer matching ANY of the
 * supplied identifiers. Returns the full consumer object (not just
 * the id) because callers need to inspect `external_id` to decide
 * whether the consumer is stranded (safe to reuse) or linked to
 * another Better Auth user (refuse — reusing it would mean inheriting
 * someone else's billing history).
 *
 * Intentionally generic over identifier type: caller passes whatever
 * they sent to `createConsumer`, we scan for matches on any set field.
 */
export async function findConsumerByIdentifiers(
	client: StreamPayClient,
	identifiers: ConsumerIdentifiers,
	opts: { maxPages?: number; pageSize?: number } = {},
): Promise<ConsumerResponse | null> {
	const { maxPages = 10, pageSize = 100 } = opts;
	return scanConsumers(client, { maxPages, pageSize }, (c) => matchesAnyIdentifier(c, identifiers));
}

function matchesAnyIdentifier(
	consumer: ConsumerResponse,
	identifiers: ConsumerIdentifiers,
): boolean {
	if (identifiers.email && consumer.email === identifiers.email) return true;
	if (identifiers.phone_number && consumer.phone_number === identifiers.phone_number) {
		return true;
	}
	if (identifiers.external_id && consumer.external_id === identifiers.external_id) {
		return true;
	}
	if (identifiers.iban && consumer.iban === identifiers.iban) return true;
	return false;
}

async function scanConsumers(
	client: StreamPayClient,
	{ maxPages, pageSize }: { maxPages: number; pageSize: number },
	predicate: (c: ConsumerResponse) => boolean,
): Promise<ConsumerResponse | null> {
	for (let page = 1; page <= maxPages; page++) {
		const response = await client.listConsumers({ page, size: pageSize });
		const items = response.data ?? [];
		const hit = items.find(predicate);
		if (hit) return hit;

		const total = response.pagination?.total_count ?? 0;
		if (items.length < pageSize || page * pageSize >= total) return null;
	}
	return null;
}
