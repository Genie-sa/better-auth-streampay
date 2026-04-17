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

import { onBeforeUserCreate } from "../src/hooks/consumer";
import { checkout } from "../src/plugins/checkout";
import { ensureConsumerForUser } from "../src/utils/ensure-consumer";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
import { invokeHook } from "./utils/invoke-hook";
import {
	createMockConsumer,
	createMockConsumerList,
	createMockContext,
	createMockPaymentLink,
	createMockStreamPayClient,
	createMockUser,
	type MockedStreamPayClient,
} from "./utils/mocks";

const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";

describe("lazy consumer provisioning (createConsumerOnSignUp: false)", () => {
	let mockClient: MockedStreamPayClient;

	beforeEach(() => {
		mockClient = createMockStreamPayClient();
		mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
		mockClient.getPaymentUrl.mockImplementation((link) => link.url ?? null);
		vi.clearAllMocks();
	});

	describe("default behavior: no eager signup create", () => {
		it("onBeforeUserCreate is a no-op when createConsumerOnSignUp is unset", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			const user = createMockUser({ email: "lazy@example.com" });
			const ctx = createMockContext({ user });

			const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

			expect(result).toBeUndefined();
			expect(mockClient.createConsumer).not.toHaveBeenCalled();
		});

		it("onBeforeUserCreate is a no-op when createConsumerOnSignUp is false", async () => {
			const options = createTestStreamPayOptions({
				client: mockClient,
				createConsumerOnSignUp: false,
			});
			const user = createMockUser({ email: "lazy@example.com" });
			const ctx = createMockContext({ user });

			const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

			expect(result).toBeUndefined();
			expect(mockClient.createConsumer).not.toHaveBeenCalled();
		});
	});

	describe("ensureConsumerForUser", () => {
		it("short-circuits when the user already has a streampayConsumerId", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();

			const result = await ensureConsumerForUser(options, ctx, {
				id: "user-1",
				email: "a@b.com",
				streampayConsumerId: "cons_existing",
			});

			expect(result).toEqual({ consumerId: "cons_existing", created: false });
			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			expect(mockClient.listConsumers).not.toHaveBeenCalled();
		});

		it("recovers an existing consumer by external_id without creating a new one", async () => {
			// Covers the "consumer was created previously but updateUser failed" case.
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([
					createMockConsumer({ id: "cons_prior", external_id: "user-1" }),
				]),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();

			const result = await ensureConsumerForUser(options, ctx, {
				id: "user-1",
				email: "a@b.com",
			});

			expect(result).toEqual({ consumerId: "cons_prior", created: false });
			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			expect(ctx.context.internalAdapter.updateUser).toHaveBeenCalledWith(
				"user-1",
				expect.objectContaining({ streampayConsumerId: "cons_prior" }),
			);
		});

		it("creates a consumer with external_id and persists the id on the user row", async () => {
			mockClient.createConsumer.mockResolvedValue(
				createMockConsumer({ id: "cons_new", external_id: "user-1" }),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();

			const result = await ensureConsumerForUser(options, ctx, {
				id: "user-1",
				email: "a@b.com",
				name: "Alpha",
			});

			expect(result).toEqual({ consumerId: "cons_new", created: true });
			expect(mockClient.createConsumer).toHaveBeenCalledWith(
				expect.objectContaining({
					email: "a@b.com",
					external_id: "user-1",
				}),
			);
			expect(ctx.context.internalAdapter.updateUser).toHaveBeenCalledWith(
				"user-1",
				expect.objectContaining({ streampayConsumerId: "cons_new" }),
			);
		});

		it("handles DUPLICATE_CONSUMER via resolve-and-reuse when the existing consumer is stranded", async () => {
			mockClient.createConsumer.mockRejectedValue(
				mockApiError(
					409,
					{ error: { code: "DUPLICATE_CONSUMER", message: "dup" } },
					"POST",
					"/api/v2/consumers",
				),
			);
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([
					// stranded consumer — no external_id → safe to reuse
					createMockConsumer({ id: "cons_stranded", email: "a@b.com", external_id: "" }),
				]),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();

			const result = await ensureConsumerForUser(options, ctx, {
				id: "user-1",
				email: "a@b.com",
			});

			expect(result).toEqual({ consumerId: "cons_stranded", created: false });
			expect(ctx.context.internalAdapter.updateUser).toHaveBeenCalled();
		});

		it("handles DUPLICATE_CONSUMER when the existing consumer is already linked to the same user (idempotent)", async () => {
			mockClient.createConsumer.mockRejectedValue(
				mockApiError(409, { error: { code: "DUPLICATE_CONSUMER" } }, "POST", "/api/v2/consumers"),
			);
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([
					createMockConsumer({
						id: "cons_already",
						email: "a@b.com",
						external_id: "user-1",
					}),
				]),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();

			const result = await ensureConsumerForUser(options, ctx, {
				id: "user-1",
				email: "a@b.com",
			});

			expect(result).toEqual({ consumerId: "cons_already", created: false });
		});

		it("refuses DUPLICATE_CONSUMER when the matching consumer is linked to a DIFFERENT user", async () => {
			mockClient.createConsumer.mockRejectedValue(
				mockApiError(409, { error: { code: "DUPLICATE_CONSUMER" } }, "POST", "/api/v2/consumers"),
			);
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([
					createMockConsumer({
						id: "cons_other",
						email: "a@b.com",
						external_id: "user-different",
					}),
				]),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();

			await expect(
				ensureConsumerForUser(options, ctx, {
					id: "user-1",
					email: "a@b.com",
				}),
			).rejects.toThrow(/cannot be created at this time/);
		});

		it("logs but does not throw when writing streampayConsumerId back to the user row fails", async () => {
			mockClient.createConsumer.mockResolvedValue(
				createMockConsumer({ id: "cons_created" }),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();
			ctx.context.internalAdapter.updateUser.mockRejectedValue(new Error("db down"));

			const result = await ensureConsumerForUser(options, ctx, {
				id: "user-1",
				email: "a@b.com",
			});

			expect(result).toEqual({ consumerId: "cons_created", created: true });
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("link write failed"),
			);
		});
	});

	describe("checkout lazy path", () => {
		it("lazy-creates a consumer for an authenticated user on first checkout", async () => {
			mockClient.createConsumer.mockResolvedValue(
				createMockConsumer({ id: "cons_lazy", external_id: "user-checkout" }),
			);
			mockClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());

			const user = createMockUser({ id: "user-checkout", streampayConsumerId: null });
			mockedGetSessionFromCtx.mockResolvedValue({ user });

			const options = createTestStreamPayOptions({ client: mockClient });
			const handler = unwrapHandler(checkout()(options).checkout);
			const ctx = createMockContext({ user, body: { products: PRODUCT_ID } });

			await handler(ctx);

			expect(mockClient.createConsumer).toHaveBeenCalledTimes(1);
			expect(ctx.context.internalAdapter.updateUser).toHaveBeenCalledWith(
				"user-checkout",
				expect.objectContaining({ streampayConsumerId: "cons_lazy" }),
			);
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ organization_consumer_id: "cons_lazy" }),
			);
		});

		it("reuses the existing streampayConsumerId on subsequent checkouts without calling createConsumer", async () => {
			mockClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());

			const user = createMockUser({
				id: "user-repeat",
				streampayConsumerId: "cons_existing",
			});
			mockedGetSessionFromCtx.mockResolvedValue({ user });

			const options = createTestStreamPayOptions({ client: mockClient });
			const handler = unwrapHandler(checkout()(options).checkout);
			const ctx = createMockContext({ user, body: { products: PRODUCT_ID } });

			await handler(ctx);

			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ organization_consumer_id: "cons_existing" }),
			);
		});

		it("anonymous sessions skip lazy-create and fall through to SDK smart-match", async () => {
			mockClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());

			const user = { ...createMockUser({ streampayConsumerId: null }), isAnonymous: true };
			mockedGetSessionFromCtx.mockResolvedValue({ user });

			const options = createTestStreamPayOptions({ client: mockClient });
			const handler = unwrapHandler(checkout()(options).checkout);
			const ctx = createMockContext({ body: { products: PRODUCT_ID } });

			await handler(ctx);

			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			// No organization_consumer_id set — guest checkout
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.not.objectContaining({ organization_consumer_id: expect.anything() }),
			);
		});

		it("race safety: concurrent ensure calls converge on the same consumer via DUPLICATE_CONSUMER resolution", async () => {
			// Simulate the race: both callers arrive before either has
			// written streampayConsumerId back. listConsumers is empty
			// until the winner creates — after that, a scan sees the
			// winner's consumer and the loser's resolve path reuses it.
			const winner = createMockConsumer({ id: "cons_winner", external_id: "user-race" });
			let consumerExists = false;
			mockClient.listConsumers.mockImplementation(async () => {
				return createMockConsumerList(consumerExists ? [winner] : []);
			});
			let createCalls = 0;
			mockClient.createConsumer.mockImplementation(async () => {
				createCalls++;
				if (createCalls === 1) {
					consumerExists = true;
					return winner;
				}
				throw mockApiError(
					409,
					{ error: { code: "DUPLICATE_CONSUMER" } },
					"POST",
					"/api/v2/consumers",
				);
			});

			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();
			const user = { id: "user-race", email: "race@example.com" };

			const [a, b] = await Promise.all([
				ensureConsumerForUser(options, ctx, user),
				ensureConsumerForUser(options, ctx, user),
			]);

			expect(a.consumerId).toBe("cons_winner");
			expect(b.consumerId).toBe("cons_winner");
			expect(createCalls).toBe(2); // both tried create; loser got DUPLICATE_CONSUMER
		});
	});

	// Keep MockAPIError referenced so the vi.mock replacement is not GC'd.
	void MockAPIError;
});
