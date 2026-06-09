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
