import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockAPIError } = vi.hoisted(() => {
	class MockAPIError extends Error {
		public readonly code: string;
		public readonly data: { message?: string } | undefined;
		constructor(code: string, data?: { message?: string }) {
			super(data?.message ?? code);
			this.name = "APIError";
			this.code = code;
			this.data = data;
		}
	}
	return { MockAPIError };
});

vi.mock("better-auth/api", () => ({
	APIError: MockAPIError,
	sessionMiddleware: vi.fn(),
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import { portal } from "../src/plugins/portal";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
import {
	createMockConsumer,
	createMockConsumerList,
	createMockContext,
	createMockInvoice,
	createMockInvoiceList,
	createMockStreamPayClient,
	createMockSubscription,
	createMockSubscriptionList,
	createMockUser,
	type MockCtx,
	type MockedStreamPayClient,
} from "./utils/mocks";

const LINKED_CONSUMER = "cons_linked";

describe("portal plugin", () => {
	let mockClient: MockedStreamPayClient;

	beforeEach(() => {
		mockClient = createMockStreamPayClient();
		vi.clearAllMocks();
	});

	describe("plugin creation", () => {
		it("registers state, subscriptions, and invoices endpoints (payments dropped in 0.3)", () => {
			const plugin = portal();
			const endpoints = plugin(createTestStreamPayOptions({ client: mockClient }));

			expect(endpoints).toHaveProperty("state");
			expect(endpoints).toHaveProperty("subscriptions");
			expect(endpoints).toHaveProperty("invoices");
			expect(endpoints).not.toHaveProperty("payments");
		});
	});

	describe("state endpoint", () => {
		let handler: (ctx: MockCtx) => Promise<unknown>;

		beforeEach(() => {
			handler = unwrapHandler(portal()(createTestStreamPayOptions({ client: mockClient })).state);
		});

		it("returns the linked consumer for the authenticated user", async () => {
			const consumer = createMockConsumer({ id: LINKED_CONSUMER });
			mockClient.getConsumer.mockResolvedValue(consumer);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});

			const result = await handler(ctx);

			expect(mockClient.getConsumer).toHaveBeenCalledWith(LINKED_CONSUMER);
			expect(result).toEqual({ hasConsumer: true, consumer });
		});

		it("throws UNAUTHORIZED when there is no session user", async () => {
			const ctx = createMockContext({ user: undefined });
			await expect(handler(ctx)).rejects.toThrow(/Session user is missing/);
		});

		it("throws UNAUTHORIZED for anonymous sessions (no billing data for anon)", async () => {
			const ctx = createMockContext({
				user: { ...createMockUser({ streampayConsumerId: null }), isAnonymous: true },
			});
			await expect(handler(ctx)).rejects.toThrow(/Anonymous users cannot access/);
			expect(mockClient.listConsumers).not.toHaveBeenCalled();
			expect(mockClient.getConsumer).not.toHaveBeenCalled();
		});

		it("returns { hasConsumer: false, consumer: null } when no consumer is linked and the scan is empty", async () => {
			mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: null }),
			});
			const result = await handler(ctx);
			expect(result).toEqual({ hasConsumer: false, consumer: null });
			expect(mockClient.getConsumer).not.toHaveBeenCalled();
		});

		it("falls back to a list-scan when streampayConsumerId is not stored", async () => {
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([
					createMockConsumer({ id: "cons_scanned", external_id: "user-legacy" }),
				]),
			);
			mockClient.getConsumer.mockResolvedValue(createMockConsumer({ id: "cons_scanned" }));

			const ctx = createMockContext({
				user: createMockUser({ id: "user-legacy", streampayConsumerId: null }),
			});

			const result = await handler(ctx);

			expect(mockClient.listConsumers).toHaveBeenCalled();
			expect(mockClient.getConsumer).toHaveBeenCalledWith("cons_scanned");
			expect(result).toMatchObject({ hasConsumer: true });
		});

		it("translates SDK errors into INTERNAL_SERVER_ERROR", async () => {
			mockClient.getConsumer.mockRejectedValue(mockApiError(500, { error: { message: "down" } }));
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});

			await expect(handler(ctx)).rejects.toThrow(/getConsumer failed/);
			expect(ctx.context.logger.error).toHaveBeenCalled();
		});
	});

	describe("subscriptions endpoint", () => {
		interface SubsResponse {
			hasConsumer: boolean;
			data: Array<{ id: string }>;
		}
		let handler: (ctx: MockCtx) => Promise<SubsResponse>;

		beforeEach(() => {
			handler = unwrapHandler<SubsResponse>(
				portal()(createTestStreamPayOptions({ client: mockClient })).subscriptions,
			);
		});

		it("returns only subscriptions owned by the authenticated consumer", async () => {
			mockClient.listSubscriptions.mockResolvedValue(
				createMockSubscriptionList([
					createMockSubscription({
						id: "sub_mine",
						organization_consumer_id: LINKED_CONSUMER,
					}),
					createMockSubscription({
						id: "sub_other",
						organization_consumer_id: "cons_other",
					}),
				]),
			);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});

			const result = await handler(ctx);
			expect(result).toMatchObject({ hasConsumer: true });
			expect(result.data).toHaveLength(1);
			expect(result.data[0]?.id).toBe("sub_mine");
		});

		it("requires a session", async () => {
			const ctx = createMockContext({ user: undefined });
			await expect(handler(ctx)).rejects.toThrow(/Session user is missing/);
		});

		it("rejects anonymous sessions with UNAUTHORIZED", async () => {
			const ctx = createMockContext({
				user: { ...createMockUser({ streampayConsumerId: null }), isAnonymous: true },
			});
			await expect(handler(ctx)).rejects.toThrow(/Anonymous users cannot access/);
			expect(mockClient.listSubscriptions).not.toHaveBeenCalled();
		});

		it("returns { hasConsumer: false, data: [] } when no consumer is linked", async () => {
			mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: null }),
			});
			const result = await handler(ctx);
			expect(result).toEqual({ hasConsumer: false, data: [] });
			expect(mockClient.listSubscriptions).not.toHaveBeenCalled();
		});

		it("paginates across multiple pages until has_next_page is false", async () => {
			// Simulates an org with more subscriptions than the page cap (100).
			// The client-side filter would silently truncate to the first page
			// on the old single-page implementation; the exhaustion loop must
			// walk every page and still return only this user's items.
			mockClient.listSubscriptions
				.mockResolvedValueOnce({
					data: [
						createMockSubscription({
							id: "sub_page1_mine",
							organization_consumer_id: LINKED_CONSUMER,
						}),
						createMockSubscription({
							id: "sub_page1_other",
							organization_consumer_id: "cons_other",
						}),
					],
					pagination: {
						total_count: 3,
						current_page: 1,
						limit: 2,
						max_page: 2,
						has_next_page: true,
						has_previous_page: false,
					},
				})
				.mockResolvedValueOnce({
					data: [
						createMockSubscription({
							id: "sub_page2_mine",
							organization_consumer_id: LINKED_CONSUMER,
						}),
					],
					pagination: {
						total_count: 3,
						current_page: 2,
						limit: 2,
						max_page: 2,
						has_next_page: false,
						has_previous_page: true,
					},
				});

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});

			const result = await handler(ctx);

			expect(mockClient.listSubscriptions).toHaveBeenCalledTimes(2);
			expect(mockClient.listSubscriptions).toHaveBeenNthCalledWith(1, { page: 1, size: 100 });
			expect(mockClient.listSubscriptions).toHaveBeenNthCalledWith(2, { page: 2, size: 100 });
			expect(result.data.map((s) => s.id).sort()).toEqual(["sub_page1_mine", "sub_page2_mine"]);
		});

		it("respects the consumerLookupMaxPages cap when has_next_page never settles", async () => {
			// Pathological case — the API keeps saying "has_next_page: true"
			// but the user's items never appear. The cap prevents an
			// unbounded scan.
			const neverDone = {
				data: [
					createMockSubscription({
						id: "sub_other",
						organization_consumer_id: "cons_other",
					}),
				],
				pagination: {
					total_count: 9999,
					current_page: 1,
					limit: 1,
					max_page: 9999,
					has_next_page: true,
					has_previous_page: false,
				},
			};
			mockClient.listSubscriptions.mockResolvedValue(neverDone);

			// Cap via the portal-level override to keep the test fast.
			const handler3 = unwrapHandler<SubsResponse>(
				portal({ consumerLookupMaxPages: 3 })(
					createTestStreamPayOptions({ client: mockClient }),
				).subscriptions,
			);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});
			const result = await handler3(ctx);

			expect(mockClient.listSubscriptions).toHaveBeenCalledTimes(3);
			expect(result.data).toEqual([]);
		});

		it("top-level consumerLookupMaxPages from StreamPayOptions is used when portal option is not set", async () => {
			mockClient.listSubscriptions.mockResolvedValue({
				data: [],
				pagination: {
					total_count: 9999,
					current_page: 1,
					limit: 100,
					max_page: 9999,
					has_next_page: true,
					has_previous_page: false,
				},
			});

			const handler2 = unwrapHandler<SubsResponse>(
				portal()(
					createTestStreamPayOptions({ client: mockClient, consumerLookupMaxPages: 2 }),
				).subscriptions,
			);
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});
			await handler2(ctx);

			expect(mockClient.listSubscriptions).toHaveBeenCalledTimes(2);
		});

		it("portal-level override beats the top-level consumerLookupMaxPages", async () => {
			mockClient.listSubscriptions.mockResolvedValue({
				data: [],
				pagination: {
					total_count: 9999,
					current_page: 1,
					limit: 100,
					max_page: 9999,
					has_next_page: true,
					has_previous_page: false,
				},
			});

			const handler2 = unwrapHandler<SubsResponse>(
				portal({ consumerLookupMaxPages: 1 })(
					createTestStreamPayOptions({ client: mockClient, consumerLookupMaxPages: 99 }),
				).subscriptions,
			);
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});
			await handler2(ctx);

			expect(mockClient.listSubscriptions).toHaveBeenCalledTimes(1);
		});

		it("translates SDK errors into INTERNAL_SERVER_ERROR", async () => {
			mockClient.listSubscriptions.mockRejectedValue(
				mockApiError(502, { error: { message: "bad gateway" } }),
			);
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});
			await expect(handler(ctx)).rejects.toThrow(/listSubscriptions failed/);
		});
	});

	describe("invoices endpoint", () => {
		interface InvoicesResponse {
			hasConsumer: boolean;
			data: Array<{ id?: string }>;
		}
		let handler: (ctx: MockCtx) => Promise<InvoicesResponse>;

		beforeEach(() => {
			handler = unwrapHandler<InvoicesResponse>(
				portal()(createTestStreamPayOptions({ client: mockClient })).invoices,
			);
		});

		it("returns only invoices scoped to the authenticated consumer", async () => {
			mockClient.listInvoices.mockResolvedValue(
				createMockInvoiceList([
					createMockInvoice({
						id: "inv_mine",
						organization_consumer_id: LINKED_CONSUMER,
					}),
					createMockInvoice({
						id: "inv_other",
						organization_consumer_id: "cons_other",
					}),
				]),
			);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});

			const result = await handler(ctx);
			expect(result.data).toHaveLength(1);
			expect(result.data[0]?.id).toBe("inv_mine");
		});

		it("requires a session", async () => {
			const ctx = createMockContext({ user: undefined });
			await expect(handler(ctx)).rejects.toThrow(/Session user is missing/);
		});

		it("rejects anonymous sessions with UNAUTHORIZED", async () => {
			const ctx = createMockContext({
				user: { ...createMockUser({ streampayConsumerId: null }), isAnonymous: true },
			});
			await expect(handler(ctx)).rejects.toThrow(/Anonymous users cannot access/);
			expect(mockClient.listInvoices).not.toHaveBeenCalled();
		});

		it("returns an empty list when the SDK has no matching invoices", async () => {
			mockClient.listInvoices.mockResolvedValue(createMockInvoiceList());
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});
			const result = await handler(ctx);
			expect(result).toMatchObject({ hasConsumer: true });
			expect(result.data).toEqual([]);
		});

		it("returns { hasConsumer: false, data: [] } when no consumer is linked", async () => {
			mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: null }),
			});
			const result = await handler(ctx);
			expect(result).toEqual({ hasConsumer: false, data: [] });
			expect(mockClient.listInvoices).not.toHaveBeenCalled();
		});

		it("paginates invoices across pages until has_next_page is false", async () => {
			mockClient.listInvoices
				.mockResolvedValueOnce({
					data: [
						createMockInvoice({
							id: "inv_page1_mine",
							organization_consumer_id: LINKED_CONSUMER,
						}),
					],
					pagination: {
						total_count: 2,
						current_page: 1,
						limit: 1,
						max_page: 2,
						has_next_page: true,
						has_previous_page: false,
					},
				})
				.mockResolvedValueOnce({
					data: [
						createMockInvoice({
							id: "inv_page2_mine",
							organization_consumer_id: LINKED_CONSUMER,
						}),
					],
					pagination: {
						total_count: 2,
						current_page: 2,
						limit: 1,
						max_page: 2,
						has_next_page: false,
						has_previous_page: true,
					},
				});

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});

			const result = await handler(ctx);

			expect(mockClient.listInvoices).toHaveBeenCalledTimes(2);
			expect(result.data.map((i) => i.id).sort()).toEqual(["inv_page1_mine", "inv_page2_mine"]);
		});

		it("translates SDK errors into INTERNAL_SERVER_ERROR", async () => {
			mockClient.listInvoices.mockRejectedValue(
				mockApiError(503, { error: { message: "unavailable" } }),
			);
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});
			await expect(handler(ctx)).rejects.toThrow(/listInvoices failed/);
		});
	});

	// Reference MockAPIError so it isn't flagged as unused; we instantiate
	// it implicitly when APIError is thrown via the mocked module.
	void MockAPIError;
});
