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

import { subscriptions } from "../src/plugins/subscriptions";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
import {
	createMockConsumer,
	createMockConsumerList,
	createMockContext,
	createMockStreamPayClient,
	createMockSubscription,
	createMockUser,
	type MockCtx,
	type MockedStreamPayClient,
} from "./utils/mocks";

const LINKED_CONSUMER = "cons_linked";
const OWNED_SUB = "11111111-1111-1111-1111-111111111111";
const OTHER_SUB = "22222222-2222-2222-2222-222222222222";

describe("subscriptions plugin", () => {
	let mockClient: MockedStreamPayClient;

	beforeEach(() => {
		mockClient = createMockStreamPayClient();
		vi.clearAllMocks();
	});

	describe("plugin creation", () => {
		it("registers cancelSubscription and freezeSubscription endpoints", () => {
			const plugin = subscriptions();
			const endpoints = plugin(createTestStreamPayOptions({ client: mockClient }));

			expect(endpoints).toHaveProperty("cancelSubscription");
			expect(endpoints).toHaveProperty("freezeSubscription");
		});
	});

	describe("cancelSubscription handler", () => {
		let handler: (ctx: MockCtx) => Promise<unknown>;

		beforeEach(() => {
			handler = unwrapHandler(subscriptions()(createTestStreamPayOptions({ client: mockClient })).cancelSubscription);
		});

		it("cancels a subscription the user owns and forwards cancel_related_invoices", async () => {
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OWNED_SUB,
					organization_consumer_id: LINKED_CONSUMER,
				}),
			);
			mockClient.cancelSubscription.mockResolvedValue(createMockSubscription({ id: OWNED_SUB }));

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				body: { subscriptionId: OWNED_SUB, cancelRelatedInvoices: true },
			});

			await handler(ctx);

			expect(mockClient.cancelSubscription).toHaveBeenCalledWith(OWNED_SUB, {
				cancel_related_invoices: true,
			});
		});

		it("defaults cancel_related_invoices to false when not specified", async () => {
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OWNED_SUB,
					organization_consumer_id: LINKED_CONSUMER,
				}),
			);
			mockClient.cancelSubscription.mockResolvedValue(createMockSubscription({ id: OWNED_SUB }));

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				body: { subscriptionId: OWNED_SUB },
			});

			await handler(ctx);

			expect(mockClient.cancelSubscription).toHaveBeenCalledWith(OWNED_SUB, {
				cancel_related_invoices: false,
			});
		});

		it("blocks cancellation of a subscription owned by someone else with FORBIDDEN", async () => {
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OTHER_SUB,
					organization_consumer_id: "cons_not_mine",
				}),
			);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				body: { subscriptionId: OTHER_SUB },
			});

			await expect(handler(ctx)).rejects.toThrow(/does not belong to this user/);
			expect(mockClient.cancelSubscription).not.toHaveBeenCalled();
		});

		it("returns UNAUTHORIZED when there is no session user", async () => {
			const ctx = createMockContext({
				user: undefined,
				body: { subscriptionId: OWNED_SUB },
			});
			await expect(handler(ctx)).rejects.toThrow(/Session user is missing/);
		});

		it("rejects anonymous sessions before any StreamPay call — no orphan consumer leak", async () => {
			// An anonymous session has a valid Better Auth user with a
			// generated id; without this guard, ensureConsumerForUser
			// would happily create a StreamPay consumer for them that
			// can never be reclaimed. Reject before the lazy path fires.
			const ctx = createMockContext({
				user: { ...createMockUser({ streampayConsumerId: null }), isAnonymous: true },
				body: { subscriptionId: OWNED_SUB },
			});
			await expect(handler(ctx)).rejects.toThrow(/Anonymous users cannot/);
			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			expect(mockClient.getSubscription).not.toHaveBeenCalled();
			expect(mockClient.cancelSubscription).not.toHaveBeenCalled();
		});

		it("propagates SDK failures as INTERNAL_SERVER_ERROR with a log", async () => {
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OWNED_SUB,
					organization_consumer_id: LINKED_CONSUMER,
				}),
			);
			mockClient.cancelSubscription.mockRejectedValue(
				mockApiError(500, { error: { message: "downstream" } }),
			);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				body: { subscriptionId: OWNED_SUB },
			});

			await expect(handler(ctx)).rejects.toThrow(/Subscription cancellation failed/);
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("cancelSubscription failed"),
			);
		});

		it("lazy-creates a consumer for orphan users, then FORBIDDEN on ownership mismatch", async () => {
			// Symmetric to the freezeSubscription test: cancel also goes
			// through assertOwnsSubscription → ensureConsumerForUser.
			mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
			mockClient.createConsumer.mockResolvedValue(
				createMockConsumer({ id: "cons_lazy_cancel", external_id: "user-orphan" }),
			);
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OWNED_SUB,
					organization_consumer_id: "cons_owner",
				}),
			);
			const ctx = createMockContext({
				user: createMockUser({ id: "user-orphan", streampayConsumerId: null }),
				body: { subscriptionId: OWNED_SUB },
			});
			await expect(handler(ctx)).rejects.toThrow(/does not belong to this user/);
			expect(mockClient.createConsumer).toHaveBeenCalled();
			expect(mockClient.cancelSubscription).not.toHaveBeenCalled();
		});
	});

	describe("freezeSubscription handler", () => {
		let handler: (ctx: MockCtx) => Promise<unknown>;

		beforeEach(() => {
			handler = unwrapHandler(subscriptions()(createTestStreamPayOptions({ client: mockClient })).freezeSubscription);
		});

		it("freezes a subscription the user owns with the real API field names", async () => {
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OWNED_SUB,
					organization_consumer_id: LINKED_CONSUMER,
				}),
			);
			mockClient.freezeSubscription.mockResolvedValue({
				id: "frz_1",
				subscription_id: OWNED_SUB,
			});

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				body: {
					subscriptionId: OWNED_SUB,
					freezeStartDatetime: "2026-05-01T00:00:00.000Z",
					freezeEndDatetime: "2026-06-01T00:00:00.000Z",
					notes: "user-requested pause",
				},
			});

			await handler(ctx);

			expect(mockClient.freezeSubscription).toHaveBeenCalledWith(OWNED_SUB, {
				freeze_start_datetime: "2026-05-01T00:00:00.000Z",
				freeze_end_datetime: "2026-06-01T00:00:00.000Z",
				notes: "user-requested pause",
			});
		});

		it("omits optional fields from the payload when not provided", async () => {
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OWNED_SUB,
					organization_consumer_id: LINKED_CONSUMER,
				}),
			);
			mockClient.freezeSubscription.mockResolvedValue({
				id: "frz_2",
				subscription_id: OWNED_SUB,
			});

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				body: {
					subscriptionId: OWNED_SUB,
					freezeStartDatetime: "2026-05-01T00:00:00.000Z",
				},
			});

			await handler(ctx);

			expect(mockClient.freezeSubscription).toHaveBeenCalledWith(OWNED_SUB, {
				freeze_start_datetime: "2026-05-01T00:00:00.000Z",
			});
		});

		it("blocks freeze of a subscription owned by someone else with FORBIDDEN", async () => {
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OTHER_SUB,
					organization_consumer_id: "cons_not_mine",
				}),
			);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				body: {
					subscriptionId: OTHER_SUB,
					freezeStartDatetime: "2026-05-01T00:00:00.000Z",
				},
			});

			await expect(handler(ctx)).rejects.toThrow(/does not belong to this user/);
			expect(mockClient.freezeSubscription).not.toHaveBeenCalled();
		});

		it("returns UNAUTHORIZED when there is no session user", async () => {
			const ctx = createMockContext({
				user: undefined,
				body: {
					subscriptionId: OWNED_SUB,
					freezeStartDatetime: "2026-05-01T00:00:00.000Z",
				},
			});
			await expect(handler(ctx)).rejects.toThrow(/Session user is missing/);
		});

		it("rejects anonymous sessions before any StreamPay call — no orphan consumer leak", async () => {
			const ctx = createMockContext({
				user: { ...createMockUser({ streampayConsumerId: null }), isAnonymous: true },
				body: {
					subscriptionId: OWNED_SUB,
					freezeStartDatetime: "2026-05-01T00:00:00.000Z",
				},
			});
			await expect(handler(ctx)).rejects.toThrow(/Anonymous users cannot/);
			expect(mockClient.createConsumer).not.toHaveBeenCalled();
			expect(mockClient.freezeSubscription).not.toHaveBeenCalled();
		});

		it("lazy-creates a consumer for orphan users, then FORBIDDEN on ownership mismatch", async () => {
			// Lazy mode: a user without a linked consumer gets one created
			// at action time. The freshly-created consumer can't own any
			// existing subscription, so the ownership check rejects as
			// FORBIDDEN (same user-facing outcome as the old NOT_FOUND).
			mockClient.listConsumers.mockResolvedValue(createMockConsumerList());
			mockClient.createConsumer.mockResolvedValue(
				createMockConsumer({ id: "cons_lazy", external_id: "user-orphan" }),
			);
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OWNED_SUB,
					organization_consumer_id: "cons_owner",
				}),
			);
			const ctx = createMockContext({
				user: createMockUser({
					id: "user-orphan",
					streampayConsumerId: null,
				}),
				body: {
					subscriptionId: OWNED_SUB,
					freezeStartDatetime: "2026-05-01T00:00:00.000Z",
				},
			});
			await expect(handler(ctx)).rejects.toThrow(/does not belong to this user/);
			expect(mockClient.createConsumer).toHaveBeenCalled();
			expect(ctx.context.internalAdapter.updateUser).toHaveBeenCalledWith(
				"user-orphan",
				expect.objectContaining({ streampayConsumerId: "cons_lazy" }),
			);
		});

		it("propagates SDK failures as INTERNAL_SERVER_ERROR with a log", async () => {
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: OWNED_SUB,
					organization_consumer_id: LINKED_CONSUMER,
				}),
			);
			mockClient.freezeSubscription.mockRejectedValue(
				mockApiError(500, { error: { message: "downstream" } }),
			);

			const ctx = createMockContext({
				user: createMockUser({ streampayConsumerId: LINKED_CONSUMER }),
				body: {
					subscriptionId: OWNED_SUB,
					freezeStartDatetime: "2026-05-01T00:00:00.000Z",
				},
			});

			await expect(handler(ctx)).rejects.toThrow(/Subscription freeze failed/);
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("freezeSubscription failed"),
			);
		});
	});

	// Reference MockAPIError so the module sees it as used. Handlers throw
	// APIError instances from the mocked module, which is the identity we
	// pinned to MockAPIError above.
	void MockAPIError;
});
