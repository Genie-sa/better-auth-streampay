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
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import {
	type StreamPayPlan,
	subscriptions,
	UPGRADE_IDEMPOTENCY_WINDOW_MS,
} from "../src/plugins/subscriptions";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions } from "./utils/helpers";
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
} from "./utils/subscription-helpers";

const PRO_PLAN: StreamPayPlan = {
	name: "pro",
	productId: "prod_pro",
	priceHalalat: 9900,
	billingInterval: "MONTH",
};
const PRO_PLUS_PLAN: StreamPayPlan = {
	name: "pro_plus",
	productId: "prod_pro_plus",
	priceHalalat: 19900,
	billingInterval: "MONTH",
	group: "tier",
};
const BASIC_PLAN: StreamPayPlan = {
	name: "basic",
	productId: "prod_basic",
	priceHalalat: 2900,
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
): {
	endpoints: Record<string, { path: string; config: unknown; handler: unknown }>;
	schema?: unknown;
} {
	return subscriptions({ plans, ...opts })(
		createTestStreamPayOptions({ client: mockClient }),
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
			expect(row?.amountHalalat).toBe(9900);
			expect(row?.streampayConsumerId).toBe("cons_linked");

			const paymentLinkArgs = mockClient.createPaymentLink.mock.calls[0]?.[0];
			expect(paymentLinkArgs?.custom_metadata).toMatchObject({
				streampay_plugin_plan_name: "pro",
				streampay_plugin_reference_id: "user-123",
			});
		});

		it("returns the existing incomplete row within the 15-minute idempotency window", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{
				subscriptionId: string;
				reused: boolean;
				status: string;
			}>(plugin.endpoints.upgradeSubscription);

			const adapter = createMockAdapter();
			const existing = (await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_existing",
					referenceId: "user-123",
					plan: "pro",
					status: "incomplete",
					createdAt: new Date(Date.now() - 60 * 1000),
				}),
			})) as { id: string };

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_linked" },
				body: { plan: "pro" },
				adapter,
			});

			const result = await handler(ctx);
			expect(result.subscriptionId).toBe(existing.id);
			expect(result.reused).toBe(true);
			expect(mockClient.createPaymentLink).not.toHaveBeenCalled();
		});

		it("does not reuse rows older than the idempotency window", async () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			const handler = unwrapHandler<{ reused: boolean }>(
				plugin.endpoints.upgradeSubscription,
			);

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
			const GROUP_B: StreamPayPlan = { ...PRO_PLAN, name: "plan_b", group: "group_b" };
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

		it("honors authorizeReference returning true", async () => {
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
				expect.objectContaining({ referenceId: "user-other", action: "upgrade" }),
				expect.anything(),
			);
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

			mockClient.cancelSubscription.mockResolvedValue(createMockSubscription({ id: "sub_c" }));
			mockClient.getSubscription.mockResolvedValue({
				id: "sub_c",
				status: "CANCELED",
				ended_at: "2026-04-25T10:00:00Z",
			});

			const { ctx } = setupCtx({
				user: { streampayConsumerId: "cons_me" },
				body: { subscriptionId: "sub_c" },
				adapter,
			});
			await handler(ctx);

			expect(mockClient.cancelSubscription).toHaveBeenCalledWith("sub_c", {
				cancel_related_invoices: false,
			});
			expect(mockClient.getSubscription).toHaveBeenCalledWith("sub_c");
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
			const startIso = new Date(Date.now() - 60_000).toISOString();
			const futureIso = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
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

			// Plugin ends a freeze early by PUT'ing freeze_end_datetime=now
			// (StreamPay returns 403 on DELETE of an active freeze).
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
				errorCode: "SUBSCRIPTION_NOT_FROZEN",
			});
		});
	});

	describe("listSubscriptions / currentSubscription", () => {
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
	});

	describe("hasSubscriptionFeature / checkSubscriptionLimit", () => {
		const TEAM_PLAN: StreamPayPlan = {
			name: "team",
			productId: "prod_team",
			priceHalalat: 19900,
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

	});

	describe("schema contribution", () => {
		it("exposes the `subscription` + `streampayWebhookEvent` tables", () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient);
			expect(plugin.schema).toBeDefined();
			expect(plugin.schema).toHaveProperty("subscription");
			expect(plugin.schema).toHaveProperty("streampayWebhookEvent");
		});

		it("omits the schema when enableSubscriptionTable=false", () => {
			const plugin = buildSubsPlugin([PRO_PLAN], mockClient, {
				enableSubscriptionTable: false,
			});
			expect(plugin.schema).toBeUndefined();
		});

		it("skips webhook auto-sync registration when enableSubscriptionTable=false", () => {
			const registry: Record<string, unknown> = {};
			subscriptions({ plans: [PRO_PLAN], enableSubscriptionTable: false })(
				createTestStreamPayOptions({ client: mockClient }),
				registry,
			);
			expect(registry.subscriptionWebhookSync).toBeUndefined();
		});

		it("registers webhook auto-sync by default", () => {
			const registry: Record<string, unknown> = {};
			subscriptions({ plans: [PRO_PLAN] })(
				createTestStreamPayOptions({ client: mockClient }),
				registry,
			);
			expect(typeof registry.subscriptionWebhookSync).toBe("function");
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
	});
});
