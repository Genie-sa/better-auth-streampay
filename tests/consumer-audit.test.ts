import { describe, expect, it } from "vitest";
import { findConsumerByExternalId, findConsumerByIdentifiers } from "../src/utils/consumer";
import {
	createMockConsumer,
	createMockConsumerList,
	createMockStreamPayClient,
} from "./utils/mocks";

function searchPage(page: number, hasNext: boolean, id: string, externalId: string) {
	return {
		...createMockConsumerList([createMockConsumer({ id, external_id: externalId })]),
		pagination: { current_page: page, has_next_page: hasNext, max_page: 2 },
	};
}

describe("paginated exact consumer ownership", () => {
	it("finds an exact external ID after fuzzy matches on the first page", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers
			.mockResolvedValueOnce(searchPage(1, true, "unrelated", "user-420"))
			.mockResolvedValueOnce(searchPage(2, false, "owned", "user-42"));

		expect(await findConsumerByExternalId(client, { externalId: "user-42" })).toBe("owned");
		expect(client.listConsumers.mock.calls.map(([params]) => params)).toEqual([
			{ search_term: "user-42", page: 1, limit: 50 },
			{ search_term: "user-42", page: 2, limit: 50 },
		]);
	});

	it("exhausts the email search before falling back to another identity", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers
			.mockResolvedValueOnce(searchPage(1, true, "unrelated", "other"))
			.mockResolvedValueOnce({
				...searchPage(2, false, "email-owner", "user"),
				data: [createMockConsumer({ id: "email-owner", email: "owner@example.com" })],
			});

		expect(
			(
				await findConsumerByIdentifiers(client, {
					email: "owner@example.com",
					phone_number: "+966501234567",
				})
			)?.id,
		).toBe("email-owner");
		expect(
			client.listConsumers.mock.calls.every(
				([params]) => params?.search_term === "owner@example.com",
			),
		).toBe(true);
	});

	it("uses max_page when the provider omits has_next_page", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers
			.mockResolvedValueOnce({
				data: [createMockConsumer({ id: "unrelated", external_id: "other" })],
				pagination: { current_page: 1, max_page: 2 },
			})
			.mockResolvedValueOnce(searchPage(2, false, "owned", "user-42"));

		expect(await findConsumerByExternalId(client, { externalId: "user-42" })).toBe("owned");
	});

	it("continues a full page when pagination metadata is absent", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers
			.mockResolvedValueOnce({
				data: Array.from({ length: 50 }, (_, index) =>
					createMockConsumer({ id: `unrelated-${index}`, external_id: "other" }),
				),
			})
			.mockResolvedValueOnce({
				data: [createMockConsumer({ id: "owned", external_id: "user-42" })],
			});

		expect(await findConsumerByExternalId(client, { externalId: "user-42" })).toBe("owned");
	});

	it("propagates a later-page failure instead of reporting the consumer absent", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers
			.mockResolvedValueOnce(searchPage(1, true, "unrelated", "other"))
			.mockRejectedValueOnce(new Error("Provider unavailable"));

		await expect(findConsumerByExternalId(client, { externalId: "user-42" })).rejects.toThrow(
			"Provider unavailable",
		);
	});

	it("fails closed when the provider returns the first page for a later page", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers.mockResolvedValue(searchPage(1, true, "unrelated", "other"));

		await expect(findConsumerByExternalId(client, { externalId: "user-42" })).rejects.toThrow(
			/consumer search pagination/i,
		);
		expect(client.listConsumers).toHaveBeenCalledTimes(2);
	});

	it("detects cyclic search results when page numbers are omitted", async () => {
		const client = createMockStreamPayClient();
		client.listConsumers
			.mockResolvedValueOnce({
				data: [createMockConsumer({ id: "a" })],
				pagination: { has_next_page: true },
			})
			.mockResolvedValueOnce({
				data: [createMockConsumer({ id: "b" })],
				pagination: { has_next_page: true },
			})
			.mockResolvedValueOnce({
				data: [createMockConsumer({ id: "a" })],
				pagination: { has_next_page: true },
			});

		await expect(findConsumerByExternalId(client, { externalId: "user-42" })).rejects.toThrow(
			/consumer search pagination/i,
		);
		expect(client.listConsumers).toHaveBeenCalledTimes(3);
	});
});
