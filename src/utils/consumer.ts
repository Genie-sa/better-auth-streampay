import type { ConsumerResponse } from "@streamsdk/typescript";
import type { StreamPayClient } from "../types";

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

export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return a.trim() === b.trim();
}

export interface ConsumerIdentifiers {
	email?: string | null;
	phone_number?: string | null;
	external_id?: string | null;
	iban?: string | null;
}

export async function findConsumerByIdentifiers(
	client: StreamPayClient,
	identifiers: ConsumerIdentifiers,
): Promise<ConsumerResponse | null> {
	if (identifiers.email) {
		const hit = await searchExact(client, identifiers.email, (c) =>
			sameEmail(c.email, identifiers.email),
		);
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
