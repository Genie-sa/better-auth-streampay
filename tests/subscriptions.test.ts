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
	type StreamPayPlan,
	type StreamPayPluginRegistry,
	subscriptionSlotKey,
	subscriptions,
	UPGRADE_IDEMPOTENCY_WINDOW_MS,
} from "../src/plugins/subscriptions";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
import {
	createMockContext,
	createMockStreamPayClient,
	createMockSubscription,
	createMockUser,
	type MockCtx,
	type MockedStreamPayClient,
} from "./utils/mocks";
import {
	createMockAdapter,
	createMockSubscriptionRow,
	createMockWebhookPayload,
} from "./utils/subscription-helpers";

const PRO_PLAN: StreamPayPlan = {
	name: "pro",
	productId: "prod_pro",
	priceInSmallestUnit: 9900,
	billingInterval: "MONTH",
};
const PRO_PLUS_PLAN: StreamPayPlan = {
	name: "pro_plus",
	productId: "prod_pro_plus",
	priceInSmallestUnit: 19900,
	billingInterval: "MONTH",
	group: "tier",
};
const BASIC_PLAN: StreamPayPlan = {
	name: "basic",
	productId: "prod_basic",
	priceInSmallestUnit: 2900,
	billingInterval: "MONTH",
	group: "tier",
};

function setupCtx(overrides: {
	user?: Parameters<typeof createMockUser>[0];
	adapter?: ReturnType<typeof createMockAdapter>;
	body?: Record<string, unknown>;
	query?: Record<string, unknown>;
}): { ctx: MockCtx; adapter: ReturnType<typeof createMockAdapter> } {
	const adapter = overrides.adapter ?? createMockAdapter();
	const ctxOptions: Parameters<typeof createMockContext>[0] = {
		user: createMockUser({ id: "user-123", ...overrides.user }),
	};
	if (overrides.body !== undefined) ctxOptions.body = overrides.body;
	if (overrides.query !== undefined) ctxOptions.query = overrides.query;
	const ctx = createMockContext(ctxOptions);
	ctx.context.adapter = adapter;
	return { ctx, adapter };
}

function getSubscriptionRows(
	adapter: ReturnType<typeof createMockAdapter>,
): Record<string, unknown>[] {
	return adapter.tables.subscription ?? [];
}

function buildSubsPlugin(
	plans: readonly StreamPayPlan[],
	mockClient: MockedStreamPayClient,
	opts: Partial<Parameters<typeof subscriptions>[0]> = {},
	streamPayOverrides: Partial<Parameters<typeof createTestStreamPayOptions>[0]> = {},
): {
	endpoints: Record<string, { path: string; config: unknown; handler: unknown }>;
	schema?: unknown;
} {
	return subscriptions({ plans, ...opts })(
		createTestStreamPayOptions({ client: mockClient, ...streamPayOverrides }),
	) as unknown as {
		endpoints: Record<string, { path: string; config: unknown; handler: unknown }>;
		schema?: unknown;
	};
}

describe("subscriptions() endpoints", () => {
	let mockClient: MockedStreamPayClient;

	beforeEach(() => {
		mockClient = createMockStreamPayClient();
		vi.clearAllMocks();
	});

	describe("upgradeSubscription", () => {
		it("rejects unknown request fields at the runtime boundary", () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const bodySchema = (
				plugin.endpoints.upgradeSubscription?.config as {
					body: { safeParse: (value: unknown) => { success: boolean } };
				}
			).body;

			expect(bodySchema.safeParse({ plan: "pro", seats: 4 }).success).toBe(true);
			expect(bodySchema.safeParse({ plan: "pro", seats: 4, unexpected: true }).success).toBe(false);
		});

		it("happy path — creates payment link and pre-creates incomplete row", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{
				subscriptionId: string;
				url: string;
				reused: boolean;
				status: string;
			}>(plugin.endpoints.upgradeSubscription);

			mockClient.createPaymentLink.mockResolvedValue({
				id: "pl_123",
				url: "https://pay.streampay.sa/pl_123",
			});
			mockClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_123");

			const { ctx, adapter } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});

			const result = await handler(ctx);
			expect(result.url).toBe("https://pay.streampay.sa/pl_123");
			expect(result.reused).toBe(false);
			expect(result.status).toBe("incomplete");
			expect(getSubscriptionRows(adapter)).toHaveLength(1);
			const [row] = getSubscriptionRows(adapter);
			expect(row?.plan).toBe("pro");
			expect(row?.status).toBe("incomplete");
			expect(row?.amountInSmallestUnit).toBe(9900);
			expect(row?.streampayConsumerId).toBe("cons_linked");
			expect(row?.referenceType).toBe("user");
			expect(row?.activeSlotKey).toBe(subscriptionSlotKey("user", "user-123", null));
			expect(row).not.toHaveProperty("checkoutUrl");

			const paymentLinkArgs = mockClient.createPaymentLink.mock.calls[0]?.[0];
			expect(paymentLinkArgs?.custom_metadata).toMatchObject({
				streampay_plugin_plan_name: "pro",
				streampay_plugin_reference_id: "user-123",
				streampay_plugin_reference_type: "user",
				streampay_plugin_subscription_row_id: row?.id,
			});
		});

		it("quotes and persists a fixed seat quantity", async () => {
			const plugin = buildSubsPlugin(
				[{ ...PRO_PLAN, seatBilling: { minimum: 2, maximum: 50 } }],
				mockClient,
			);
			const handler = unwrapHandler<{ seats: number }>(plugin.endpoints.upgradeSubscription);
			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_seats", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");
			const { ctx, adapter } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro", seats: 7 },
			});

			await expect(handler(ctx)).resolves.toMatchObject({ seats: 7 });
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({
					items: [
						{
							product_id: "prod_pro",
							quantity: 7,
							allow_custom_quantity: false,
						},
					],
				}),
			);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				seats: 7,
				amountInSmallestUnit: 69_300,
				originalAmountInSmallestUnit: 69_300,
			});
		});

		it("supports an explicitly bounded customer-editable hosted quantity", async () => {
			const plugin = buildSubsPlugin(
				[
					{
						...PRO_PLAN,
						seatBilling: {
							default: 3,
							minimum: 2,
							maximum: 25,
							customerEditable: true,
						},
					},
				],
				mockClient,
			);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_adjustable", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");
			const { ctx, adapter } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});

			await handler(ctx);
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({
					items: [
						{
							product_id: "prod_pro",
							quantity: 3,
							allow_custom_quantity: true,
							min_quantity: 2,
							max_quantity: 25,
						},
					],
				}),
			);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({ seats: 3 });
		});

		it("rejects a requested seat count outside plan bounds before creating a reservation", async () => {
			const plugin = buildSubsPlugin(
				[{ ...PRO_PLAN, seatBilling: { minimum: 2, maximum: 10 } }],
				mockClient,
			);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			const { ctx, adapter } = setupCtx({ body: { plan: "pro", seats: 11 } });

			await expect(handler(ctx)).rejects.toMatchObject({
				code: "BAD_REQUEST",
				errorCode: "SUBSCRIPTION_SEAT_COUNT_INVALID",
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
			expect(getSubscriptionRows(adapter)).toHaveLength(0);
		});

		it("propagates SDK currency and immutable plan version into checkout and persistence", async () => {
			const versionedPlan: StreamPayPlan = {
				...PRO_PLAN,
				currency: "QAR",
				version: "catalog-2026-07",
			};
			const plugin = buildSubsPlugin([versionedPlan], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_jpy", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");
			const { ctx, adapter } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});

			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ currency: "QAR" }),
			);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				currency: "QAR",
				planVersion: "catalog-2026-07",
				productId: "prod_pro",
			});
		});

		it("passes a configured trial period to StreamPay checkout", async () => {
			const plugin = buildSubsPlugin([{ ...PRO_PLAN, trialPeriodDays: 14 }], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_trial", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");
			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});

			await handler(ctx);
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ trial_period_days: 14 }),
			);
		});

		it("suppresses repeat trials within the same reference and plan group", async () => {
			const plugin = buildSubsPlugin([{ ...PRO_PLAN, trialPeriodDays: 14 }], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_repeat", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "pro",
					status: "canceled",
					trialEnd: new Date("2026-01-15T00:00:00.000Z"),
				}),
			});
			const { ctx } = setupCtx({
				adapter,
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});

			await handler(ctx);

			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.not.objectContaining({ trial_period_days: expect.any(Number) }),
			);
		});

		it("supports a typed application override for repeat-trial eligibility", async () => {
			const isTrialEligible = vi.fn(() => true);
			const plugin = buildSubsPlugin([{ ...PRO_PLAN, trialPeriodDays: 14 }], mockClient, {
				isTrialEligible,
			});
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			mockClient.createPaymentLink.mockResolvedValue({
				id: "pl_repeat_override",
				url: "https://x",
			});
			mockClient.getPaymentUrl.mockReturnValue("https://x");
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "pro",
					status: "canceled",
					trialStart: new Date("2026-01-01T00:00:00.000Z"),
				}),
			});
			const { ctx } = setupCtx({
				adapter,
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});

			await handler(ctx);

			expect(isTrialEligible).toHaveBeenCalledWith(
				expect.objectContaining({
					referenceId: "user-123",
					referenceType: "user",
					defaultEligible: false,
				}),
				ctx,
			);
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ trial_period_days: 14 }),
			);
		});

		it("returns the existing incomplete row within the 15-minute idempotency window", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{
				subscriptionId: string;
				reused: boolean;
				status: string;
			}>(plugin.endpoints.upgradeSubscription);

			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_existing",
					referenceId: "user-123",
					plan: "pro",
					status: "incomplete",
					streampayPaymentLinkId: "pl_existing",
					createdAt: new Date(Date.now() - 60 * 1000),
				}),
			});
			mockClient.getPaymentLink.mockResolvedValue({
				id: "pl_existing",
				url: "https://pay.streampay.sa/pl_existing",
			});
			mockClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_existing");

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
				adapter,
			});

			const result = await handler(ctx);
			expect(result.subscriptionId).toBe("row_existing");
			expect(result.reused).toBe(true);
			expect(result).toMatchObject({
				url: "https://pay.streampay.sa/pl_existing",
				redirect: true,
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("does not reuse an in-progress checkout created for a different seat count", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_two_seats",
					activeSlotKey: subscriptionSlotKey("user", "user-123", null),
					plan: "pro",
					seats: 2,
					status: "incomplete",
					streampayPaymentLinkId: "pl_two_seats",
					createdAt: new Date(),
				}),
			});
			const { ctx } = setupCtx({
				adapter,
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro", seats: 3 },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "SUBSCRIPTION_CHECKOUT_IN_PROGRESS",
			});
			expect(mockClient.getPaymentLink).not.toHaveBeenCalled();
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("does not expire or duplicate a checkout when payment-link recovery is transiently unavailable", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_recovery_outage",
					activeSlotKey: subscriptionSlotKey("user", "user-123", null),
					status: "incomplete",
					streampayPaymentLinkId: "pl_recovery_outage",
					createdAt: new Date(),
				}),
			});
			mockClient.getPaymentLink.mockRejectedValue(mockApiError(503, { code: "UNAVAILABLE" }));
			const { ctx } = setupCtx({
				adapter,
				body: { plan: "pro" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				status: "incomplete",
				activeSlotKey: subscriptionSlotKey("user", "user-123", null),
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("returns a valid checkout when correlation persistence fails after provider creation", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ subscriptionId: string; url: string }>(
				plugin.endpoints.upgradeSubscription,
			);
			const adapter = createMockAdapter();
			vi.spyOn(adapter, "update").mockRejectedValueOnce(new Error("database write unavailable"));
			mockClient.createPaymentLink.mockResolvedValue({
				id: "pl_persist_recovery",
				url: "https://pay.streampay.sa/pl_persist_recovery",
			});
			mockClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_persist_recovery");
			const { ctx } = setupCtx({
				adapter,
				body: { plan: "pro" },
			});

			const result = await handler(ctx);

			expect(result.url).toBe("https://pay.streampay.sa/pl_persist_recovery");
			expect(getSubscriptionRows(adapter)[0]?.streampayPaymentLinkId).toBeNull();
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("Protected checkout metadata will reconcile"),
			);
		});

		it("releases the reservation after provider failure so an immediate retry can succeed", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ url: string }>(plugin.endpoints.upgradeSubscription);
			const adapter = createMockAdapter();
			const { ctx } = setupCtx({
				adapter,
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});
			mockClient.createPaymentLink.mockRejectedValueOnce(
				mockApiError(503, { error: { code: "UPSTREAM_UNAVAILABLE" } }),
			);

			await expect(handler(ctx)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
			expect(getSubscriptionRows(adapter)).toHaveLength(0);

			mockClient.createPaymentLink.mockResolvedValueOnce({
				id: "pl_retry",
				url: "https://pay.streampay.sa/pl_retry",
			});
			mockClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_retry");

			await expect(handler(ctx)).resolves.toMatchObject({
				url: "https://pay.streampay.sa/pl_retry",
			});
			expect(getSubscriptionRows(adapter)).toHaveLength(1);
		});

		it("releases the active slot when StreamPay creates a link without a payment URL", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			const adapter = createMockAdapter();
			const { ctx } = setupCtx({
				adapter,
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});
			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_without_url" });
			mockClient.getPaymentUrl.mockReturnValue(null);

			await expect(handler(ctx)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
			expect(getSubscriptionRows(adapter)).toHaveLength(1);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				streampayPaymentLinkId: "pl_without_url",
				status: "incomplete_expired",
				activeSlotKey: null,
			});
		});

		it("does not reuse rows older than the idempotency window", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ reused: boolean }>(plugin.endpoints.upgradeSubscription);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_fresh", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");

			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "pro",
					status: "incomplete",
					createdAt: new Date(Date.now() - UPGRADE_IDEMPOTENCY_WINDOW_MS - 60 * 1000),
				}),
			});

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
				adapter,
			});

			const result = await handler(ctx);
			expect(result.reused).toBe(false);
			expect(mockClient.createPaymentLink).toHaveBeenCalledTimes(1);
		});

		it("uses the unique active slot to reject a concurrent checkout reservation", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_in_flight",
					activeSlotKey: subscriptionSlotKey("user", "user-123", null),
					status: "incomplete",
					streampayPaymentLinkId: null,
				}),
			});
			const { ctx } = setupCtx({
				adapter,
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "SUBSCRIPTION_CHECKOUT_IN_PROGRESS",
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
			expect(getSubscriptionRows(adapter)).toHaveLength(1);
		});

		it("replaces an abandoned checkout reservation after the idempotency window", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ subscriptionId: string; reused: boolean }>(
				plugin.endpoints.upgradeSubscription,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_abandoned",
					activeSlotKey: subscriptionSlotKey("user", "user-123", null),
					status: "incomplete",
					streampayPaymentLinkId: null,
					createdAt: new Date(Date.now() - UPGRADE_IDEMPOTENCY_WINDOW_MS - 1),
				}),
			});
			mockClient.createPaymentLink.mockResolvedValue({
				id: "pl_replacement",
				url: "https://pay.streampay.sa/pl_replacement",
			});
			mockClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_replacement");
			const { ctx } = setupCtx({
				adapter,
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
			});

			const result = await handler(ctx);

			expect(result).toMatchObject({ reused: false });
			expect(result.subscriptionId).not.toBe("row_abandoned");
			expect(mockClient.createPaymentLink).toHaveBeenCalledTimes(1);
			expect(getSubscriptionRows(adapter)).toHaveLength(2);
			expect(getSubscriptionRows(adapter).find((row) => row.id === "row_abandoned")).toMatchObject({
				status: "incomplete_expired",
				activeSlotKey: null,
			});
			expect(ctx.context.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("released stale checkout reservation"),
			);
		});

		it("throws SUBSCRIPTION_PLAN_NOT_FOUND when plan is not configured", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "enterprise" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				code: "NOT_FOUND",
				errorCode: "SUBSCRIPTION_PLAN_NOT_FOUND",
			});
		});

		it("refuses to create a second subscription when one in the same group is active", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);

			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "basic",
					group: "tier",
					status: "active",
					streampaySubscriptionId: "sub_basic",
				}),
			});

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro_plus" },
				adapter,
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "SUBSCRIPTION_ALREADY_ACTIVE",
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("allows a second sub if plans are in different groups", async () => {
			const GROUP_A: StreamPayPlan = { ...PRO_PLAN, name: "plan_a", group: "group_a" };
			const GROUP_B: StreamPayPlan = {
				...PRO_PLAN,
				name: "plan_b",
				productId: "prod_plan_b",
				group: "group_b",
			};
			const plugin = buildSubsPlugin([GROUP_A, GROUP_B], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_2", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");

			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "plan_a",
					group: "group_a",
					status: "active",
					streampaySubscriptionId: "sub_a",
				}),
			});

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "plan_b" },
				adapter,
			});

			await expect(handler(ctx)).resolves.toBeDefined();
			expect(mockClient.createPaymentLink).toHaveBeenCalled();
		});

		it("rejects cross-account referenceId without authorizeReference", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);

			const { ctx } = setupCtx({
				user: { id: "user-me", streampayConsumerId: "cons_me" },
				body: { plan: "pro", referenceId: "user-other" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("honors authorizeReference returning true and bills the acting user by default", async () => {
			const authorizeReference = vi.fn().mockResolvedValue(true);
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient, { authorizeReference });
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_cross", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");

			const { ctx } = setupCtx({
				user: { id: "user-me", streampayConsumerId: "cons_me" },
				body: { plan: "pro", referenceId: "user-other" },
			});

			await expect(handler(ctx)).resolves.toBeDefined();
			expect(authorizeReference).toHaveBeenCalledWith(
				expect.objectContaining({
					referenceId: "user-other",
					referenceType: "custom",
					action: "upgrade",
				}),
				expect.anything(),
			);
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ organization_consumer_id: "cons_me" }),
			);
		});

		it("requires authorization when a custom reference happens to equal the user id", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscription);
			const { ctx } = setupCtx({
				body: { plan: "pro", referenceId: "user-123", referenceType: "custom" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});
	});

	describe("cancelSubscription (stateful)", () => {
		it("happy path — cancels and mirrors upstream into DB row", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.cancelSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_c",
					referenceId: "user-123",
					streampaySubscriptionId: "sub_c",
					status: "active",
				}),
			});

			mockClient.cancelSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_c",
					status: "CANCELED",
					ended_at: "2026-04-25T10:00:00Z",
				}),
			);
			mockClient.getSubscription.mockResolvedValueOnce(
				createMockSubscription({ id: "sub_c", status: "ACTIVE" }),
			);

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_me" },
				body: { subscriptionId: "row_c" },
				adapter,
			});
			await handler(ctx);

			expect(mockClient.cancelSubscription).toHaveBeenCalledWith("sub_c", {
				cancel_related_invoices: false,
			});
			expect(mockClient.getSubscription).toHaveBeenCalledOnce();
			const row = getSubscriptionRows(adapter)[0];
			expect(row?.status).toBe("canceled");
			expect(row?.endedAt).toBeInstanceOf(Date);
		});

		it("rejects when the row belongs to another user (no authorizeReference)", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.cancelSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-other",
					streampaySubscriptionId: "sub_other",
					status: "active",
				}),
			});
			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_me" },
				body: { subscriptionId: "sub_other" },
				adapter,
			});
			await expect(handler(ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("uses current StreamPay state when the local cancellation projection is stale", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.cancelSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_stale_cancel",
					status: "active",
					cancelAtPeriodEnd: true,
				}),
			});
			mockClient.getSubscription
				.mockResolvedValueOnce(
					createMockSubscription({
						id: "sub_stale_cancel",
						cancel_at_period_end: false,
					}),
				)
				.mockResolvedValueOnce(
					createMockSubscription({
						id: "sub_stale_cancel",
						cancel_at_period_end: true,
					}),
				);
			mockClient.cancelSubscription.mockResolvedValue(
				createMockSubscription({ id: "sub_stale_cancel", cancel_at_period_end: true }),
			);

			const { ctx } = setupCtx({
				body: { subscriptionId: "sub_stale_cancel" },
				adapter,
			});
			await handler(ctx);

			expect(mockClient.cancelSubscription).toHaveBeenCalledOnce();
		});

		it("rejects a period-end request that StreamPay would immediately cancel", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.cancelSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_trial",
					status: "trialing",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({ id: "sub_trial", status: "TRIALING" }),
			);

			const { ctx } = setupCtx({
				body: { subscriptionId: "sub_trial", cancelAtPeriodEnd: true },
				adapter,
			});
			await expect(handler(ctx)).rejects.toMatchObject({
				errorCode: "SUBSCRIPTION_PERIOD_END_CANCEL_UNSUPPORTED",
			});
			expect(mockClient.cancelSubscription).not.toHaveBeenCalled();
		});

		it("treats an upstream canceled subscription as an idempotent cancellation", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.cancelSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_already_canceled",
					status: "active",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({ id: "sub_already_canceled", status: "CANCELED" }),
			);

			const { ctx } = setupCtx({
				body: { subscriptionId: "sub_already_canceled" },
				adapter,
			});
			await expect(handler(ctx)).resolves.toMatchObject({ status: "CANCELED" });
			expect(mockClient.cancelSubscription).not.toHaveBeenCalled();
			expect(getSubscriptionRows(adapter)[0]?.status).toBe("canceled");
		});
	});

	describe("changeSubscriptionPlan", () => {
		it("schedules a native deferred change on the existing subscription", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler<{
				mode: string;
				subscriptionId: string;
				plan: string;
				reused: boolean;
			}>(plugin.endpoints.changeSubscriptionPlan);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_plan",
					plan: "basic",
					group: "tier",
					status: "active",
					streampaySubscriptionId: "sub_plan",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_plan",
					items: [{ product_id: "prod_basic", quantity: 1 }],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_plan",
					items: [{ product_id: "prod_basic", quantity: 1 }],
					pending_change: {
						id: "pending_1",
						effective_at: "2026-05-01T00:00:00Z",
						target_items: [{ product_id: "prod_pro_plus", quantity: 1 }],
					},
				}),
			);

			const { ctx } = setupCtx({
				body: { subscriptionId: "sub_plan", plan: "pro_plus" },
				adapter,
			});
			const result = await handler(ctx);

			expect(mockClient.updateSubscription).toHaveBeenCalledWith("sub_plan", {
				items: [{ product_id: "prod_pro_plus", quantity: 1 }],
				coupons: [],
				recurring_interval: "MONTH",
				recurring_interval_count: 1,
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				mode: "at_period_end",
				subscriptionId: "row_plan",
				plan: "pro_plus",
				reused: false,
			});
			expect(getSubscriptionRows(adapter)).toHaveLength(1);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				plan: "basic",
				pendingPlan: "pro_plus",
				pendingPlanEffectiveAt: new Date("2026-05-01T00:00:00Z"),
				cancelAtPeriodEnd: false,
			});
		});

		it("preserves add-ons, item coupons, and subscription coupons while changing plan and seats", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.changeSubscriptionPlan);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					seats: 3,
					status: "active",
					streampaySubscriptionId: "sub_multi_item",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_multi_item",
					coupon_calculation_metadata: { coupons: [{ coupon_id: "coupon_subscription" }] },
					items: [
						{
							product_id: "prod_basic",
							quantity: 3,
							coupon_calculation_metadata: {
								coupons: [{ coupon_id: "coupon_subscription" }, { coupon_id: "coupon_item" }],
							},
						},
						{ product_id: "prod_addon", quantity: 2 },
					],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_multi_item",
					items: [
						{ product_id: "prod_basic", quantity: 3 },
						{ product_id: "prod_addon", quantity: 2 },
					],
					pending_change: {
						id: "pending_multi",
						effective_at: "2026-05-01T00:00:00Z",
						target_items: [
							{ product_id: "prod_pro_plus", quantity: 8 },
							{ product_id: "prod_addon", quantity: 2 },
						],
					},
				}),
			);
			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_multi_item", plan: "pro_plus", seats: 8 },
			});

			await handler(ctx);
			expect(mockClient.updateSubscription).toHaveBeenCalledWith("sub_multi_item", {
				items: [
					{ product_id: "prod_pro_plus", quantity: 8, coupons: ["coupon_item"] },
					{ product_id: "prod_addon", quantity: 2 },
				],
				coupons: ["coupon_subscription"],
				recurring_interval: "MONTH",
				recurring_interval_count: 1,
			});
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				plan: "basic",
				seats: 3,
				pendingPlan: "pro_plus",
				pendingSeats: 8,
				pendingSeatsEffectiveAt: new Date("2026-05-01T00:00:00Z"),
			});
		});

		it("preserves the provider's current quantity when a plan change omits seats", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.changeSubscriptionPlan);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_preserve_seats",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_preserve_seats",
					items: [{ product_id: "prod_basic", quantity: 4 }],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_preserve_seats",
					items: [{ product_id: "prod_basic", quantity: 4 }],
					pending_change: {
						id: "pending_preserve_seats",
						effective_at: "2026-05-01T00:00:00Z",
						target_items: [{ product_id: "prod_pro_plus", quantity: 4 }],
					},
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_preserve_seats", plan: "pro_plus" },
			});
			await handler(ctx);

			expect(mockClient.updateSubscription).toHaveBeenCalledWith(
				"sub_preserve_seats",
				expect.objectContaining({
					items: [{ product_id: "prod_pro_plus", quantity: 4 }],
				}),
			);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				seats: 4,
				pendingSeats: 4,
			});
		});

		it("returns the existing pending change when the requested target matches", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler<{ reused: boolean }>(plugin.endpoints.changeSubscriptionPlan);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					status: "active",
					streampaySubscriptionId: "sub_plan",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_plan",
					pending_change: {
						id: "pending_1",
						effective_at: "2026-05-01T00:00:00Z",
						target_items: [{ product_id: "prod_pro_plus", quantity: 1 }],
					},
				}),
			);

			const { ctx } = setupCtx({
				body: { subscriptionId: "sub_plan", plan: "pro_plus" },
				adapter,
			});
			await expect(handler(ctx)).resolves.toMatchObject({ reused: true });
			expect(mockClient.updateSubscription).not.toHaveBeenCalled();
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				pendingPlan: "pro_plus",
				pendingPlanEffectiveAt: new Date("2026-05-01T00:00:00Z"),
			});
		});

		it("uses changePlan for a quantity-only change without inventing a pending plan", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN], mockClient);
			const handler = unwrapHandler<{ mode: string; plan: string; seats: number }>(
				plugin.endpoints.changeSubscriptionPlan,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_same_plan",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_same_plan",
					items: [{ product_id: "prod_basic", quantity: 2 }],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_same_plan",
					items: [{ product_id: "prod_basic", quantity: 2 }],
					pending_change: {
						id: "pending_same_plan",
						effective_at: "2026-05-01T00:00:00Z",
						target_items: [{ product_id: "prod_basic", quantity: 5 }],
					},
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_same_plan", plan: "basic", seats: 5 },
			});
			await expect(handler(ctx)).resolves.toMatchObject({
				mode: "at_period_end",
				plan: "basic",
				seats: 5,
			});
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				plan: "basic",
				seats: 2,
				pendingPlan: null,
				pendingProductId: null,
				pendingSeats: 5,
			});
		});

		it("requires an explicit compatible quantity when the next plan excludes current seats", async () => {
			const boundedPlan: StreamPayPlan = {
				...PRO_PLUS_PLAN,
				seatBilling: { minimum: 5, maximum: 20 },
			};
			const plugin = buildSubsPlugin([BASIC_PLAN, boundedPlan], mockClient);
			const handler = unwrapHandler(plugin.endpoints.changeSubscriptionPlan);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_incompatible_quantity",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_incompatible_quantity",
					items: [{ product_id: "prod_basic", quantity: 2 }],
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_incompatible_quantity", plan: "pro_plus" },
			});
			await expect(handler(ctx)).rejects.toMatchObject({
				code: "BAD_REQUEST",
				errorCode: "SUBSCRIPTION_SEAT_COUNT_INVALID",
			});
			expect(mockClient.updateSubscription).not.toHaveBeenCalled();
		});

		it("rejects a different target while a plan change is pending", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.changeSubscriptionPlan);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					status: "active",
					streampaySubscriptionId: "sub_plan",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_plan",
					pending_change: {
						id: "pending_other",
						target_items: [{ product_id: "prod_other", quantity: 1 }],
					},
				}),
			);

			const { ctx } = setupCtx({
				body: { subscriptionId: "sub_plan", plan: "pro_plus" },
				adapter,
			});
			await expect(handler(ctx)).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "SUBSCRIPTION_PLAN_CHANGE_ALREADY_SCHEDULED",
			});
		});

		it("schedules a billing interval change through the typed StreamPay update contract", async () => {
			const annualPlan: StreamPayPlan = {
				...PRO_PLUS_PLAN,
				name: "annual",
				productId: "prod_annual",
				billingInterval: "YEAR",
			};
			const plugin = buildSubsPlugin([BASIC_PLAN, annualPlan], mockClient);
			const handler = unwrapHandler(plugin.endpoints.changeSubscriptionPlan);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					status: "active",
					streampaySubscriptionId: "sub_plan",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_plan",
					recurring_interval: "MONTH",
					recurring_interval_count: 1,
					items: [{ product_id: "prod_basic", quantity: 1 }],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_plan",
					recurring_interval: "MONTH",
					items: [{ product_id: "prod_basic", quantity: 1 }],
					pending_change: {
						id: "pending_annual",
						effective_at: "2026-08-01T00:00:00Z",
						target_items: [{ product_id: "prod_annual", quantity: 1 }],
					},
				}),
			);
			const { ctx } = setupCtx({
				body: { subscriptionId: "sub_plan", plan: "annual" },
				adapter,
			});

			await expect(handler(ctx)).resolves.toMatchObject({
				mode: "at_period_end",
				plan: "annual",
			});
			expect(mockClient.updateSubscription).toHaveBeenCalledWith("sub_plan", {
				items: [{ product_id: "prod_annual", quantity: 1 }],
				coupons: [],
				recurring_interval: "YEAR",
				recurring_interval_count: 1,
			});
		});

		it("uses the provider-authoritative plan and quantity after an immediate change", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler<{ mode: string; plan: string; seats: number }>(
				plugin.endpoints.changeSubscriptionPlan,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_immediate_plan",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_immediate_plan",
					items: [{ product_id: "prod_basic", quantity: 2 }],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_immediate_plan",
					items: [{ product_id: "prod_pro_plus", quantity: 7 }],
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_immediate_plan", plan: "pro_plus", seats: 8 },
			});
			await expect(handler(ctx)).resolves.toMatchObject({
				mode: "immediate",
				plan: "pro_plus",
				seats: 7,
			});
			expect(mockClient.updateSubscription).toHaveBeenCalledWith(
				"sub_immediate_plan",
				expect.objectContaining({
					items: [{ product_id: "prod_pro_plus", quantity: 8 }],
				}),
			);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				plan: "pro_plus",
				seats: 7,
				pendingPlan: null,
				pendingSeats: null,
			});
		});

		it("rejects changing a subscription into a different plan group", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.changeSubscriptionPlan);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					status: "active",
					streampaySubscriptionId: "sub_plan",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_plan",
					items: [{ product_id: "prod_basic", quantity: 1 }],
				}),
			);

			const { ctx } = setupCtx({
				body: { subscriptionId: "sub_plan", plan: "pro" },
				adapter,
			});
			await expect(handler(ctx)).rejects.toMatchObject({
				errorCode: "SUBSCRIPTION_PLAN_GROUP_MISMATCH",
			});
			expect(mockClient.getSubscription).toHaveBeenCalledWith("sub_plan");
		});

		it("rejects a plan change while cancellation is scheduled", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.changeSubscriptionPlan);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					status: "active",
					streampaySubscriptionId: "sub_canceling",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_canceling",
					cancel_at_period_end: true,
					items: [{ product_id: "prod_basic", quantity: 1 }],
				}),
			);

			const { ctx } = setupCtx({
				body: { subscriptionId: "sub_canceling", plan: "pro_plus" },
				adapter,
			});
			await expect(handler(ctx)).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "SUBSCRIPTION_ALREADY_SCHEDULED_CANCEL",
			});
			expect(mockClient.updateSubscription).not.toHaveBeenCalled();
		});
	});

	describe("updateSubscriptionSeats", () => {
		it("schedules a deferred seat change and keeps every unrelated item and coupon", async () => {
			const plugin = buildSubsPlugin(
				[{ ...PRO_PLAN, seatBilling: { minimum: 1, maximum: 100 } }],
				mockClient,
			);
			const handler = unwrapHandler<{ mode: string; seats: number; reused: boolean }>(
				plugin.endpoints.updateSubscriptionSeats,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_seats",
					plan: "pro",
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_seats",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_seats",
					coupon_calculation_metadata: { coupons: [{ coupon_id: "coupon_subscription" }] },
					items: [
						{
							product_id: "prod_pro",
							quantity: 2,
							coupon_calculation_metadata: {
								coupons: [{ coupon_id: "coupon_subscription" }, { coupon_id: "coupon_item" }],
							},
						},
						{ product_id: "prod_addon", quantity: 4 },
					],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_seats",
					items: [
						{ product_id: "prod_pro", quantity: 2 },
						{ product_id: "prod_addon", quantity: 4 },
					],
					pending_change: {
						id: "pending_seats",
						effective_at: "2026-05-01T00:00:00Z",
						target_items: [
							{ product_id: "prod_pro", quantity: 5 },
							{ product_id: "prod_addon", quantity: 4 },
						],
					},
				}),
			);
			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "row_seats", seats: 5 },
			});

			await expect(handler(ctx)).resolves.toMatchObject({
				mode: "at_period_end",
				seats: 5,
				reused: false,
			});
			expect(mockClient.updateSubscription).toHaveBeenCalledWith("sub_seats", {
				items: [
					{ product_id: "prod_pro", quantity: 5, coupons: ["coupon_item"] },
					{ product_id: "prod_addon", quantity: 4 },
				],
				coupons: ["coupon_subscription"],
			});
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				seats: 2,
				pendingPlan: null,
				pendingProductId: null,
				pendingSeats: 5,
				pendingSeatsEffectiveAt: new Date("2026-05-01T00:00:00Z"),
			});
		});

		it("is idempotent when the requested seat count is already current", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ mode: string; reused: boolean }>(
				plugin.endpoints.updateSubscriptionSeats,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					seats: 4,
					status: "active",
					streampaySubscriptionId: "sub_current_seats",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_current_seats",
					items: [{ product_id: "prod_pro", quantity: 4 }],
				}),
			);
			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_current_seats", seats: 4 },
			});

			await expect(handler(ctx)).resolves.toMatchObject({ mode: "current", reused: true });
			expect(mockClient.updateSubscription).not.toHaveBeenCalled();
		});

		it("rejects a seat change while cancellation is scheduled", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.updateSubscriptionSeats);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_canceling_seats",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_canceling_seats",
					cancel_at_period_end: true,
					items: [{ product_id: "prod_pro", quantity: 2 }],
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_canceling_seats", seats: 3 },
			});
			await expect(handler(ctx)).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "SUBSCRIPTION_ALREADY_SCHEDULED_CANCEL",
			});
			expect(mockClient.updateSubscription).not.toHaveBeenCalled();
		});

		it("uses the provider-authoritative target when a deferred response differs", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ mode: string; seats: number }>(
				plugin.endpoints.updateSubscriptionSeats,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_provider_target",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_provider_target",
					items: [{ product_id: "prod_pro", quantity: 2 }],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_provider_target",
					items: [{ product_id: "prod_pro", quantity: 2 }],
					pending_change: {
						id: "pending_provider_target",
						effective_at: "2026-05-01T00:00:00Z",
						target_items: [{ product_id: "prod_pro", quantity: 6 }],
					},
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_provider_target", seats: 5 },
			});
			await expect(handler(ctx)).resolves.toMatchObject({ mode: "at_period_end", seats: 6 });
			expect(mockClient.updateSubscription).toHaveBeenCalledWith(
				"sub_provider_target",
				expect.objectContaining({ items: [{ product_id: "prod_pro", quantity: 5 }] }),
			);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({ seats: 2, pendingSeats: 6 });
		});

		it("applies an immediate provider quantity authoritatively", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ mode: string; seats: number; reused: boolean }>(
				plugin.endpoints.updateSubscriptionSeats,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_immediate_seats",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_immediate_seats",
					items: [{ product_id: "prod_pro", quantity: 2 }],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_immediate_seats",
					items: [{ product_id: "prod_pro", quantity: 4 }],
					amount: "495.000",
					amount_in_smallest_unit: 49_500,
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_immediate_seats", seats: 5 },
			});

			await expect(handler(ctx)).resolves.toMatchObject({
				mode: "immediate",
				seats: 4,
				reused: false,
			});
			expect(mockClient.updateSubscription).toHaveBeenCalledWith(
				"sub_immediate_seats",
				expect.objectContaining({
					items: [{ product_id: "prod_pro", quantity: 5 }],
				}),
			);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				seats: 4,
				amountInSmallestUnit: 49_500,
				pendingSeats: null,
				pendingSeatsEffectiveAt: null,
			});
		});

		it("finds the configured plan item when an add-on is first", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.updateSubscriptionSeats);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					seats: 3,
					status: "active",
					streampaySubscriptionId: "sub_addon_first",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_addon_first",
					items: [
						{ product_id: "prod_addon", quantity: 2 },
						{ product_id: "prod_pro", quantity: 3 },
					],
				}),
			);
			mockClient.updateSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_addon_first",
					items: [
						{ product_id: "prod_addon", quantity: 2 },
						{ product_id: "prod_pro", quantity: 3 },
					],
					pending_change: {
						id: "pending_addon_first",
						effective_at: "2026-05-01T00:00:00Z",
						target_items: [
							{ product_id: "prod_addon", quantity: 2 },
							{ product_id: "prod_pro", quantity: 6 },
						],
					},
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_addon_first", seats: 6 },
			});
			await handler(ctx);

			expect(mockClient.updateSubscription).toHaveBeenCalledWith("sub_addon_first", {
				items: [
					{ product_id: "prod_addon", quantity: 2 },
					{ product_id: "prod_pro", quantity: 6 },
				],
				coupons: [],
			});
		});

		it("rejects an update when the configured plan item is missing", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.updateSubscriptionSeats);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					seats: 3,
					status: "active",
					streampaySubscriptionId: "sub_missing_plan_item",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_missing_plan_item",
					items: [{ product_id: "prod_addon", quantity: 2 }],
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_missing_plan_item", seats: 6 },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				errorCode: "SUBSCRIPTION_INVALID_STATE",
			});
			expect(mockClient.updateSubscription).not.toHaveBeenCalled();
		});

		it("rejects ambiguous provider state containing multiple configured plan items", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.updateSubscriptionSeats);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					plan: "basic",
					group: "tier",
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_ambiguous_plans",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_ambiguous_plans",
					items: [
						{ product_id: "prod_basic", quantity: 2 },
						{ product_id: "prod_pro_plus", quantity: 2 },
					],
				}),
			);

			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_ambiguous_plans", seats: 3 },
			});
			await expect(handler(ctx)).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				errorCode: "SUBSCRIPTION_INVALID_STATE",
			});
			expect(mockClient.updateSubscription).not.toHaveBeenCalled();
		});

		it("rejects seat counts above the configured maximum before updating StreamPay", async () => {
			const plugin = buildSubsPlugin(
				[{ ...PRO_PLAN, seatBilling: { minimum: 2, maximum: 5 } }],
				mockClient,
			);
			const handler = unwrapHandler(plugin.endpoints.updateSubscriptionSeats);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					seats: 3,
					status: "active",
					streampaySubscriptionId: "sub_bounded_seats",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_bounded_seats",
					items: [{ product_id: "prod_pro", quantity: 3 }],
				}),
			);
			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "sub_bounded_seats", seats: 6 },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				code: "BAD_REQUEST",
				errorCode: "SUBSCRIPTION_SEAT_COUNT_INVALID",
			});
			expect(mockClient.updateSubscription).not.toHaveBeenCalled();
		});

		it("reuses the same pending seat target and rejects a different target", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ reused: boolean }>(plugin.endpoints.updateSubscriptionSeats);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					seats: 2,
					status: "active",
					streampaySubscriptionId: "sub_pending_seats",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_pending_seats",
					items: [{ product_id: "prod_pro", quantity: 2 }],
					pending_change: {
						id: "pending_seats",
						effective_at: "2026-05-01T00:00:00Z",
						target_items: [{ product_id: "prod_pro", quantity: 6 }],
					},
				}),
			);
			const same = setupCtx({
				adapter,
				body: { subscriptionId: "sub_pending_seats", seats: 6 },
			});
			await expect(handler(same.ctx)).resolves.toMatchObject({ reused: true, seats: 6 });
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				seats: 2,
				pendingSeats: 6,
				pendingPlan: null,
			});

			const different = setupCtx({
				adapter,
				body: { subscriptionId: "sub_pending_seats", seats: 7 },
			});
			await expect(handler(different.ctx)).rejects.toMatchObject({
				code: "CONFLICT",
				errorCode: "SUBSCRIPTION_SEAT_CHANGE_ALREADY_SCHEDULED",
			});
			expect(mockClient.updateSubscription).not.toHaveBeenCalled();
		});
	});

	describe("scheduled change reversal", () => {
		it("cancels a pending plan change and clears its local projection", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.cancelSubscriptionPlanChange);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_pending",
					status: "active",
					pendingPlan: "pro_plus",
					pendingPlanEffectiveAt: new Date("2026-05-01T00:00:00Z"),
					pendingSeats: 8,
					pendingSeatsEffectiveAt: new Date("2026-05-01T00:00:00Z"),
				}),
			});
			mockClient.getSubscription
				.mockResolvedValueOnce(
					createMockSubscription({
						id: "sub_pending",
						pending_change: {
							id: "pending_1",
							target_items: [{ product_id: "prod_pro", quantity: 8 }],
						},
					}),
				)
				.mockResolvedValueOnce(createMockSubscription({ id: "sub_pending" }));
			const { ctx } = setupCtx({ body: { subscriptionId: "sub_pending" }, adapter });

			await handler(ctx);
			expect(mockClient.deletePendingSubscriptionChange).toHaveBeenCalledWith("sub_pending");
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				pendingPlan: null,
				pendingPlanEffectiveAt: null,
				pendingSeats: null,
				pendingSeatsEffectiveAt: null,
			});
		});

		it("treats canceling an already-cleared pending change as an idempotent success", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ canceled: boolean; reused: boolean }>(
				plugin.endpoints.cancelSubscriptionPendingChange,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_no_pending",
					status: "active",
					pendingSeats: 9,
					pendingSeatsEffectiveAt: new Date("2026-05-01T00:00:00Z"),
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_no_pending",
					items: [{ product_id: "prod_pro", quantity: 3 }],
				}),
			);
			const { ctx } = setupCtx({ body: { subscriptionId: "sub_no_pending" }, adapter });

			await expect(handler(ctx)).resolves.toMatchObject({ canceled: true, reused: true });
			expect(mockClient.deletePendingSubscriptionChange).not.toHaveBeenCalled();
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				seats: 3,
				pendingSeats: null,
				pendingSeatsEffectiveAt: null,
			});
		});

		it("uncancels renewal and mirrors the provider state", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.uncancelSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_uncancel",
					status: "active",
					cancelAtPeriodEnd: true,
					cancelAt: new Date("2026-02-01T00:00:00.000Z"),
					cancelScheduledAt: new Date("2026-01-15T00:00:00.000Z"),
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({
					id: "sub_uncancel",
					status: "ACTIVE",
					cancel_at_period_end: false,
				}),
			);
			const { ctx } = setupCtx({ body: { subscriptionId: "sub_uncancel" }, adapter });

			await handler(ctx);
			expect(mockClient.uncancelSubscription).toHaveBeenCalledWith("sub_uncancel");
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				cancelAtPeriodEnd: false,
				cancelAt: null,
				cancelScheduledAt: null,
			});
		});
	});

	describe("freezeSubscription (stateful)", () => {
		it("freezes a sub and mirrors the upstream getSubscription state into the local row", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.freezeSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					streampaySubscriptionId: "sub_f",
					status: "active",
				}),
			});
			mockClient.freezeSubscription.mockResolvedValue({
				id: "freeze_1",
				freeze_start_datetime: "2026-02-01T00:00:00Z",
				freeze_end_datetime: "2026-03-01T00:00:00Z",
			});
			mockClient.getSubscription.mockResolvedValue({
				id: "sub_f",
				status: "FROZEN",
				latest_freeze: {
					freeze_start_datetime: "2026-02-01T00:00:00Z",
					freeze_end_datetime: "2026-03-01T00:00:00Z",
				},
			});

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_me" },
				body: {
					subscriptionId: "sub_f",
					freezeStartDatetime: "2026-02-01T00:00:00Z",
					freezeEndDatetime: "2026-03-01T00:00:00Z",
				},
				adapter,
			});
			await handler(ctx);

			expect(mockClient.freezeSubscription).toHaveBeenCalled();
			expect(mockClient.getSubscription).toHaveBeenCalledWith("sub_f");
			const row = getSubscriptionRows(adapter)[0];
			expect(row?.status).toBe("frozen");
			expect(row?.frozenAt).toBeInstanceOf(Date);
		});

		it("keeps status='active' for a future-dated freeze when upstream still reports ACTIVE", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.freezeSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					streampaySubscriptionId: "sub_future",
					status: "active",
				}),
			});
			const futureStart = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
			const futureEnd = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();
			mockClient.freezeSubscription.mockResolvedValue({
				id: "freeze_future",
				freeze_start_datetime: futureStart,
				freeze_end_datetime: futureEnd,
			});
			mockClient.getSubscription.mockResolvedValue({
				id: "sub_future",
				status: "ACTIVE",
				latest_freeze: {
					freeze_start_datetime: futureStart,
					freeze_end_datetime: futureEnd,
				},
			});

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_me" },
				body: {
					subscriptionId: "sub_future",
					freezeStartDatetime: futureStart,
					freezeEndDatetime: futureEnd,
				},
				adapter,
			});
			await handler(ctx);

			const row = getSubscriptionRows(adapter)[0];
			expect(row?.status).toBe("active");
			expect(row?.frozenAt).toBeNull();
			expect(row?.freezeEndAt).toBeNull();
		});
	});

	describe("unfreezeSubscription", () => {
		it("unfreezes by ending the active freeze early via updateSubscriptionFreeze", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.unfreezeSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					streampaySubscriptionId: "sub_uf",
					status: "frozen",
				}),
			});
			const startIso = new Date(Date.now() - 60_000).toISOString().replace(/Z$/, "");
			const futureIso = new Date(Date.now() + 60_000).toISOString().replace(/Z$/, "");
			mockClient.listSubscriptionFreezes.mockResolvedValue({
				data: [
					{
						id: "freeze_live",
						freeze_start_datetime: startIso,
						freeze_end_datetime: futureIso,
					},
				],
				pagination: {
					total_count: 1,
					current_page: 1,
					limit: 100,
					max_page: 1,
					has_next_page: false,
					has_previous_page: false,
				},
			});
			mockClient.updateSubscriptionFreeze.mockResolvedValue({
				id: "freeze_live",
				freeze_start_datetime: startIso,
				freeze_end_datetime: new Date().toISOString(),
			});
			mockClient.getSubscription.mockResolvedValue({
				id: "sub_uf",
				status: "ACTIVE",
			});

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_me" },
				body: { subscriptionId: "sub_uf" },
				adapter,
			});
			await handler(ctx);

			expect(mockClient.updateSubscriptionFreeze).toHaveBeenCalledWith(
				"sub_uf",
				"freeze_live",
				expect.objectContaining({
					freeze_start_datetime: startIso,
					freeze_end_datetime: expect.any(String),
				}),
			);
			const row = getSubscriptionRows(adapter)[0];
			expect(row?.status).toBe("active");
			expect(row?.frozenAt).toBeNull();
			expect(row?.freezeEndAt).toBeNull();
		});

		it("rejects when no active freeze period exists on StreamPay", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.unfreezeSubscription);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					streampaySubscriptionId: "sub_uf",
					status: "frozen",
				}),
			});
			mockClient.listSubscriptionFreezes.mockResolvedValue({
				data: [],
				pagination: {
					total_count: 0,
					current_page: 1,
					limit: 100,
					max_page: 1,
					has_next_page: false,
					has_previous_page: false,
				},
			});
			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_me" },
				body: { subscriptionId: "sub_uf" },
				adapter,
			});
			await expect(handler(ctx)).rejects.toMatchObject({
				errorCode: "SUBSCRIPTION_FREEZE_NOT_ACTIVE",
			});
		});

		it("cancels a scheduled freeze by id and reconciles the subscription", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.cancelSubscriptionFreeze);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_future_freeze",
					streampaySubscriptionId: "sub_future_freeze",
					status: "active",
				}),
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({ id: "sub_future_freeze", status: "ACTIVE" }),
			);
			mockClient.listSubscriptionFreezes.mockResolvedValue({
				data: [{ id: "freeze_future", freeze_start_datetime: "2026-08-01T00:00:00Z" }],
				pagination: {
					total_count: 1,
					current_page: 1,
					limit: 100,
					max_page: 1,
					has_next_page: false,
					has_previous_page: false,
				},
			});

			const { ctx } = setupCtx({
				body: { subscriptionId: "row_future_freeze", freezeId: "freeze_future" },
				adapter,
			});
			await expect(handler(ctx)).resolves.toEqual({
				canceled: true,
				freezeId: "freeze_future",
				reused: false,
			});
			expect(mockClient.deleteSubscriptionFreeze).toHaveBeenCalledWith(
				"sub_future_freeze",
				"freeze_future",
			);
			expect(mockClient.getSubscription).toHaveBeenCalledWith("sub_future_freeze");
		});

		it("treats StreamPay's retained canceled-freeze tombstone as an idempotent replay", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.cancelSubscriptionFreeze);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_tombstone",
					streampaySubscriptionId: "sub_tombstone",
					status: "active",
				}),
			});
			mockClient.listSubscriptionFreezes.mockResolvedValue({
				data: [{ id: "freeze_tombstone", freeze_start_datetime: "2026-08-01T00:00:00Z" }],
			});
			mockClient.deleteSubscriptionFreeze.mockRejectedValue(
				mockApiError(403, {
					error: {
						code: "STREAM_ERROR",
						message: "Something wrong happened, please contact support.",
						additional_info: "Cannot delete non-latest freeze entry.",
					},
				}),
			);
			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "row_tombstone", freezeId: "freeze_tombstone" },
			});

			await expect(handler(ctx)).resolves.toEqual({
				canceled: true,
				freezeId: "freeze_tombstone",
				reused: true,
			});
			expect(ctx.context.logger.info).toHaveBeenCalledWith(
				expect.stringContaining("provider tombstone"),
			);
		});

		it("does not hide unrelated provider authorization failures while canceling a freeze", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.cancelSubscriptionFreeze);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_forbidden_freeze",
					streampaySubscriptionId: "sub_forbidden_freeze",
				}),
			});
			mockClient.listSubscriptionFreezes.mockResolvedValue({
				data: [{ id: "freeze_forbidden", freeze_start_datetime: "2026-08-01T00:00:00Z" }],
			});
			mockClient.deleteSubscriptionFreeze.mockRejectedValue(
				mockApiError(403, {
					error: { code: "STREAM_ERROR", additional_info: "Insufficient permissions." },
				}),
			);
			const { ctx } = setupCtx({
				adapter,
				body: { subscriptionId: "row_forbidden_freeze", freezeId: "freeze_forbidden" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
		});
	});

	describe("upgradeSubscriptionForReference (server-only)", () => {
		function serverCtx(overrides: Parameters<typeof setupCtx>[0]) {
			const { ctx, adapter } = setupCtx(overrides);
			(ctx.context as { session?: unknown }).session = undefined;
			return { ctx, adapter };
		}

		it("has no HTTP route", () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const endpoint = plugin.endpoints.upgradeSubscriptionForReference as {
				path?: string;
			};
			expect(endpoint.path).toBeUndefined();
		});

		it("bills the referenced user's consumer without a session", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_srv", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");

			const adapter = createMockAdapter();
			adapter.tables.user = [
				{ id: "user-other", email: "other@example.com", streampayConsumerId: "cons_other" },
			];

			const { ctx } = serverCtx({
				adapter,
				body: { plan: "pro", referenceId: "user-other", referenceType: "user" },
			});

			await expect(handler(ctx)).resolves.toBeDefined();
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ organization_consumer_id: "cons_other" }),
			);
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				referenceId: "user-other",
				referenceType: "user",
				streampayConsumerId: "cons_other",
			});
		});

		it("does not consult authorizeReference", async () => {
			const authorizeReference = vi.fn().mockResolvedValue(false);
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient, { authorizeReference });
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_srv2", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");

			const adapter = createMockAdapter();
			adapter.tables.user = [
				{ id: "user-other", email: "other@example.com", streampayConsumerId: "cons_other" },
			];

			const { ctx } = serverCtx({
				adapter,
				body: { plan: "pro", referenceId: "user-other", referenceType: "user" },
			});

			await expect(handler(ctx)).resolves.toBeDefined();
			expect(authorizeReference).not.toHaveBeenCalled();
		});

		it("bills an organization reference", async () => {
			const plugin = buildSubsPlugin(
				[PRO_PLAN],
				mockClient,
				{},
				{ organization: { enabled: true } },
			);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_srv3", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");

			const adapter = createMockAdapter();
			adapter.tables.organization = [
				{ id: "org-1", name: "Acme Inc", streampayConsumerId: "cons_org" },
			];

			const { ctx } = serverCtx({
				adapter,
				body: { plan: "pro", referenceId: "org-1", referenceType: "organization" },
			});

			await expect(handler(ctx)).resolves.toBeDefined();
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ organization_consumer_id: "cons_org" }),
			);
		});

		it("still rejects a referenced user that does not exist", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			const { ctx } = serverCtx({
				body: { plan: "pro", referenceId: "user-ghost", referenceType: "user" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				errorCode: "SUBSCRIPTION_REFERENCE_USER_NOT_FOUND",
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("rejects an anonymous referenced user", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			const adapter = createMockAdapter();
			adapter.tables.user = [{ id: "user-anon", email: "anon@example.com", isAnonymous: true }];

			const { ctx } = serverCtx({
				adapter,
				body: { plan: "pro", referenceId: "user-anon", referenceType: "user" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				errorCode: "SUBSCRIPTION_REFERENCE_USER_NOT_BILLABLE",
			});
		});

		it("provisions a consumer for the referenced user when they have none", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_prov", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");
			mockClient.listConsumers.mockResolvedValue({ data: [], pagination: {} });
			mockClient.createConsumer.mockResolvedValue({ id: "cons_new" });

			const adapter = createMockAdapter();
			adapter.tables.user = [
				{ id: "user-other", email: "other@example.com", streampayConsumerId: null },
			];

			const { ctx } = serverCtx({
				adapter,
				body: { plan: "pro", referenceId: "user-other", referenceType: "user" },
			});

			await expect(handler(ctx)).resolves.toBeDefined();
			expect(mockClient.createConsumer).toHaveBeenCalledWith(
				expect.objectContaining({ external_id: "user-other", email: "other@example.com" }),
			);
			expect(ctx.context.internalAdapter.updateUser).toHaveBeenCalledWith("user-other", {
				streampayConsumerId: "cons_new",
			});
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ organization_consumer_id: "cons_new" }),
			);
		});

		it("rejects organization references when org billing is not enabled", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			const { ctx } = serverCtx({
				body: { plan: "pro", referenceId: "org-1", referenceType: "organization" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				errorCode: "SUBSCRIPTION_ORG_BILLING_NOT_ENABLED",
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("rejects an organization reference that does not exist", async () => {
			const plugin = buildSubsPlugin(
				[PRO_PLAN],
				mockClient,
				{},
				{
					organization: { enabled: true },
				},
			);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			const { ctx } = serverCtx({
				body: { plan: "pro", referenceId: "org-ghost", referenceType: "organization" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({ errorCode: "ORG_NOT_FOUND" });
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("provisions the organization's own consumer and stores it on the org row", async () => {
			const plugin = buildSubsPlugin(
				[PRO_PLAN],
				mockClient,
				{},
				{
					organization: { enabled: true },
				},
			);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_org", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");
			mockClient.listConsumers.mockResolvedValue({ data: [], pagination: {} });
			mockClient.createConsumer.mockResolvedValue({ id: "cons_org" });

			const adapter = createMockAdapter();
			adapter.tables.organization = [{ id: "org-1", name: "Acme Inc" }];

			const { ctx } = serverCtx({
				adapter,
				body: { plan: "pro", referenceId: "org-1", referenceType: "organization" },
			});

			await expect(handler(ctx)).resolves.toBeDefined();
			expect(mockClient.createConsumer).toHaveBeenCalledWith({
				consumer_type: "INDIVIDUAL",
				name: "Acme Inc",
				external_id: "ref:organization:org-1",
			});
			expect(mockClient.createPaymentLink).toHaveBeenCalledWith(
				expect.objectContaining({ organization_consumer_id: "cons_org" }),
			);
			expect(adapter.tables.organization[0]).toMatchObject({
				streampayConsumerId: "cons_org",
			});
			expect(getSubscriptionRows(adapter)[0]).toMatchObject({
				referenceId: "org-1",
				referenceType: "organization",
				streampayConsumerId: "cons_org",
			});
		});

		it("maps a contact-less consumer rejection to BILLING_CONTACT_REQUIRED", async () => {
			const plugin = buildSubsPlugin(
				[PRO_PLAN],
				mockClient,
				{},
				{
					organization: { enabled: true },
				},
			);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			mockClient.listConsumers.mockResolvedValue({ data: [], pagination: {} });
			mockClient.createConsumer.mockRejectedValue(
				mockApiError(422, { code: "INVALID_PARAMETERS", message: "email required" }),
			);

			const adapter = createMockAdapter();
			adapter.tables.organization = [{ id: "org-1", name: "Acme Inc" }];

			const { ctx } = serverCtx({
				adapter,
				body: { plan: "pro", referenceId: "org-1", referenceType: "organization" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				errorCode: "BILLING_CONTACT_REQUIRED",
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("applies getBillingDetails overrides but keeps identity fields plugin-owned", async () => {
			const getBillingDetails = vi.fn().mockResolvedValue({
				phone_number: "+966500000000",
				name: "clobbered",
				external_id: "clobbered",
			});
			const plugin = buildSubsPlugin(
				[PRO_PLAN],
				mockClient,
				{},
				{
					organization: { enabled: true, getBillingDetails },
				},
			);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_org3", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");
			mockClient.listConsumers.mockResolvedValue({ data: [], pagination: {} });
			mockClient.createConsumer.mockResolvedValue({ id: "cons_org" });

			const adapter = createMockAdapter();
			adapter.tables.organization = [{ id: "org-1", name: "Acme Inc" }];

			const { ctx } = serverCtx({
				adapter,
				body: { plan: "pro", referenceId: "org-1", referenceType: "organization" },
			});

			await expect(handler(ctx)).resolves.toBeDefined();
			expect(mockClient.createConsumer).toHaveBeenCalledWith({
				consumer_type: "INDIVIDUAL",
				phone_number: "+966500000000",
				name: "Acme Inc",
				external_id: "ref:organization:org-1",
			});
		});

		it("refuses to link a recovered consumer already claimed by a user", async () => {
			const plugin = buildSubsPlugin(
				[PRO_PLAN],
				mockClient,
				{},
				{
					organization: { enabled: true },
				},
			);
			const handler = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);

			mockClient.listConsumers.mockResolvedValue({
				data: [{ id: "cons_shared", external_id: "ref:organization:org-1" }],
				pagination: {},
			});

			const adapter = createMockAdapter();
			adapter.tables.organization = [{ id: "org-1", name: "Acme Inc" }];
			adapter.tables.user = [{ id: "user-x", streampayConsumerId: "cons_shared" }];

			const { ctx } = serverCtx({
				adapter,
				body: { plan: "pro", referenceId: "org-1", referenceType: "organization" },
			});

			await expect(handler(ctx)).rejects.toMatchObject({
				errorCode: "STREAMPAY_CONSUMER_LINK_CONFLICT",
			});
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});
	});

	describe("listSubscriptions / currentSubscription", () => {
		it("a subscription bought via the server twin appears in the target user's own reads", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);

			mockClient.createPaymentLink.mockResolvedValue({ id: "pl_rt", url: "https://x" });
			mockClient.getPaymentUrl.mockReturnValue("https://x");

			const adapter = createMockAdapter();
			adapter.tables.user = [
				{ id: "user-other", email: "other@example.com", streampayConsumerId: "cons_other" },
			];

			const upgrade = unwrapHandler(plugin.endpoints.upgradeSubscriptionForReference);
			const { ctx: buyerCtx } = setupCtx({
				adapter,
				body: { plan: "pro", referenceId: "user-other", referenceType: "user" },
			});
			(buyerCtx.context as { session?: unknown }).session = undefined;
			await upgrade(buyerCtx);

			// The target reads with no query params - the twin writes referenceType "user",
			// so the subscription must show up in their own default reads.
			const list = unwrapHandler<Array<Record<string, unknown>>>(
				plugin.endpoints.listSubscriptions,
			);
			const { ctx: targetCtx } = setupCtx({
				adapter,
				user: { id: "user-other", streampayConsumerId: "cons_other" },
			});

			const result = await list(targetCtx);
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({ referenceId: "user-other", referenceType: "user" });
		});

		it("listSubscriptions returns rows scoped to user.id with plan info", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN, BASIC_PLAN], mockClient);
			const handler = unwrapHandler<Array<Record<string, unknown>>>(
				plugin.endpoints.listSubscriptions,
			);

			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "pro",
					streampaySubscriptionId: "sub_a",
					status: "active",
				}),
			});
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-456",
					plan: "basic",
					streampaySubscriptionId: "sub_b",
					status: "active",
				}),
			});

			const { ctx } = setupCtx({ adapter });
			const result = await handler(ctx);
			expect(result).toHaveLength(1);
			expect(result[0]?.referenceId).toBe("user-123");
			expect((result[0]?.plan as { name?: string })?.name).toBe("pro");
		});

		it("presents a legacy null seat count as one until the application backfills it", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<Array<Record<string, unknown>>>(
				plugin.endpoints.listSubscriptions,
			);
			const adapter = createMockAdapter();
			const legacy = createMockSubscriptionRow({
				referenceId: "user-123",
				plan: "pro",
				status: "active",
			});
			Object.assign(legacy, { seats: null });
			await adapter.create({ model: "subscription", data: legacy });

			const { ctx } = setupCtx({ adapter });
			const result = await handler(ctx);

			expect(result[0]?.seats).toBe(1);
		});

		it("lists an organization reference only after explicit read authorization", async () => {
			const authorizeReference = vi.fn().mockResolvedValue(true);
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient, { authorizeReference });
			const handler = unwrapHandler<Array<Record<string, unknown>>>(
				plugin.endpoints.listSubscriptions,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "org-123",
					referenceType: "organization",
					status: "active",
				}),
			});
			const { ctx } = setupCtx({
				adapter,
				query: { referenceId: "org-123", referenceType: "organization" },
			});

			const result = await handler(ctx);

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				referenceId: "org-123",
				referenceType: "organization",
			});
			expect(authorizeReference).toHaveBeenCalledWith(
				expect.objectContaining({
					referenceId: "org-123",
					referenceType: "organization",
					action: "read",
				}),
				expect.anything(),
			);
		});

		it("currentSubscription returns null when no live sub exists", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler(plugin.endpoints.currentSubscription);
			const { ctx } = setupCtx({});
			const result = await handler(ctx);
			expect(result).toBeNull();
		});

		it("currentSubscription returns the active row filtered by group", async () => {
			const plugin = buildSubsPlugin([BASIC_PLAN, PRO_PLUS_PLAN], mockClient);
			const handler = unwrapHandler<Record<string, unknown> | null>(
				plugin.endpoints.currentSubscription,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "basic",
					group: "tier",
					streampaySubscriptionId: "sub_b",
					status: "active",
				}),
			});
			const { ctx } = setupCtx({ adapter, query: { group: "tier" } });
			const result = await handler(ctx);
			expect(result?.plan).toMatchObject({ name: "basic" });
		});

		it("currentSubscription defaults to the ungrouped plan when other groups are active", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN, BASIC_PLAN], mockClient);
			const handler = unwrapHandler<Record<string, unknown> | null>(
				plugin.endpoints.currentSubscription,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "basic",
					group: "tier",
					streampaySubscriptionId: "sub_grouped",
					status: "active",
				}),
			});
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "pro",
					group: null,
					streampaySubscriptionId: "sub_default",
					status: "active",
				}),
			});
			const { ctx } = setupCtx({ adapter });

			const result = await handler(ctx);

			expect(result?.streampaySubscriptionId).toBe("sub_default");
			expect(result?.plan).toMatchObject({ name: "pro" });
		});
	});

	describe("hasSubscriptionFeature / checkSubscriptionLimit", () => {
		const TEAM_PLAN: StreamPayPlan = {
			name: "team",
			productId: "prod_team",
			priceInSmallestUnit: 19900,
			billingInterval: "MONTH",
			limits: { seats: 10, workspaces: true },
		};

		it("hasSubscriptionFeature returns true for an active plan declaring the feature", async () => {
			const plugin = buildSubsPlugin([TEAM_PLAN], mockClient);
			const handler = unwrapHandler<{ hasFeature: boolean }>(
				plugin.endpoints.hasSubscriptionFeature,
			);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "team",
					streampaySubscriptionId: "sub_team",
					status: "active",
				}),
			});
			const { ctx } = setupCtx({ adapter, query: { feature: "workspaces" } });
			const result = await handler(ctx);
			expect(result.hasFeature).toBe(true);
		});

		it("checkSubscriptionLimit enforces numeric quotas", async () => {
			const plugin = buildSubsPlugin([TEAM_PLAN], mockClient);
			const handler = unwrapHandler<{
				allowed: boolean;
				limit: number;
				remaining: number;
			}>(plugin.endpoints.checkSubscriptionLimit);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "user-123",
					plan: "team",
					streampaySubscriptionId: "sub_team",
					status: "active",
				}),
			});
			const { ctx } = setupCtx({ adapter, query: { feature: "seats", count: 4 } });
			const result = await handler(ctx);
			expect(result).toEqual({ allowed: true, limit: 10, remaining: 6 });
		});
	});

	describe("subscriptionSuccess fallback sync", () => {
		it("is a no-op when the row is already active", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ synced: boolean }>(plugin.endpoints.subscriptionSuccess);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_s",
					referenceId: "user-123",
					streampaySubscriptionId: "sub_s",
					status: "active",
				}),
			});
			const { ctx } = setupCtx({
				adapter,
				query: { subscriptionId: "row_s" },
			});
			const result = await handler(ctx);
			expect(result.synced).toBe(false);
			expect(mockClient.listSubscriptions).not.toHaveBeenCalled();
		});

		it("links only the subscription whose items contain the plan's product", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{
				subscription: { streampaySubscriptionId: string | null; status: string };
				synced: boolean;
			}>(plugin.endpoints.subscriptionSuccess);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_inc",
					referenceId: "user-123",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_1",
				}),
			});

			mockClient.listSubscriptions.mockResolvedValue({
				data: [
					createMockSubscription({
						id: "sub_other",
						organization_consumer_id: "cons_1",
						items: [{ product_id: "prod_unrelated" }],
					}),
					createMockSubscription({
						id: "sub_pro",
						organization_consumer_id: "cons_1",
						items: [{ product_id: "prod_pro" }],
					}),
				],
			});

			const { ctx } = setupCtx({ adapter, query: { subscriptionId: "row_inc" } });
			const result = await handler(ctx);

			expect(result.synced).toBe(true);
			expect(result.subscription.streampaySubscriptionId).toBe("sub_pro");
			expect(result.subscription.status).toBe("active");
		});

		it("filters by consumer and follows pagination during fallback reconciliation", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ synced: boolean }>(plugin.endpoints.subscriptionSuccess);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_paged",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_paged",
				}),
			});
			mockClient.listSubscriptions
				.mockResolvedValueOnce({
					data: [],
					pagination: { current_page: 1, max_page: 2, has_next_page: true },
				})
				.mockResolvedValueOnce({
					data: [
						createMockSubscription({
							id: "sub_page_2",
							organization_consumer_id: "cons_paged",
							items: [{ product_id: "prod_pro", quantity: 1 }],
						}),
					],
					pagination: { current_page: 2, max_page: 2, has_next_page: false },
				});

			const { ctx } = setupCtx({ adapter, query: { subscriptionId: "row_paged" } });
			await expect(handler(ctx)).resolves.toMatchObject({ synced: true });
			expect(mockClient.listSubscriptions).toHaveBeenNthCalledWith(1, {
				page: 1,
				size: 100,
				organization_consumer_id: "cons_paged",
			});
			expect(mockClient.listSubscriptions).toHaveBeenNthCalledWith(2, {
				page: 2,
				size: 100,
				organization_consumer_id: "cons_paged",
			});
		});

		it("does not attach an older checkout for the same consumer and product", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ synced: boolean }>(plugin.endpoints.subscriptionSuccess);
			const adapter = createMockAdapter();
			const checkoutCreatedAt = new Date("2026-07-10T12:00:00.000Z");
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_recent_checkout",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_repeat",
					streampayPaymentLinkId: "pl_new",
					createdAt: checkoutCreatedAt,
				}),
			});
			mockClient.listSubscriptions.mockResolvedValue({
				data: [
					createMockSubscription({
						id: "sub_old",
						organization_consumer_id: "cons_repeat",
						created_at: "2026-07-01T12:00:00.000Z",
						items: [{ product_id: "prod_pro" }],
					}),
				],
			});

			const { ctx } = setupCtx({
				adapter,
				query: { subscriptionId: "row_recent_checkout" },
			});
			await expect(handler(ctx)).resolves.toMatchObject({ synced: false });
			expect(getSubscriptionRows(adapter)[0]?.streampaySubscriptionId).toBeNull();
		});

		it("rejects a candidate whose invoice belongs to a different payment link", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ synced: boolean }>(plugin.endpoints.subscriptionSuccess);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_link_match",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_repeat",
					streampayPaymentLinkId: "pl_expected",
				}),
			});
			mockClient.listSubscriptions.mockResolvedValue({
				data: [
					createMockSubscription({
						id: "sub_other_link",
						organization_consumer_id: "cons_repeat",
						items: [{ product_id: "prod_pro" }],
						latest_invoice: { payment_link_id: "pl_other", currency: "SAR" },
					}),
				],
			});

			const { ctx } = setupCtx({ adapter, query: { subscriptionId: "row_link_match" } });
			await expect(handler(ctx)).resolves.toMatchObject({ synced: false });
		});

		it("reconciles a legacy timestamp-less row only by exact payment-link correlation", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ synced: boolean }>(plugin.endpoints.subscriptionSuccess);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_legacy_timestamp",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_legacy",
					streampayPaymentLinkId: "pl_exact",
				}),
			});
			const legacyRow = adapter.tables.subscription?.[0];
			if (legacyRow) legacyRow.createdAt = null;
			mockClient.listSubscriptions.mockResolvedValue({
				data: [
					createMockSubscription({
						id: "sub_exact",
						organization_consumer_id: "cons_legacy",
						items: [{ product_id: "prod_pro" }],
						latest_invoice: { payment_link_id: "pl_exact", currency: "SAR" },
					}),
				],
			});

			const { ctx } = setupCtx({
				adapter,
				query: { subscriptionId: "row_legacy_timestamp" },
			});
			await expect(handler(ctx)).resolves.toMatchObject({ synced: true });
			expect(getSubscriptionRows(adapter)[0]?.streampaySubscriptionId).toBe("sub_exact");
		});

		it("does not link when no subscription carries the plan's product", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ synced: boolean }>(plugin.endpoints.subscriptionSuccess);
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_inc",
					referenceId: "user-123",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_1",
				}),
			});
			mockClient.listSubscriptions.mockResolvedValue({
				data: [
					createMockSubscription({
						id: "sub_other",
						organization_consumer_id: "cons_1",
						items: [{ product_id: "prod_unrelated" }],
					}),
				],
			});

			const { ctx } = setupCtx({ adapter, query: { subscriptionId: "row_inc" } });
			const result = await handler(ctx);

			expect(result.synced).toBe(false);
			const rows = getSubscriptionRows(adapter);
			expect(rows[0]?.streampaySubscriptionId).toBeNull();
			expect(rows[0]?.status).toBe("incomplete");
		});
	});

	describe("schema contribution", () => {
		it("replays a stored dead-letter event through an exclusive lease", async () => {
			const registry: StreamPayPluginRegistry = {};
			subscriptions({ plans: [PRO_PLAN] })(
				createTestStreamPayOptions({ client: mockClient }),
				registry,
			);
			const replay = registry.replayWebhookEvent;
			if (!replay) throw new Error("expected replay registry");

			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sp_replay",
					status: "active",
				}),
			});
			await adapter.create({
				model: "streampayWebhookEvent",
				data: {
					eventId: "event-replay",
					eventType: "SUBSCRIPTION_ACTIVATED",
					status: "dead_letter",
					attemptCount: 2,
					receivedAt: new Date(),
					lockedAt: null,
					lockedBy: null,
					rawPayload: JSON.stringify({
						event_type: "SUBSCRIPTION_ACTIVATED",
						entity_type: "SUBSCRIPTION",
						entity_id: "sp_replay",
						entity_url: "https://api.example/subscriptions/sp_replay",
						status: "ACTIVE",
						timestamp: "2026-01-01T00:00:00.000Z",
						data: {},
					}),
				},
			});
			mockClient.getSubscription.mockResolvedValue(
				createMockSubscription({ id: "sp_replay", status: "ACTIVE" }),
			);
			const { ctx } = setupCtx({ adapter });

			await expect(
				replay(ctx as unknown as Parameters<typeof replay>[0], "event-replay"),
			).resolves.toEqual({
				replayed: true,
				eventId: "event-replay",
			});
			expect(adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
				status: "completed",
				attemptCount: 3,
				lockedAt: null,
				lockedBy: null,
				rawPayload: null,
			});
		});

		it("rejects malformed stored replay JSON as a controlled bad request", async () => {
			const registry: StreamPayPluginRegistry = {};
			subscriptions({ plans: [PRO_PLAN] })(
				createTestStreamPayOptions({ client: mockClient }),
				registry,
			);
			const replay = registry.replayWebhookEvent;
			if (!replay) throw new Error("expected replay registry");
			const adapter = createMockAdapter();
			await adapter.create({
				model: "streampayWebhookEvent",
				data: {
					eventId: "event-malformed",
					eventType: "SUBSCRIPTION_ACTIVATED",
					status: "dead_letter",
					attemptCount: 1,
					receivedAt: new Date(),
					lockedAt: null,
					lockedBy: null,
					rawPayload: "{",
				},
			});
			const { ctx } = setupCtx({ adapter });

			await expect(
				replay(ctx as unknown as Parameters<typeof replay>[0], "event-malformed"),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("exposes the `subscription` + `streampayWebhookEvent` tables", () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			expect(plugin.endpoints.updateSubscriptionSeats?.path).toBe("/subscription/update-seats");
			expect(plugin.endpoints.cancelSubscriptionPendingChange?.path).toBe(
				"/subscription/pending-change/cancel",
			);
			expect(plugin.schema).toBeDefined();
			expect(plugin.schema).toHaveProperty("subscription");
			expect(plugin.schema).toHaveProperty("streampayWebhookEvent");
			expect(plugin.schema).toHaveProperty("subscription.fields.createdAt");
			expect(plugin.schema).toHaveProperty("subscription.fields.updatedAt");
			expect(plugin.schema).toHaveProperty("subscription.fields.activeSlotKey.unique", true);
			expect(plugin.schema).toHaveProperty(
				"subscription.fields.streampaySubscriptionId.unique",
				true,
			);
			expect(plugin.schema).toHaveProperty(
				"subscription.fields.streampayPaymentLinkId.unique",
				true,
			);
			expect(plugin.schema).toHaveProperty("subscription.fields.providerStatus");
			expect(plugin.schema).toHaveProperty("subscription.fields.billingStatus");
			expect(plugin.schema).toHaveProperty("subscription.fields.seats.defaultValue", 1);
			expect(plugin.schema).toHaveProperty("subscription.fields.pendingSeats");
			expect(plugin.schema).toHaveProperty("subscription.fields.pendingSeatsEffectiveAt");
			expect(plugin.schema).toHaveProperty("streampayWebhookEvent.fields.lockedBy");
			expect(plugin.schema).toHaveProperty("streampayWebhookEvent.fields.nextAttemptAt");
			expect(plugin.schema).not.toHaveProperty("subscription.fields.checkoutUrl");
		});

		it("dead-letters permanent webhook failures and rethrows transient failures", async () => {
			const registry: StreamPayPluginRegistry = {};
			subscriptions({ plans: [PRO_PLAN] })(
				createTestStreamPayOptions({ client: mockClient }),
				registry,
			);
			const sync = registry.subscriptionWebhookSync;
			if (!sync) throw new Error("expected subscription webhook sync registry");

			const permanentAdapter = createMockAdapter();
			const { ctx: permanentCtx } = setupCtx({ adapter: permanentAdapter });
			const permanentPayload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_permanent_failure",
				timestamp: "2026-07-10T18:00:00.000Z",
			});
			mockClient.getSubscription.mockRejectedValueOnce(
				mockApiError(400, { error: { code: "INVALID_SUBSCRIPTION" } }),
			);

			await expect(
				sync(permanentCtx as unknown as Parameters<typeof sync>[0], permanentPayload, {
					rawBody: "permanent-raw-body",
					signatureHeader: "t=1,v1=permanent",
				}),
			).resolves.toBeUndefined();
			expect(permanentAdapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
				status: "dead_letter",
				rawPayload: "permanent-raw-body",
				signatureHeader: "t=1,v1=permanent",
			});

			const transientAdapter = createMockAdapter();
			const { ctx: transientCtx } = setupCtx({ adapter: transientAdapter });
			const transientPayload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_transient_failure",
				timestamp: "2026-07-10T18:01:00.000Z",
			});
			mockClient.getSubscription.mockRejectedValueOnce(
				mockApiError(503, { error: { code: "UPSTREAM_UNAVAILABLE" } }),
			);

			await expect(
				sync(transientCtx as unknown as Parameters<typeof sync>[0], transientPayload),
			).rejects.toBeDefined();
			expect(transientAdapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
				status: "pending",
				attemptCount: 1,
			});
		});

		it("omits the streampayWebhookEvent table when enableWebhookEventTable=false", () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient, {
				enableWebhookEventTable: false,
			});
			expect(plugin.schema).toBeDefined();
			expect(plugin.schema).toHaveProperty("subscription");
			expect(plugin.schema).not.toHaveProperty("streampayWebhookEvent");
		});

		it("rejects construction when `plans` is missing", () => {
			expect(() => subscriptions({} as Parameters<typeof subscriptions>[0])).toThrow();
		});

		it("rejects construction when `plans` is an empty array", () => {
			expect(() => subscriptions({ plans: [] })).toThrow(/at least one plan/);
		});

		it("rejects invalid retry counts and access statuses at construction", () => {
			expect(() => subscriptions({ plans: [PRO_PLAN], maxWebhookAttempts: 0 })).toThrow(
				/positive integer/,
			);
			expect(() =>
				subscriptions({ plans: [PRO_PLAN], accessStatuses: ["unknown" as never] }),
			).toThrow(/invalid access status/);
		});
	});
});
