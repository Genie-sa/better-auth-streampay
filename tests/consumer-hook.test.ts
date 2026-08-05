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
	getSessionFromCtx: vi.fn(),
	createAuthEndpoint: Object.assign(
		vi.fn((path: string, config: unknown, handler: unknown) => ({
			path,
			config,
			handler,
		})),
		{
			serverOnly: vi.fn((config: unknown, handler: unknown) => ({
				config,
				handler,
			})),
		},
	),
}));

import {
	onAfterUserCreate,
	onBeforeUserCreate,
	onUserDelete,
	onUserUpdate,
} from "../src/hooks/consumer";
import { createEagerTestStreamPayOptions, mockApiError } from "./utils/helpers";
import { invokeHook } from "./utils/invoke-hook";
import {
	createMockConsumer,
	createMockConsumerList,
	createMockContext,
	createMockStreamPayClient,
	createMockUser,
} from "./utils/mocks";

describe("consumer hooks", () => {
	let mockClient: ReturnType<typeof createMockStreamPayClient>;

	beforeEach(() => {
		mockClient = createMockStreamPayClient();

		mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
	});

	describe("onBeforeUserCreate", () => {
		it("creates a StreamPay consumer WITHOUT external_id and injects its id into the row", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.createConsumer.mockResolvedValue(createMockConsumer({ id: "cons_fresh" }));

			const user = createMockUser({
				email: "fresh@example.com",
				name: "Fresh User",
			});
			const ctx = createMockContext({ user });

			const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

			expect(mockClient.createConsumer).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "Fresh User",
					email: "fresh@example.com",
				}),
			);
			expect(mockClient.createConsumer).toHaveBeenCalledWith(
				expect.not.objectContaining({ external_id: expect.anything() }),
			);

			expect(result).toEqual({ data: { streampayConsumerId: "cons_fresh" } });
		});

		it("uses user.email as the consumer name when user.name is empty", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.createConsumer.mockResolvedValue(createMockConsumer());

			const user = createMockUser({ name: "", email: "only@example.com" });
			const ctx = createMockContext({ user });

			await invokeHook(onBeforeUserCreate(options), user, ctx);

			expect(mockClient.createConsumer).toHaveBeenCalledWith(
				expect.objectContaining({ name: "only@example.com" }),
			);
		});

		it("applies overrides from getConsumerCreateParams", async () => {
			const getConsumerCreateParams = vi.fn().mockResolvedValue({
				phone_number: "+966500000000",
				preferred_language: "ar",
			});
			const options = createEagerTestStreamPayOptions({
				client: mockClient,
				getConsumerCreateParams,
			});
			mockClient.createConsumer.mockResolvedValue(createMockConsumer());

			const user = createMockUser();
			const ctx = createMockContext({ user });

			await invokeHook(onBeforeUserCreate(options), user, ctx);

			expect(getConsumerCreateParams).toHaveBeenCalledWith({ user });
			expect(mockClient.createConsumer).toHaveBeenCalledWith(
				expect.objectContaining({
					phone_number: "+966500000000",
					preferred_language: "ar",
				}),
			);
		});

		it("throws APIError when email is missing (StreamPay requires email)", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			const user = createMockUser({ email: "" });
			const ctx = createMockContext({ user });

			await expect(invokeHook(onBeforeUserCreate(options), user, ctx)).rejects.toBeInstanceOf(
				MockAPIError,
			);
			expect(mockClient.createConsumer).not.toHaveBeenCalled();
		});

		it("throws generic message and logs detail when StreamPay rejects createConsumer — orphan-row fix", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.createConsumer.mockRejectedValue(
				mockApiError(403, {
					error: {
						code: "STREAM_ERROR",
						additional_info:
							"Organization is in sandbox mode and the customer email must match the organization user's email.",
					},
				}),
			);

			const user = createMockUser();
			const ctx = createMockContext({ user });

			await expect(invokeHook(onBeforeUserCreate(options), user, ctx)).rejects.toThrow(
				/provisioning failed/,
			);
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("sandbox mode"),
			);
		});

		describe("DUPLICATE_CONSUMER reuse path", () => {
			const duplicateError = mockApiError(400, {
				error: {
					code: "DUPLICATE_CONSUMER",
					message: "Consumer already exist",
					additional_info: "Consumer with email 'test@example.com' already exists in the system",
				},
			});

			it("reuses a STRANDED consumer (no external_id) on DUPLICATE_CONSUMER", async () => {
				const options = createEagerTestStreamPayOptions({ client: mockClient });
				mockClient.createConsumer.mockRejectedValue(duplicateError);

				mockClient.listConsumers.mockResolvedValue(
					createMockConsumerList([
						createMockConsumer({
							id: "cons_stranded",
							email: "test@example.com",
							external_id: null,
						}),
					]),
				);

				const user = createMockUser();
				const ctx = createMockContext({ user });

				const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

				expect(result).toEqual({
					data: { streampayConsumerId: "cons_stranded" },
				});
				expect(mockClient.listConsumers).toHaveBeenCalled();
			});

			it("REFUSES to reuse a consumer that is already linked to another user", async () => {
				const options = createEagerTestStreamPayOptions({ client: mockClient });
				mockClient.createConsumer.mockRejectedValue(duplicateError);

				mockClient.listConsumers.mockResolvedValue(
					createMockConsumerList([
						createMockConsumer({
							id: "cons_linked",
							email: "test@example.com",
							external_id: "some-other-user-id",
						}),
					]),
				);

				const user = createMockUser();
				const ctx = createMockContext({ user });

				await expect(invokeHook(onBeforeUserCreate(options), user, ctx)).rejects.toBeInstanceOf(
					MockAPIError,
				);

				expect(ctx.context.logger.error).toHaveBeenCalledWith(
					expect.stringContaining("already linked to external_id"),
				);
			});

			it('reclaims an already-linked SAME-EMAIL consumer when claimExistingConsumerBy is ["email"]', async () => {
				const options = createEagerTestStreamPayOptions({
					client: mockClient,
					claimExistingConsumerBy: ["email"],
				});
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				mockClient.listConsumers.mockResolvedValue(
					createMockConsumerList([
						createMockConsumer({
							id: "cons_claimed",
							email: "test@example.com",
							external_id: "old-user-id",
						}),
					]),
				);

				const user = createMockUser();
				const ctx = createMockContext({ user });

				const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

				expect(result).toEqual({
					data: { streampayConsumerId: "cons_claimed" },
				});
			});

			it('reclaims an already-linked SAME-PHONE consumer when claimExistingConsumerBy is ["phone"]', async () => {
				const options = createEagerTestStreamPayOptions({
					client: mockClient,
					claimExistingConsumerBy: ["phone"],
					getConsumerCreateParams: async () => ({
						phone_number: "+966500000000",
					}),
				});
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				mockClient.listConsumers.mockResolvedValue(
					createMockConsumerList([
						createMockConsumer({
							id: "cons_phone_claimed",
							email: "other@example.com",
							phone_number: "+966500000000",
							external_id: "old-user-id",
						}),
					]),
				);

				const user = createMockUser();
				const ctx = createMockContext({ user });

				const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

				expect(result).toEqual({
					data: { streampayConsumerId: "cons_phone_claimed" },
				});
			});

			it("falls through to a generic error when the scan cannot find the duplicate (detail logged server-side)", async () => {
				const options = createEagerTestStreamPayOptions({ client: mockClient });
				mockClient.createConsumer.mockRejectedValue(duplicateError);

				mockClient.listConsumers.mockResolvedValue(createMockConsumerList());

				const user = createMockUser();
				const ctx = createMockContext({ user });

				await expect(invokeHook(onBeforeUserCreate(options), user, ctx)).rejects.toThrow(
					/provisioning failed/,
				);
				expect(ctx.context.logger.error).toHaveBeenCalledWith(
					expect.stringContaining("Consumer with email"),
				);
			});

			it("matches on phone_number, not just email", async () => {
				const options = createEagerTestStreamPayOptions({
					client: mockClient,
					getConsumerCreateParams: async () => ({
						phone_number: "+966500000000",
					}),
				});
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				mockClient.listConsumers.mockResolvedValue(
					createMockConsumerList([
						createMockConsumer({
							id: "cons_phone_match",
							email: "different@example.com",
							phone_number: "+966500000000",
							external_id: null,
						}),
					]),
				);

				const user = createMockUser();
				const ctx = createMockContext({ user });

				const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

				expect(result).toEqual({
					data: { streampayConsumerId: "cons_phone_match" },
				});
			});
		});

		it("is a no-op when createConsumerOnSignUp is false", async () => {
			const options = createEagerTestStreamPayOptions({
				client: mockClient,
				createConsumerOnSignUp: false,
			});
			const user = createMockUser();
			const ctx = createMockContext({ user });

			const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			expect(result).toBeUndefined();
		});

		it("is a no-op for anonymous users", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			const user = { ...createMockUser({ email: "" }), isAnonymous: true };
			const ctx = createMockContext({ user });

			const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			expect(result).toBeUndefined();
		});
	});

	describe("onAfterUserCreate", () => {
		it("back-links the consumer by patching external_id onto it", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.updateConsumer.mockResolvedValue(createMockConsumer());

			const user = createMockUser({
				id: "user-fresh",
				streampayConsumerId: "cons_fresh",
			});
			const ctx = createMockContext({ user });

			await invokeHook(onAfterUserCreate(options), user, ctx);

			expect(mockClient.updateConsumer).toHaveBeenCalledWith("cons_fresh", {
				external_id: "user-fresh",
			});
		});

		it("logs but does NOT throw when the back-link update fails", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.updateConsumer.mockRejectedValue(
				mockApiError(500, { error: { message: "streampay down" } }),
			);

			const user = createMockUser({
				streampayConsumerId: "cons_fresh",
			});
			const ctx = createMockContext({ user });

			await expect(invokeHook(onAfterUserCreate(options), user, ctx)).resolves.toBeUndefined();

			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("[streampay] consumer external_id link failed"),
			);
		});

		it("is a no-op when streampayConsumerId is missing (before-hook was a no-op)", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			const user = createMockUser({ streampayConsumerId: null });
			const ctx = createMockContext({ user });

			await invokeHook(onAfterUserCreate(options), user, ctx);

			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
		});
	});

	describe("onUserUpdate", () => {
		it("syncs BOTH name and email when both differ from the remote consumer", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.getConsumer.mockResolvedValue(
				createMockConsumer({
					id: "cons_linked",
					name: "Old Name",
					email: "old@example.com",
				}),
			);
			mockClient.updateConsumer.mockResolvedValue(createMockConsumer());

			const user = createMockUser({
				name: "Renamed",
				email: "renamed@example.com",
				streampayConsumerId: "cons_linked",
			});
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.getConsumer).toHaveBeenCalledWith("cons_linked");
			expect(mockClient.updateConsumer).toHaveBeenCalledWith("cons_linked", {
				name: "Renamed",
				email: "renamed@example.com",
			});
		});

		it("skips updateConsumer entirely when remote matches local (no-op update)", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.getConsumer.mockResolvedValue(
				createMockConsumer({
					id: "cons_linked",
					name: "Same Name",
					email: "same@example.com",
				}),
			);

			const user = createMockUser({
				name: "Same Name",
				email: "same@example.com",
				streampayConsumerId: "cons_linked",
			});
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.getConsumer).toHaveBeenCalledWith("cons_linked");
			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
		});

		it("short-circuits without calling getConsumer when streampayConsumerId is not stored", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			const user = createMockUser({ streampayConsumerId: null });
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.getConsumer).not.toHaveBeenCalled();
			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
			expect(mockClient.listConsumers).not.toHaveBeenCalled();
		});

		it("skips the PATCH when the remote consumer is soft-deleted (does not clear the link)", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.getConsumer.mockResolvedValue(
				createMockConsumer({
					id: "cons_linked",
					name: "Old Name",
					email: "old@example.com",
					is_deleted: true,
				}),
			);

			const user = createMockUser({
				name: "New Name",
				email: "new@example.com",
				streampayConsumerId: "cons_linked",
			});
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
			expect(ctx.context.internalAdapter.updateUser).not.toHaveBeenCalled();
		});

		it("self-heals on getConsumer 404 by clearing streampayConsumerId for re-provisioning", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.getConsumer.mockRejectedValue(
				mockApiError(404, { error: { message: "not found" } }),
			);

			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });

			await expect(invokeHook(onUserUpdate(options), user, ctx)).resolves.toBeUndefined();
			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("clearing stale link"),
			);
			expect(ctx.context.internalAdapter.updateUser).toHaveBeenCalledWith(
				"user-123",
				expect.objectContaining({ streampayConsumerId: null }),
			);
		});

		it("logs but never throws when getConsumer fails with a non-404 error", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.getConsumer.mockRejectedValue(
				mockApiError(503, { error: { message: "unavailable" } }),
			);

			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });

			await expect(invokeHook(onUserUpdate(options), user, ctx)).resolves.toBeUndefined();
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("[streampay] consumer update failed"),
			);
			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
			expect(ctx.context.internalAdapter.updateUser).not.toHaveBeenCalled();
		});

		it("syncs lazy-linked consumers even when createConsumerOnSignUp is false", async () => {
			const options = createEagerTestStreamPayOptions({
				client: mockClient,
				createConsumerOnSignUp: false,
			});
			mockClient.getConsumer.mockResolvedValue(
				createMockConsumer({
					id: "cons_lazy_linked",
					name: "Stale Name",
					email: "stale@example.com",
				}),
			);
			mockClient.updateConsumer.mockResolvedValue(createMockConsumer());
			const user = createMockUser({
				name: "Lazy User",
				email: "lazy@example.com",
				streampayConsumerId: "cons_lazy_linked",
			});
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.updateConsumer).toHaveBeenCalledWith("cons_lazy_linked", {
				name: "Lazy User",
				email: "lazy@example.com",
			});
		});

		it("is a no-op for anonymous users (no getConsumer either)", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			const user = {
				...createMockUser({ streampayConsumerId: "cons_linked" }),
				isAnonymous: true,
			};
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.getConsumer).not.toHaveBeenCalled();
			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
		});
	});

	describe("onUserDelete", () => {
		it("deletes the linked StreamPay consumer", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.deleteConsumer.mockResolvedValue(undefined);

			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });
			await invokeHook(onUserDelete(options), user, ctx);

			expect(mockClient.deleteConsumer).toHaveBeenCalledWith("cons_linked");
		});

		it("logs but never throws when StreamPay delete fails with a non-404 error", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.deleteConsumer.mockRejectedValue(
				mockApiError(500, { error: { message: "internal error" } }),
			);

			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });

			await expect(invokeHook(onUserDelete(options), user, ctx)).resolves.toBeUndefined();
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("[streampay] consumer delete failed"),
			);
		});

		it("treats a 404 on delete as success (the consumer is already gone)", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			mockClient.deleteConsumer.mockRejectedValue(
				mockApiError(404, { error: { message: "consumer not found" } }),
			);

			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });

			await expect(invokeHook(onUserDelete(options), user, ctx)).resolves.toBeUndefined();
			expect(ctx.context.logger.error).not.toHaveBeenCalled();
		});

		it("is a no-op when no consumer is linked (skips cheaply, no list-scan)", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });

			const user = createMockUser({ streampayConsumerId: null });
			const ctx = createMockContext({ user });
			await invokeHook(onUserDelete(options), user, ctx);

			expect(mockClient.listConsumers).not.toHaveBeenCalled();
			expect(mockClient.deleteConsumer).not.toHaveBeenCalled();
		});

		it("is a no-op for anonymous users", async () => {
			const options = createEagerTestStreamPayOptions({ client: mockClient });
			const user = {
				...createMockUser({ streampayConsumerId: "cons_linked" }),
				isAnonymous: true,
			};
			const ctx = createMockContext({ user });
			await invokeHook(onUserDelete(options), user, ctx);

			expect(mockClient.deleteConsumer).not.toHaveBeenCalled();
		});
	});
});
