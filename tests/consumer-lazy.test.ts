import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockAPIError } = vi.hoisted(() => {
	class MockAPIError extends Error {
		public readonly code: string;
		public readonly data: { message?: string; code?: string } | undefined;
		public readonly errorCode: string | undefined;
		constructor(code: string, data?: { message?: string; code?: string }) {
			super(data?.message ?? code);
			this.name = "APIError";
			this.code = code;
			this.data = data;
			this.errorCode = data?.code;
		}
	}
	return { MockAPIError };
});

vi.mock("better-auth/api", () => ({
	APIError: MockAPIError,
	sessionMiddleware: vi.fn(),
	getSessionFromCtx: vi.fn(),
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import { onBeforeUserCreate } from "../src/hooks/consumer";
import { ensureConsumerForUser } from "../src/utils/ensure-consumer";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
import { invokeHook } from "./utils/invoke-hook";
import {
	createMockConsumer,
	createMockConsumerList,
	createMockContext,
	createMockStreamPayClient,
	createMockUser,
	type MockedStreamPayClient,
} from "./utils/mocks";

describe("lazy consumer provisioning (createConsumerOnSignUp: false)", () => {
	let mockClient: MockedStreamPayClient;

	beforeEach(() => {
		mockClient = createMockStreamPayClient();
		mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
		mockClient.getPaymentUrl.mockImplementation((link) => link.url ?? null);
		vi.clearAllMocks();
	});

	describe("default behavior: no eager signup create", () => {
		it("onBeforeUserCreate is a no-op unless createConsumerOnSignUp is enabled", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
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
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([createMockConsumer({ id: "cons_prior", external_id: "user-1" })]),
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

		it("rejects a recovered consumer linked to another local user", async () => {
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([createMockConsumer({ id: "cons_prior", external_id: "user-1" })]),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();
			vi.mocked(ctx.context.adapter.findOne).mockResolvedValue({ id: "user-other" });

			await expect(
				ensureConsumerForUser(options, ctx, { id: "user-1", email: "a@b.com" }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "STREAMPAY_CONSUMER_LINK_CONFLICT",
			});
			expect(ctx.context.internalAdapter.updateUser).not.toHaveBeenCalled();
			expect(mockClient.createConsumer).not.toHaveBeenCalled();
		});

		it("allows an idempotent recovered link owned by the same local user", async () => {
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([createMockConsumer({ id: "cons_prior", external_id: "user-1" })]),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();
			vi.mocked(ctx.context.adapter.findOne).mockResolvedValue({ id: "user-1" });

			await expect(
				ensureConsumerForUser(options, ctx, { id: "user-1", email: "a@b.com" }),
			).resolves.toEqual({ consumerId: "cons_prior", created: false });
			expect(ctx.context.internalAdapter.updateUser).toHaveBeenCalled();
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

		it("checks local ownership before reassigning a duplicate consumer", async () => {
			mockClient.createConsumer.mockRejectedValue(
				mockApiError(409, { error: { code: "DUPLICATE_CONSUMER" } }),
			);
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([
					createMockConsumer({ id: "cons_stranded", email: "a@b.com", external_id: "" }),
				]),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();
			vi.mocked(ctx.context.adapter.findOne).mockResolvedValue({ id: "user-other" });

			await expect(
				ensureConsumerForUser(options, ctx, { id: "user-1", email: "a@b.com" }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "STREAMPAY_CONSUMER_LINK_CONFLICT",
			});
			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
			expect(ctx.context.internalAdapter.updateUser).not.toHaveBeenCalled();
		});

		it("fails closed when duplicate-consumer external_id backfill fails", async () => {
			mockClient.createConsumer.mockRejectedValue(
				mockApiError(409, { error: { code: "DUPLICATE_CONSUMER" } }),
			);
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([
					createMockConsumer({ id: "cons_stranded", email: "a@b.com", external_id: "" }),
				]),
			);
			mockClient.updateConsumer.mockRejectedValue(new Error("provider write failed"));
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();

			await expect(
				ensureConsumerForUser(options, ctx, { id: "user-1", email: "a@b.com" }),
			).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				errorCode: "STREAMPAY_CONSUMER_LINK_WRITE_FAILED",
			});
			expect(ctx.context.internalAdapter.updateUser).not.toHaveBeenCalled();
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

		it("carries the CONSUMER_DUPLICATE_LINKED structured code on the duplicate-linked rejection", async () => {
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
				ensureConsumerForUser(options, ctx, { id: "user-1", email: "a@b.com" }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "CONSUMER_DUPLICATE_LINKED",
			});
		});

		it("fails closed when writing streampayConsumerId to the user row fails", async () => {
			mockClient.createConsumer.mockResolvedValue(createMockConsumer({ id: "cons_created" }));
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();
			ctx.context.internalAdapter.updateUser.mockRejectedValue(new Error("db down"));

			await expect(
				ensureConsumerForUser(options, ctx, {
					id: "user-1",
					email: "a@b.com",
				}),
			).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				errorCode: "STREAMPAY_CONSUMER_LINK_WRITE_FAILED",
			});
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("link write failed"),
			);
		});

		it("reports a concurrent unique-write loss as an ownership conflict", async () => {
			mockClient.createConsumer.mockResolvedValue(createMockConsumer({ id: "cons_created" }));
			const options = createTestStreamPayOptions({ client: mockClient });
			const ctx = createMockContext();
			ctx.context.internalAdapter.updateUser.mockRejectedValue(new Error("unique constraint"));
			vi.mocked(ctx.context.adapter.findOne)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({ id: "user-other" });

			await expect(
				ensureConsumerForUser(options, ctx, { id: "user-1", email: "a@b.com" }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "STREAMPAY_CONSUMER_LINK_CONFLICT",
			});
		});
	});

	describe("checkout lazy path", () => {
		it("race safety: concurrent ensure calls converge on the same consumer via DUPLICATE_CONSUMER resolution", async () => {
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
			expect(createCalls).toBe(2);
		});
	});

	void MockAPIError;
});
