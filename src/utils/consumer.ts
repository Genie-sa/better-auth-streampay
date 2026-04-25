import type { ConsumerResponse } from "@streamsdk/typescript";
import type { StreamPayClient } from "../types";

// `search_term` fuzzy-matches across email/phone/external_id/iban, but
// we need exact matches (u@x.co must NOT hit u@x.com). So we pass the
// identifier as search_term for O(1) API calls, then filter in memory.

const SEARCH_PAGE_SIZE = 50;

export interface FindConsumerByExternalIdOptions {
	externalId: string;
}

export async function findConsumerByExternalId(
	client: StreamPayClient,
	{ externalId }: FindConsumerByExternalIdOptions,
): Promise<string | null> {
	const hit = await searchExact(client, externalId, (c) => c.external_id === externalId);
	return hit?.id ?? null;
}

// StreamPay treats each of these as unique, so DUPLICATE_CONSUMER can
// fire on any — the reuse path must match whichever the caller sent.
export interface ConsumerIdentifiers {
	email?: string | null;
	phone_number?: string | null;
	external_id?: string | null;
	iban?: string | null;
}

/**
 * Exact match on ANY supplied identifier — one `search_term` query per
 * populated identifier, stops at first hit. Returns the full consumer
 * so callers can inspect `external_id` for the stranded vs. linked
 * decision.
 */
export async function findConsumerByIdentifiers(
	client: StreamPayClient,
	identifiers: ConsumerIdentifiers,
): Promise<ConsumerResponse | null> {
	if (identifiers.email) {
		const hit = await searchExact(client, identifiers.email, (c) => c.email === identifiers.email);
		if (hit) return hit;
	}
	if (identifiers.phone_number) {
		const hit = await searchExact(
			client,
			identifiers.phone_number,
			(c) => c.phone_number === identifiers.phone_number,
		);
		if (hit) return hit;
	}
	if (identifiers.external_id) {
		const hit = await searchExact(
			client,
			identifiers.external_id,
			(c) => c.external_id === identifiers.external_id,
		);
		if (hit) return hit;
	}
	if (identifiers.iban) {
		const hit = await searchExact(client, identifiers.iban, (c) => c.iban === identifiers.iban);
		if (hit) return hit;
	}
	return null;
}

async function searchExact(
	client: StreamPayClient,
	term: string,
	predicate: (c: ConsumerResponse) => boolean,
): Promise<ConsumerResponse | null> {
	const response = await client.listConsumers({
		search_term: term,
		page: 1,
		size: SEARCH_PAGE_SIZE,
	});
	const items = response.data ?? [];
	return items.find(predicate) ?? null;
}
