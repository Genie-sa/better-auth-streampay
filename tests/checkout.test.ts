import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockAPIError, mockedGetSessionFromCtx } = vi.hoisted(() => {
	class MockAPIError extends Error {
		public readonly code: string;
		public readonly data: { message?: string; code?: string } | undefined;
		constructor(code: string, data?: { message?: string; code?: string }) {
			super(data?.message ?? code);
			this.name = "APIError";
			this.code = code;
			this.data = data;
		}
	}
	return { MockAPIError, mockedGetSessionFromCtx: vi.fn() };
});

vi.mock("better-auth/api", () => ({
	APIError: MockAPIError,
	sessionMiddleware: vi.fn(),
	getSessionFromCtx: mockedGetSessionFromCtx,
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import { checkout } from "../src/plugins/checkout";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
import {
	createMockContext,
	createMockPaymentLink,
	createMockStreamPayClient,
	createMockUser,
	type MockedStreamPayClient,
} from "./utils/mocks";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_PRODUCT_ID = "22222222-2222-4222-8222-222222222222";

interface CheckoutResult {
	url: string;
	id: string | null;
	redirect: boolean;
}

describe("checkout plugin", () => {
	let mockClient: MockedStreamPayClient;

	beforeEach(() => {
		mockClient = createMockStreamPayClient();
		vi.clearAllMocks();

		mockClient.getPaymentUrl.mockImplementation((link) => link.url ?? null);
	});

	describe("checkout endpoint handler", () => {
		let handler: (ctx: ReturnType<typeof createMockContext>) => Promise<CheckoutResult>;

		beforeEach(() => {
			const plugin = checkout({
				products: [
					{ productId: PRODUCT_ID, slug: "pro" },
					{ productId: SECOND_PRODUCT_ID, slug: "enterprise" },
				],
			});
			handler = unwrapHandler<CheckoutResult>(
				plugin(createTestStreamPayOptions({ client: mockClient })).endpoints.checkout,
			);
			mockedGetSessionFromCtx.mockResolvedValue(null);
			mockClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		});

		it("forwards couponIds to createPaymentLink.coupons when provided", async () => {
			const couponId = "11111111-1111-4111-8111-111111111111";
			const ctx = createMockContext({
				body: { products: PRODUCT_ID, couponIds: [couponId] },
			});

			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ coupons: [couponId] }),
			);
		});

		it("resolves a product slug to its configured UUID", async () => {
			const ctx = createMockContext({ body: { slug: "pro" } });
			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({
					items: [{ product_id: PRODUCT_ID, quantity: 1, allow_custom_quantity: false }],
				}),
			);
		});

		it("rejects an unknown slug with a BAD_REQUEST APIError", async () => {
			const ctx = createMockContext({ body: { slug: "ghost" } });
			await expect(handler(ctx)).rejects.toBeInstanceOf(MockAPIError);
			await expect(handler(ctx)).rejects.toThrow(/Unknown product slug/);
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("accepts per-item quantities when products is an object array", async () => {
			const ctx = createMockContext({
				body: {
					products: [
						{ productId: PRODUCT_ID, quantity: 3 },
						{ productId: SECOND_PRODUCT_ID, quantity: 2 },
					],
				},
			});
			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({
					items: [
						{ product_id: PRODUCT_ID, quantity: 3, allow_custom_quantity: false },
						{
							product_id: SECOND_PRODUCT_ID,
							quantity: 2,
							allow_custom_quantity: false,
						},
					],
				}),
			);
		});

		it("merges referenceId into custom_metadata", async () => {
			const ctx = createMockContext({
				body: {
					products: PRODUCT_ID,
					referenceId: "org_42",
					metadata: { tier: "gold" },
				},
			});
			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({
					custom_metadata: { referenceId: "org_42", tier: "gold" },
				}),
			);
		});

		it("applies server checkout overrides through an explicit allowlist", async () => {
			const couponId = "33333333-3333-4333-8333-333333333333";
			const validUntil = "2030-01-02T03:04:05.000Z";
			const resolveCheckout = vi.fn().mockResolvedValue({
				products: [{ productId: SECOND_PRODUCT_ID, quantity: 4 }],
				name: "Server checkout",
				description: "Resolved on the server",
				successUrl: "/server-success",
				failureUrl: "/server-failure",
				maxNumberOfPayments: 1,
				validUntil,
				couponIds: [couponId],
				metadata: { source: "server", referenceId: "metadata-spoof" },
				referenceId: "server-reference",
				ignored: "must-not-leak",
			});
			const resolvedHandler = unwrapHandler<CheckoutResult>(
				checkout({ resolveCheckout })(createTestStreamPayOptions({ client: mockClient })).endpoints
					.checkout,
			);
			mockedGetSessionFromCtx.mockResolvedValue({
				user: {
					...createMockUser({ streampayConsumerId: "cons_resolved" }),
					accountId: "account-42",
				},
			});
			const ctx = createMockContext({
				body: {
					referenceId: "client-reference",
					redirect: false,
				},
				request: new Request("https://api.example.com/api/auth/checkout"),
			});

			await resolvedHandler(ctx);

			expect(resolveCheckout).toHaveBeenCalledWith(
				expect.objectContaining({
					user: expect.objectContaining({ accountId: "account-42" }),
					body: expect.objectContaining({ referenceId: "client-reference" }),
				}),
				ctx,
			);
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith({
				name: "Server checkout",
				description: "Resolved on the server",
				currency: "SAR",
				items: [
					{
						product_id: SECOND_PRODUCT_ID,
						quantity: 4,
						allow_custom_quantity: false,
					},
				],
				organization_consumer_id: "cons_resolved",
				success_redirect_url: "https://api.example.com/server-success",
				failure_redirect_url: "https://api.example.com/server-failure",
				max_number_of_payments: 1,
				valid_until: validUntil,
				coupons: [couponId],
				custom_metadata: {
					source: "server",
					referenceId: "server-reference",
				},
			});
		});

		it("makes checkout fields server-only whenever a resolver is configured", async () => {
			const resolveCheckout = vi.fn().mockReturnValue({ products: [{ productId: PRODUCT_ID }] });
			const strictHandler = unwrapHandler<CheckoutResult>(
				checkout({ resolveCheckout })(createTestStreamPayOptions({ client: mockClient })).endpoints
					.checkout,
			);
			const ctx = createMockContext({
				body: { referenceId: "order-1", products: PRODUCT_ID },
			});

			await expect(strictHandler(ctx)).rejects.toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "CHECKOUT_CLIENT_FIELDS_FORBIDDEN" },
			});
			expect(resolveCheckout).not.toHaveBeenCalled();
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("preserves APIError failures from resolveCheckout", async () => {
			const resolverError = new MockAPIError("FORBIDDEN", {
				code: "ORDER_NOT_AVAILABLE",
				message: "Order is not available.",
			});
			const resolvedHandler = unwrapHandler<CheckoutResult>(
				checkout({
					resolveCheckout: () => {
						throw resolverError;
					},
				})(createTestStreamPayOptions({ client: mockClient })).endpoints.checkout,
			);

			await expect(
				resolvedHandler(createMockContext({ body: { referenceId: "order-1" } })),
			).rejects.toBe(resolverError);
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("passes the exact provider payload to onCheckoutCreated", async () => {
			const onCheckoutCreated = vi.fn();
			const callbackHandler = unwrapHandler<CheckoutResult>(
				checkout({ onCheckoutCreated })(createTestStreamPayOptions({ client: mockClient }))
					.endpoints.checkout,
			);
			mockedGetSessionFromCtx.mockResolvedValue({
				user: {
					...createMockUser({ streampayConsumerId: "cons_callback" }),
					accountId: "account-7",
				},
			});
			const ctx = createMockContext({
				body: { products: PRODUCT_ID, referenceId: "order-7" },
			});

			await callbackHandler(ctx);

			const sentPayload = mockClient.createPaymentLink.mock.calls[0]?.[0];
			expect(onCheckoutCreated).toHaveBeenCalledWith(
				{
					user: expect.objectContaining({ accountId: "account-7" }),
					referenceId: "order-7",
					paymentLinkId: "pl_mocked",
					url: "https://pay.streampay.sa/pl_mocked",
					payload: sentPayload,
				},
				ctx,
			);
			expect(mockClient.updatePaymentLinkStatus).not.toHaveBeenCalled();
		});

		it("deactivates the link and preserves APIError callback failures", async () => {
			const callbackError = new MockAPIError("CONFLICT", {
				code: "ORDER_WRITE_CONFLICT",
				message: "Order already exists.",
			});
			const callbackHandler = unwrapHandler<CheckoutResult>(
				checkout({
					onCheckoutCreated: () => {
						throw callbackError;
					},
				})(createTestStreamPayOptions({ client: mockClient })).endpoints.checkout,
			);

			await expect(
				callbackHandler(createMockContext({ body: { products: PRODUCT_ID } })),
			).rejects.toBe(callbackError);
			expect(mockClient.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_mocked", {
				status: "INACTIVE",
			});
		});

		it("does not let compensation failures mask callback failures", async () => {
			mockClient.updatePaymentLinkStatus.mockRejectedValue(new Error("compensation unavailable"));
			const callbackHandler = unwrapHandler<CheckoutResult>(
				checkout({
					onCheckoutCreated: () => {
						throw new Error("database unavailable");
					},
				})(createTestStreamPayOptions({ client: mockClient })).endpoints.checkout,
			);
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });

			await expect(callbackHandler(ctx)).rejects.toThrow("Checkout persistence failed.");
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("checkout compensation failed"),
			);
		});

		it("supports legacy custom clients without compensation capability", async () => {
			const { updatePaymentLinkStatus: _updatePaymentLinkStatus, ...legacyClient } = mockClient;
			const callbackHandler = unwrapHandler<CheckoutResult>(
				checkout({
					onCheckoutCreated: () => {
						throw new Error("database unavailable");
					},
				})(createTestStreamPayOptions({ client: legacyClient })).endpoints.checkout,
			);
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });

			await expect(callbackHandler(ctx)).rejects.toThrow("Checkout persistence failed.");
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("checkout compensation unavailable"),
			);
		});

		it("uses the authenticated user's streampayConsumerId when present", async () => {
			mockedGetSessionFromCtx.mockResolvedValue({
				user: createMockUser({
					id: "user-linked",
					streampayConsumerId: "cons_linked_7",
				}),
			});
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });
			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ organization_consumer_id: "cons_linked_7" }),
			);
		});

		it("resolves relative successUrl against the request origin", async () => {
			const ctx = createMockContext({
				body: { products: PRODUCT_ID, successUrl: "/after-pay" },
				request: new Request("http://test.example/dashboard"),
			});
			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({
					success_redirect_url: "http://test.example/after-pay",
				}),
			);
		});

		it("ignores a client-supplied consumerId — the consumer is resolved from the session only", async () => {
			mockedGetSessionFromCtx.mockResolvedValue({
				user: createMockUser({ id: "user-owner", streampayConsumerId: "cons_mine" }),
			});
			const ctx = createMockContext({
				body: { products: PRODUCT_ID, consumerId: "cons_theirs" },
			});
			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ organization_consumer_id: "cons_mine" }),
			);
		});

		it("translates SDK errors into a readable INTERNAL_SERVER_ERROR", async () => {
			mockClient.createPaymentLink.mockRejectedValue(
				mockApiError(500, { error: { message: "downstream failure" } }),
			);
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });

			await expect(handler(ctx)).rejects.toThrow(/StreamPay checkout creation failed/);
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("[streampay] checkout creation failed"),
			);
			expect(mockClient.updatePaymentLinkStatus).not.toHaveBeenCalled();
		});

		it("does not call onCheckoutCreated when payment-link creation fails", async () => {
			const onCheckoutCreated = vi.fn();
			const callbackHandler = unwrapHandler<CheckoutResult>(
				checkout({ onCheckoutCreated })(createTestStreamPayOptions({ client: mockClient }))
					.endpoints.checkout,
			);
			mockClient.createPaymentLink.mockRejectedValue(
				mockApiError(500, { error: { message: "downstream failure" } }),
			);

			await expect(
				callbackHandler(createMockContext({ body: { products: PRODUCT_ID } })),
			).rejects.toThrow(/StreamPay checkout creation failed/);
			expect(onCheckoutCreated).not.toHaveBeenCalled();
			expect(mockClient.updatePaymentLinkStatus).not.toHaveBeenCalled();
		});

		it("fails with INTERNAL_SERVER_ERROR when StreamPay returns no URL", async () => {
			mockClient.getPaymentUrl.mockReturnValue(null);
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });
			await expect(handler(ctx)).rejects.toThrow(/no URL was returned/);
			expect(mockClient.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_mocked", {
				status: "INACTIVE",
			});
		});
	});

	describe("authenticatedUsersOnly gate", () => {
		let handler: (ctx: ReturnType<typeof createMockContext>) => Promise<CheckoutResult>;

		beforeEach(() => {
			const plugin = checkout({ authenticatedUsersOnly: true });
			handler = unwrapHandler<CheckoutResult>(
				plugin(createTestStreamPayOptions({ client: mockClient })).endpoints.checkout,
			);
			mockClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		});

		it("rejects unauthenticated callers with UNAUTHORIZED", async () => {
			mockedGetSessionFromCtx.mockResolvedValue(null);
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });
			await expect(handler(ctx)).rejects.toThrow(/must be logged in/);
		});

		it("rejects anonymous sessions", async () => {
			mockedGetSessionFromCtx.mockResolvedValue({
				user: { ...createMockUser(), isAnonymous: true },
			});
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });
			await expect(handler(ctx)).rejects.toThrow(/Anonymous/);
		});
	});
});
