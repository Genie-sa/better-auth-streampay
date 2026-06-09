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

	describe("state endpoint", () => {
		let handler: (ctx: MockCtx) => Promise<unknown>;

		beforeEach(() => {
			handler = unwrapHandler(
				portal()(createTestStreamPayOptions({ client: mockClient })).endpoints.state,
			);
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
				portal()(createTestStreamPayOptions({ client: mockClient })).endpoints.subscriptions,
			);
		});

		it("scopes the SDK call to the authenticated consumer and returns the response data", async () => {
			mockClient.listSubscriptions.mockResolvedValue(
				createMockSubscriptionList([
					createMockSubscription({
						id: "sub_mine",
						organization_consumer_id: LINKED_CONSUMER,
					}),
				]),
			);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});

			const result = await handler(ctx);

			expect(mockClient.listSubscriptions).toHaveBeenCalledTimes(1);
			expect(mockClient.listSubscriptions).toHaveBeenCalledWith({
				organization_consumer_id: LINKED_CONSUMER,
				page: 1,
				size: 100,
			});
			expect(result).toMatchObject({ hasConsumer: true });
			expect(result.data).toHaveLength(1);
			expect(result.data[0]?.id).toBe("sub_mine");
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

		it("honors the PortalOptions pageSize override, clamped to the StreamPay 100-row cap", async () => {
			mockClient.listSubscriptions.mockResolvedValue(createMockSubscriptionList([]));

			const handler2 = unwrapHandler<SubsResponse>(
				portal({ pageSize: 250 })(createTestStreamPayOptions({ client: mockClient })).endpoints
					.subscriptions,
			);
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});
			await handler2(ctx);

			expect(mockClient.listSubscriptions).toHaveBeenCalledWith(
				expect.objectContaining({ size: 100 }),
			);
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
				portal()(createTestStreamPayOptions({ client: mockClient })).endpoints.invoices,
			);
		});

		it("scopes the SDK call to the authenticated consumer and returns the response data", async () => {
			mockClient.listInvoices.mockResolvedValue(
				createMockInvoiceList([
					createMockInvoice({
						id: "inv_mine",
						organization_consumer_id: LINKED_CONSUMER,
					}),
				]),
			);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});

			const result = await handler(ctx);

			expect(mockClient.listInvoices).toHaveBeenCalledTimes(1);
			expect(mockClient.listInvoices).toHaveBeenCalledWith({
				organization_consumer_id: LINKED_CONSUMER,
				page: 1,
				size: 100,
			});
			expect(result.data).toHaveLength(1);
			expect(result.data[0]?.id).toBe("inv_mine");
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

	void MockAPIError;
});
