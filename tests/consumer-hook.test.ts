import { beforeEach, describe, expect, it, vi } from "vitest";

// Install the better-auth/api mock at hoist time. vi.hoisted runs
// above every import so APIError can be defined and referenced by
// vi.mock's factory without TDZ issues.
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
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import {
	onAfterUserCreate,
	onBeforeUserCreate,
	onUserDelete,
	onUserUpdate,
} from "../src/hooks/consumer";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
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
		// Default: empty consumer list so the fallback scan terminates fast
		// and `createConsumer` is the path most tests want to exercise.
		mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
	});

	describe("onBeforeUserCreate", () => {
		it("creates a StreamPay consumer WITHOUT external_id and injects its id into the row", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			mockClient.createConsumer.mockResolvedValue(createMockConsumer({ id: "cons_fresh" }));

			const user = createMockUser({
				email: "fresh@example.com",
				name: "Fresh User",
			});
			const ctx = createMockContext({ user });

			const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

			// The consumer is created without external_id at this stage,
			// because Better Auth generates user.id inside adapter.create()
			// after this hook runs. The link step happens in onAfterUserCreate.
			expect(mockClient.createConsumer).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "Fresh User",
					email: "fresh@example.com",
				}),
			);
			expect(mockClient.createConsumer).toHaveBeenCalledWith(
				expect.not.objectContaining({ external_id: expect.anything() }),
			);
			// Return value shape: Better Auth's hook contract merges `.data`
			// into the insert payload — this is how `streampayConsumerId`
			// lands on the row atomically with the user insert.
			expect(result).toEqual({ data: { streampayConsumerId: "cons_fresh" } });
		});

		it("uses user.email as the consumer name when user.name is empty", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
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
			const options = createTestStreamPayOptions({
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
			const options = createTestStreamPayOptions({ client: mockClient });
			const user = createMockUser({ email: "" });
			const ctx = createMockContext({ user });

			await expect(invokeHook(onBeforeUserCreate(options), user, ctx)).rejects.toBeInstanceOf(
				MockAPIError,
			);
			expect(mockClient.createConsumer).not.toHaveBeenCalled();
		});

		it("throws when StreamPay rejects createConsumer — this is the orphan-row fix", async () => {
			// This is the critical regression guard. When the before-hook
			// throws, Better Auth's createWithHooks aborts the insert (see
			// better-auth/dist/db/with-hooks.mjs:11-17), so no user row is
			// ever persisted. The sign-up fails cleanly instead of leaving
			// an orphaned row with no StreamPay consumer link.
			const options = createTestStreamPayOptions({ client: mockClient });
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
				/sandbox mode/,
			);
		});

		describe("DUPLICATE_CONSUMER reuse path", () => {
			// Shared fixture: StreamPay rejects create with DUPLICATE_CONSUMER.
			// The hook should then call listConsumers and decide whether to
			// reuse, refuse, or re-throw based on the existing consumer's
			// external_id.
			const duplicateError = mockApiError(400, {
				error: {
					code: "DUPLICATE_CONSUMER",
					message: "Consumer already exist",
					additional_info: "Consumer with email 'test@example.com' already exists in the system",
				},
			});

			it("reuses a STRANDED consumer (no external_id) on DUPLICATE_CONSUMER", async () => {
				const options = createTestStreamPayOptions({ client: mockClient });
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				// Stranded: external_id is null — this consumer belongs to
				// nobody, so linking it to the new user is safe.
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
				const options = createTestStreamPayOptions({ client: mockClient });
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				// Linked: external_id points to some other Better Auth user.
				// Reusing it would hand this user access to that other user's
				// billing history. The hook must refuse.
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
				// The logger must record enough context for ops to debug,
				// but the message thrown to the user must NOT expose the
				// fact that another account exists (user-enumeration leak).
				expect(ctx.context.logger.error).toHaveBeenCalledWith(
					expect.stringContaining("already linked to external_id"),
				);
			});

			it('reclaims an already-linked SAME-EMAIL consumer when claimExistingConsumerBy is "email"', async () => {
				const options = createTestStreamPayOptions({
					client: mockClient,
					claimExistingConsumerBy: "email",
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

			it('still refuses a linked consumer when claimExistingConsumerBy is "email" but the match is only by phone', async () => {
				const options = createTestStreamPayOptions({
					client: mockClient,
					claimExistingConsumerBy: "email",
					getConsumerCreateParams: async () => ({
						phone_number: "+966500000000",
					}),
				});
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				mockClient.listConsumers.mockResolvedValue(
					createMockConsumerList([
						createMockConsumer({
							id: "cons_phone_only",
							email: "other@example.com",
							phone_number: "+966500000000",
							external_id: "old-user-id",
						}),
					]),
				);

				const user = createMockUser();
				const ctx = createMockContext({ user });

				await expect(invokeHook(onBeforeUserCreate(options), user, ctx)).rejects.toBeInstanceOf(
					MockAPIError,
				);
			});

			it('reclaims an already-linked SAME-PHONE consumer when claimExistingConsumerBy is "phone"', async () => {
				const options = createTestStreamPayOptions({
					client: mockClient,
					claimExistingConsumerBy: "phone",
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

			it('still refuses a linked consumer when claimExistingConsumerBy is "phone" but the match is only by email', async () => {
				const options = createTestStreamPayOptions({
					client: mockClient,
					claimExistingConsumerBy: "phone",
					getConsumerCreateParams: async () => ({
						phone_number: "+966500000000",
					}),
				});
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				mockClient.listConsumers.mockResolvedValue(
					createMockConsumerList([
						createMockConsumer({
							id: "cons_email_only",
							email: "test@example.com",
							phone_number: null,
							external_id: "old-user-id",
						}),
					]),
				);

				const user = createMockUser();
				const ctx = createMockContext({ user });

				await expect(invokeHook(onBeforeUserCreate(options), user, ctx)).rejects.toBeInstanceOf(
					MockAPIError,
				);
			});

			it('reclaims either identifier when claimExistingConsumerBy is "both"', async () => {
				const options = createTestStreamPayOptions({
					client: mockClient,
					claimExistingConsumerBy: "both",
					getConsumerCreateParams: async () => ({
						phone_number: "+966500000000",
					}),
				});
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				mockClient.listConsumers.mockResolvedValue(
					createMockConsumerList([
						createMockConsumer({
							id: "cons_claimed_by_phone",
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
					data: { streampayConsumerId: "cons_claimed_by_phone" },
				});
			});

			it("does not reclaim linked consumers when claimExistingConsumerBy is null", async () => {
				const options = createTestStreamPayOptions({
					client: mockClient,
					claimExistingConsumerBy: null,
				});
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				mockClient.listConsumers.mockResolvedValue(
					createMockConsumerList([
						createMockConsumer({
							id: "cons_linked_null_mode",
							email: "test@example.com",
							external_id: "old-user-id",
						}),
					]),
				);

				const user = createMockUser();
				const ctx = createMockContext({ user });

				await expect(invokeHook(onBeforeUserCreate(options), user, ctx)).rejects.toBeInstanceOf(
					MockAPIError,
				);
			});

			it('prefers an exact email match before other duplicate identifiers when claimExistingConsumerBy is "both"', async () => {
				const options = createTestStreamPayOptions({
					client: mockClient,
					claimExistingConsumerBy: "both",
					getConsumerCreateParams: async () => ({
						phone_number: "+966500000000",
					}),
				});
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				mockClient.listConsumers
					.mockResolvedValueOnce(
						createMockConsumerList([
							createMockConsumer({
								id: "cons_email_match",
								email: "test@example.com",
								phone_number: null,
								external_id: "old-user-id",
							}),
						]),
					)
					.mockResolvedValueOnce(
						createMockConsumerList([
							createMockConsumer({
								id: "cons_phone_match",
								email: "different@example.com",
								phone_number: "+966500000000",
								external_id: "another-user-id",
							}),
						]),
					);

				const user = createMockUser();
				const ctx = createMockContext({ user });

				const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

				expect(result).toEqual({
					data: { streampayConsumerId: "cons_email_match" },
				});
				expect(mockClient.listConsumers).toHaveBeenCalledTimes(1);
			});

			it("falls through to the generic error when the scan cannot find the duplicate", async () => {
				const options = createTestStreamPayOptions({ client: mockClient });
				mockClient.createConsumer.mockRejectedValue(duplicateError);
				// StreamPay said duplicate but the scan is empty — could be
				// pagination gap, race, or soft-delete. We must re-throw
				// the original error rather than silently succeeding.
				mockClient.listConsumers.mockResolvedValue(createMockConsumerList());

				const user = createMockUser();
				const ctx = createMockContext({ user });

				await expect(invokeHook(onBeforeUserCreate(options), user, ctx)).rejects.toThrow(
					/Consumer already exist|already exists/,
				);
			});

			it("matches on phone_number, not just email", async () => {
				// If the integrator uses getConsumerCreateParams to set a
				// phone number and StreamPay rejects because of a phone
				// duplicate, the reuse path must find the match by phone.
				const options = createTestStreamPayOptions({
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
			const options = createTestStreamPayOptions({
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
			const options = createTestStreamPayOptions({ client: mockClient });
			const user = { ...createMockUser({ email: "" }), isAnonymous: true };
			const ctx = createMockContext({ user });

			const result = await invokeHook(onBeforeUserCreate(options), user, ctx);

			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			expect(result).toBeUndefined();
		});

		it("is a no-op when ctx is null (hook invoked outside a request)", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			const user = createMockUser();

			const result = await invokeHook(onBeforeUserCreate(options), user, null);

			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			expect(result).toBeUndefined();
		});
	});

	describe("onAfterUserCreate", () => {
		it("back-links the consumer by patching external_id onto it", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			mockClient.updateConsumer.mockResolvedValue(createMockConsumer());

			// By the time this hook runs, the before-hook has already created
			// the consumer and its id lives on the row.
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
			// The user row is already committed by the time the after-hook
			// runs. Throwing would surface as a 500 after a successful
			// sign-up — worse UX than leaving the consumer temporarily
			// unlinked (it can still be resolved via its id on the row).
			const options = createTestStreamPayOptions({ client: mockClient });
			mockClient.updateConsumer.mockRejectedValue(
				mockApiError(500, { error: { message: "streampay down" } }),
			);

			const user = createMockUser({
				streampayConsumerId: "cons_fresh",
			});
			const ctx = createMockContext({ user });

			await expect(invokeHook(onAfterUserCreate(options), user, ctx)).resolves.toBeUndefined();

			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("StreamPay consumer external_id link failed"),
			);
		});

		it("is a no-op when streampayConsumerId is missing (before-hook was a no-op)", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			const user = createMockUser({ streampayConsumerId: null });
			const ctx = createMockContext({ user });

			await invokeHook(onAfterUserCreate(options), user, ctx);

			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
		});

		it("is a no-op when createConsumerOnSignUp is false", async () => {
			const options = createTestStreamPayOptions({
				client: mockClient,
				createConsumerOnSignUp: false,
			});
			const user = createMockUser({ streampayConsumerId: "cons_fresh" });
			const ctx = createMockContext({ user });

			await invokeHook(onAfterUserCreate(options), user, ctx);

			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
		});

		it("is a no-op for anonymous users", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			const user = {
				...createMockUser({ streampayConsumerId: "cons_fresh" }),
				isAnonymous: true,
			};
			const ctx = createMockContext({ user });

			await invokeHook(onAfterUserCreate(options), user, ctx);

			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
		});

		it("is a no-op when ctx is null", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			const user = createMockUser({ streampayConsumerId: "cons_fresh" });

			await invokeHook(onAfterUserCreate(options), user, null);

			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
		});
	});

	describe("onUserUpdate", () => {
		it("syncs name and email to the linked StreamPay consumer", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			mockClient.updateConsumer.mockResolvedValue(createMockConsumer());

			const user = createMockUser({
				name: "Renamed",
				email: "renamed@example.com",
				streampayConsumerId: "cons_linked",
			});
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.updateConsumer).toHaveBeenCalledWith(
				"cons_linked",
				expect.objectContaining({
					name: "Renamed",
					email: "renamed@example.com",
				}),
			);
		});

		it("falls back to a list-scan when streampayConsumerId is not stored", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			mockClient.listConsumers.mockResolvedValue(
				createMockConsumerList([
					createMockConsumer({ id: "cons_from_scan", external_id: "user-123" }),
				]),
			);
			mockClient.updateConsumer.mockResolvedValue(createMockConsumer());

			const user = createMockUser({ streampayConsumerId: null });
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.listConsumers).toHaveBeenCalled();
			expect(mockClient.updateConsumer).toHaveBeenCalledWith("cons_from_scan", expect.anything());
		});

		it("logs but never throws when StreamPay returns an error", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			mockClient.updateConsumer.mockRejectedValue(
				mockApiError(500, { error: { message: "internal" } }),
			);

			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });

			await expect(invokeHook(onUserUpdate(options), user, ctx)).resolves.toBeUndefined();
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("StreamPay consumer update failed"),
			);
		});

		it("is a no-op when createConsumerOnSignUp is false", async () => {
			const options = createTestStreamPayOptions({
				client: mockClient,
				createConsumerOnSignUp: false,
			});
			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
		});

		it("is a no-op for anonymous users", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			const user = {
				...createMockUser({ streampayConsumerId: "cons_linked" }),
				isAnonymous: true,
			};
			const ctx = createMockContext({ user });
			await invokeHook(onUserUpdate(options), user, ctx);

			expect(mockClient.updateConsumer).not.toHaveBeenCalled();
		});
	});

	describe("onUserDelete", () => {
		it("deletes the linked StreamPay consumer", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			mockClient.deleteConsumer.mockResolvedValue(undefined);

			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });
			await invokeHook(onUserDelete(options), user, ctx);

			expect(mockClient.deleteConsumer).toHaveBeenCalledWith("cons_linked");
		});

		it("logs but never throws when StreamPay delete fails", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
			mockClient.deleteConsumer.mockRejectedValue(
				mockApiError(404, { error: { message: "consumer not found" } }),
			);

			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });

			await expect(invokeHook(onUserDelete(options), user, ctx)).resolves.toBeUndefined();
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("StreamPay consumer delete failed"),
			);
		});

		it("is a no-op when no consumer is linked and the scan finds nothing", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });

			const user = createMockUser({ streampayConsumerId: null });
			const ctx = createMockContext({ user });
			await invokeHook(onUserDelete(options), user, ctx);

			expect(mockClient.deleteConsumer).not.toHaveBeenCalled();
		});

		it("is a no-op when createConsumerOnSignUp is false", async () => {
			const options = createTestStreamPayOptions({
				client: mockClient,
				createConsumerOnSignUp: false,
			});
			const user = createMockUser({ streampayConsumerId: "cons_linked" });
			const ctx = createMockContext({ user });
			await invokeHook(onUserDelete(options), user, ctx);

			expect(mockClient.deleteConsumer).not.toHaveBeenCalled();
		});

		it("is a no-op for anonymous users", async () => {
			const options = createTestStreamPayOptions({ client: mockClient });
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
