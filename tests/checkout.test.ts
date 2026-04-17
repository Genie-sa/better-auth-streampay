import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockAPIError, mockedGetSessionFromCtx } = vi.hoisted(() => {
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

const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";
const SECOND_PRODUCT_ID = "22222222-2222-2222-2222-222222222222";

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
		// Default stub: `getPaymentUrl` reads the `url` field off whatever
		// payment link the test programs, matching the real SDK.
		mockClient.getPaymentUrl.mockImplementation((link) => link.url ?? null);
	});

	describe("plugin creation", () => {
		it("registers the checkout endpoint at POST /checkout", () => {
			const plugin = checkout();
			const endpoints = plugin(createTestStreamPayOptions({ client: mockClient }));

			expect(endpoints).toHaveProperty("checkout");
		});

		it("accepts optional products, success/failure URLs, and auth gate", () => {
			const plugin = checkout({
				products: [{ productId: PRODUCT_ID, slug: "pro" }],
				successUrl: "/success",
				failureUrl: "/failure",
				authenticatedUsersOnly: true,
			});
			const endpoints = plugin(createTestStreamPayOptions({ client: mockClient }));
			expect(endpoints).toHaveProperty("checkout");
		});
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
			handler = unwrapHandler<CheckoutResult>(plugin(createTestStreamPayOptions({ client: mockClient })).checkout);
			mockedGetSessionFromCtx.mockResolvedValue(null);
			mockClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		});

		it("creates a payment link from a single product UUID", async () => {
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });

			const result = await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({
					items: [{ product_id: PRODUCT_ID, quantity: 1, allow_custom_quantity: false }],
				}),
			);
			expect(result).toEqual(
				expect.objectContaining({
					url: "https://pay.streampay.sa/pl_mocked",
					redirect: true,
				}),
			);
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

		it("omits coupons from payload when couponIds is empty or missing", async () => {
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });
			await handler(ctx);
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.not.objectContaining({ coupons: expect.anything() }),
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

		it("accepts an array of product UUIDs", async () => {
			const ctx = createMockContext({
				body: { products: [PRODUCT_ID, SECOND_PRODUCT_ID] },
			});
			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({
					items: [
						{ product_id: PRODUCT_ID, quantity: 1, allow_custom_quantity: false },
						{
							product_id: SECOND_PRODUCT_ID,
							quantity: 1,
							allow_custom_quantity: false,
						},
					],
				}),
			);
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

		it("rejects empty products arrays", async () => {
			const ctx = createMockContext({ body: { products: [] } });
			await expect(handler(ctx)).rejects.toThrow(/at least one item/);
		});

		it("rejects calls with neither slug nor products", async () => {
			const ctx = createMockContext({ body: {} });
			await expect(handler(ctx)).rejects.toThrow(/slug.*products/);
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

		it("passes body.consumerId through verbatim when provided", async () => {
			const ctx = createMockContext({
				body: {
					products: PRODUCT_ID,
					consumerId: "cons_explicit_override",
				},
			});
			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({
					organization_consumer_id: "cons_explicit_override",
				}),
			);
		});

		it("translates SDK errors into a readable INTERNAL_SERVER_ERROR", async () => {
			mockClient.createPaymentLink.mockRejectedValue(
				mockApiError(500, { error: { message: "downstream failure" } }),
			);
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });

			await expect(handler(ctx)).rejects.toThrow(/StreamPay checkout creation failed/);
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("StreamPay checkout creation failed"),
			);
		});

		it("fails with INTERNAL_SERVER_ERROR when StreamPay returns no URL", async () => {
			mockClient.getPaymentUrl.mockReturnValue(null);
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });
			await expect(handler(ctx)).rejects.toThrow(/no URL was returned/);
		});
	});

	describe("authenticatedUsersOnly gate", () => {
		let handler: (ctx: ReturnType<typeof createMockContext>) => Promise<CheckoutResult>;

		beforeEach(() => {
			const plugin = checkout({ authenticatedUsersOnly: true });
			handler = unwrapHandler<CheckoutResult>(plugin(createTestStreamPayOptions({ client: mockClient })).checkout);
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

		it("admits a normal authenticated caller", async () => {
			mockedGetSessionFromCtx.mockResolvedValue({ user: createMockUser() });
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });
			await expect(handler(ctx)).resolves.toBeDefined();
		});
	});
});
