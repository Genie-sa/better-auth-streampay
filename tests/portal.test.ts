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
	createMockPayment,
	createMockPaymentList,
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
		it("registers all four portal endpoints", () => {
			const plugin = portal();
			const endpoints = plugin(createTestStreamPayOptions({ client: mockClient }));

			expect(endpoints).toHaveProperty("state");
			expect(endpoints).toHaveProperty("subscriptions");
			expect(endpoints).toHaveProperty("invoices");
			expect(endpoints).toHaveProperty("payments");
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
			data: Array<{ id: string }>;
			pagination: unknown;
		}
		let handler: (ctx: MockCtx) => Promise<SubsResponse>;

		beforeEach(() => {
			handler = unwrapHandler<SubsResponse>(portal()(createTestStreamPayOptions({ client: mockClient })).subscriptions);
		});

		it("returns only subscriptions owned by the authenticated consumer and sets hasConsumer", async () => {
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

		it("returns { hasConsumer: false, data: [] } when no consumer is linked", async () => {
			mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: null }),
			});
			const result = await handler(ctx);
			expect(result).toEqual({ hasConsumer: false, data: [], pagination: null });
			expect(mockClient.listSubscriptions).not.toHaveBeenCalled();
		});

		it("propagates pagination params (page, limit -> size) to the SDK", async () => {
			mockClient.listSubscriptions.mockResolvedValue(createMockSubscriptionList());
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				query: { page: 2, limit: 50 },
			});
			await handler(ctx);
			expect(mockClient.listSubscriptions).toHaveBeenCalledWith({
				page: 2,
				size: 50,
			});
		});
	});

	describe("invoices endpoint", () => {
		interface InvoicesResponse {
			data: Array<{ id?: string }>;
			pagination: unknown;
		}
		let handler: (ctx: MockCtx) => Promise<InvoicesResponse>;

		beforeEach(() => {
			handler = unwrapHandler<InvoicesResponse>(portal()(createTestStreamPayOptions({ client: mockClient })).invoices);
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
			expect(result).toEqual({ hasConsumer: false, data: [], pagination: null });
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

	describe("payments endpoint", () => {
		interface PaymentsResponse {
			data: Array<{ id?: string }>;
			pagination: unknown;
		}
		let handler: (ctx: MockCtx) => Promise<PaymentsResponse>;

		beforeEach(() => {
			handler = unwrapHandler<PaymentsResponse>(portal()(createTestStreamPayOptions({ client: mockClient })).payments);
		});

		it("returns the payments list for the authenticated user", async () => {
			mockClient.listPayments.mockResolvedValue(
				createMockPaymentList([createMockPayment({ id: "pay_1" })]),
			);
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});
			const result = await handler(ctx);
			expect(result.data).toHaveLength(1);
			expect(result.data[0]?.id).toBe("pay_1");
		});

		it("passes invoiceId query param as invoice_id filter to the SDK", async () => {
			mockClient.listPayments.mockResolvedValue(createMockPaymentList());
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				query: { invoiceId: "11111111-1111-1111-1111-111111111111" },
			});
			await handler(ctx);
			expect(mockClient.listPayments).toHaveBeenCalledWith({
				invoice_id: "11111111-1111-1111-1111-111111111111",
			});
		});

		it("returns { hasConsumer: false, data: [] } when no consumer is linked", async () => {
			mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: null }),
			});
			const result = await handler(ctx);
			expect(result).toEqual({ hasConsumer: false, data: [], pagination: null });
			expect(mockClient.listPayments).not.toHaveBeenCalled();
		});

		it("requires a session", async () => {
			const ctx = createMockContext({ user: undefined });
			await expect(handler(ctx)).rejects.toThrow(/Session user is missing/);
		});

		it("translates SDK errors into INTERNAL_SERVER_ERROR", async () => {
			mockClient.listPayments.mockRejectedValue(mockApiError(500, { error: { message: "boom" } }));
			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
			});
			await expect(handler(ctx)).rejects.toThrow(/listPayments failed/);
		});
	});

	// Reference MockAPIError so it isn't flagged as unused; we instantiate
	// it implicitly when APIError is thrown via the mocked module.
	void MockAPIError;
});
