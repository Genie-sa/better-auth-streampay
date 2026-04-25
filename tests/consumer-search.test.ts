import { describe, expect, it } from "vitest";
import { findConsumerByExternalId, findConsumerByIdentifiers } from "../src/utils/consumer";
import {
	createMockConsumer,
	createMockConsumerList,
	createMockStreamPayClient,
} from "./utils/mocks";

/**
 * Regression coverage for the #1 refactor: consumer lookups must use
 * the `search_term` query param and exact-match in memory, not a
 * paginated scan. These tests fail loudly if anyone drops `search_term`
 * or widens the exact-equality filter into a fuzzy match.
 */

describe("findConsumerByExternalId (search_term-based)", () => {
	it("calls listConsumers with search_term=<externalId> and a capped page size", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers.mockResolvedValue(
			createMockConsumerList([createMockConsumer({ id: "cons_1", external_id: "user-42" })]),
		);

		const id = await findConsumerByExternalId(client, { externalId: "user-42" });

		expect(id).toBe("cons_1");
		expect(client.listConsumers).toHaveBeenCalledTimes(1);
		const params = client.listConsumers.mock.calls[0]?.[0];
		expect(params).toEqual(expect.objectContaining({ search_term: "user-42" }));
		// Size must be bounded — search_term is fuzzy, so the response
		// page could carry many unrelated rows that the predicate filters.
		expect(typeof params?.size).toBe("number");
		expect(params?.size).toBeLessThanOrEqual(100);
	});

	it("filters out fuzzy-matching consumers whose external_id is not an exact match", async () => {
		const client = createMockStreamPayClient();
		// The fuzzy search returns both a prefix hit and the real hit.
		client.listConsumers.mockResolvedValue(
			createMockConsumerList([
				createMockConsumer({ id: "cons_prefix", external_id: "user-4" }),
				createMockConsumer({ id: "cons_exact", external_id: "user-42" }),
			]),
		);

		const id = await findConsumerByExternalId(client, { externalId: "user-42" });
		expect(id).toBe("cons_exact");
	});

	it("returns null when no row in the page matches exactly", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers.mockResolvedValue(
			createMockConsumerList([createMockConsumer({ id: "cons_other", external_id: "user-other" })]),
		);

		const id = await findConsumerByExternalId(client, { externalId: "user-42" });
		expect(id).toBeNull();
	});
});

describe("findConsumerByIdentifiers (search_term-based)", () => {
	it("issues one search_term call per populated identifier and stops at the first exact hit", async () => {
		const client = createMockStreamPayClient();
		// Email call returns a fuzzy-but-not-exact hit → no match, falls
		// through to phone. Phone call returns the actual exact hit.
		client.listConsumers
			.mockResolvedValueOnce(
				createMockConsumerList([
					createMockConsumer({ id: "cons_wrong", email: "other@example.com" }),
				]),
			)
			.mockResolvedValueOnce(
				createMockConsumerList([
					createMockConsumer({ id: "cons_by_phone", phone_number: "+966501234567" }),
				]),
			);

		const consumer = await findConsumerByIdentifiers(client, {
			email: "user@example.com",
			phone_number: "+966501234567",
		});

		expect(consumer?.id).toBe("cons_by_phone");
		expect(client.listConsumers).toHaveBeenCalledTimes(2);
		expect(client.listConsumers.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ search_term: "user@example.com" }),
		);
		expect(client.listConsumers.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ search_term: "+966501234567" }),
		);
	});

	it("short-circuits after the first exact hit (does not call for later identifiers)", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers.mockResolvedValue(
			createMockConsumerList([createMockConsumer({ id: "cons_email", email: "user@example.com" })]),
		);

		const consumer = await findConsumerByIdentifiers(client, {
			email: "user@example.com",
			phone_number: "+966501234567",
			external_id: "user-42",
			iban: "SA03800000500333666666",
		});

		expect(consumer?.id).toBe("cons_email");
		expect(client.listConsumers).toHaveBeenCalledTimes(1);
	});

	it("returns null when no identifier yields an exact match", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers.mockResolvedValue(createMockConsumerList([]));

		const consumer = await findConsumerByIdentifiers(client, {
			email: "nobody@example.com",
			phone_number: "+966500000000",
		});

		expect(consumer).toBeNull();
	});

	it("makes zero calls when no identifier is populated", async () => {
		const client = createMockStreamPayClient();
		const consumer = await findConsumerByIdentifiers(client, {});
		expect(consumer).toBeNull();
		expect(client.listConsumers).not.toHaveBeenCalled();
	});
});
