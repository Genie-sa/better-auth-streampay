import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-auth/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("better-auth/api")>()),
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import { buildSubscriptionEndpoints } from "../src/plugins/subscriptions/endpoints";
import { syncWebhookPayload } from "../src/plugins/subscriptions/sync";
import {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	REFERENCE_TYPE_METADATA_KEY,
	SUBSCRIPTION_ROW_ID_METADATA_KEY,
	subscriptionSlotKey,
	UPGRADE_IDEMPOTENCY_WINDOW_MS,
} from "../src/plugins/subscriptions/types";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
import {
	createMockContext,
	createMockStreamPayClient,
	type MockedStreamPayClient,
} from "./utils/mocks";
import {
	createMockAdapter,
	createMockSubscriptionRow,
	createMockSyncContext,
	createMockWebhookPayload,
} from "./utils/subscription-helpers";

const PLAN = {
	name: "pro",
	productId: "prod_pro",
	priceInSmallestUnit: 9900,
	billingInterval: "MONTH" as const,
};
const PLANS = { list: [PLAN], byName: new Map([[PLAN.name, PLAN]]) };
const SLOT = subscriptionSlotKey("user", "user-123", null);

type MockSyncContext = ReturnType<
	typeof createMockSyncContext<ReturnType<typeof createMockAdapter>>
>;

function checkoutMetadata(rowId: string) {
	return {
		metadata: {
			[PLAN_NAME_METADATA_KEY]: PLAN.name,
			[REFERENCE_ID_METADATA_KEY]: "user-123",
			[REFERENCE_TYPE_METADATA_KEY]: "user",
			[SUBSCRIPTION_ROW_ID_METADATA_KEY]: rowId,
		},
	};
}

function upgradeHarness(client: MockedStreamPayClient) {
	const adapter = createMockAdapter();
	const endpoints = buildSubscriptionEndpoints(
		createTestStreamPayOptions({ client }),
		{ plans: [PLAN] },
		async () => PLANS,
	);
	const ctx = createMockContext({ body: { plan: PLAN.name } });
	ctx.context.adapter = adapter;
	adapter.tables.user = [{ ...ctx.context.session.user }];
	return { adapter, ctx, upgrade: () => unwrapHandler(endpoints.upgradeSubscription)(ctx) };
}

describe("checkout reservation release", () => {
	let client: MockedStreamPayClient;

	beforeEach(() => {
		client = createMockStreamPayClient();
		client.createPaymentLink.mockResolvedValue({ id: "pl_new" });
		client.getPaymentUrl.mockReturnValue("https://checkout.example.test/new");
	});

	async function seedStaleReservation(adapter: ReturnType<typeof createMockAdapter>) {
		await adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "row_stale",
				status: "incomplete",
				activeSlotKey: SLOT,
				seats: 3,
				streampayPaymentLinkId: "pl_stale",
				createdAt: new Date(Date.now() - UPGRADE_IDEMPOTENCY_WINDOW_MS - 1),
			}),
		});
	}

	it("deactivates a stale reservation's still-payable link before replacing it", async () => {
		const { adapter, upgrade } = upgradeHarness(client);
		await seedStaleReservation(adapter);
		client.updatePaymentLinkStatus.mockResolvedValue({ id: "pl_stale" });

		await expect(upgrade()).resolves.toMatchObject({ reused: false });

		expect(client.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_stale", {
			status: "INACTIVE",
		});
		expect(adapter.tables.subscription?.find((row) => row.id === "row_stale")).toMatchObject({
			status: "incomplete_expired",
			activeSlotKey: null,
		});
	});

	it("keeps the stale reservation when its link cannot be deactivated", async () => {
		const { adapter, upgrade } = upgradeHarness(client);
		await seedStaleReservation(adapter);
		client.updatePaymentLinkStatus.mockRejectedValue(mockApiError(503, { message: "down" }));

		await expect(upgrade()).rejects.toMatchObject({ statusCode: 500 });

		expect(client.createPaymentLink).not.toHaveBeenCalled();
		expect(adapter.tables.subscription).toHaveLength(1);
		expect(adapter.tables.subscription?.[0]).toMatchObject({
			status: "incomplete",
			activeSlotKey: SLOT,
		});
	});

	it("deactivates the new link when its reservation is released during link creation", async () => {
		const { adapter, upgrade } = upgradeHarness(client);
		client.createPaymentLink.mockImplementation(async () => {
			const reserved = adapter.tables.subscription?.[0];
			if (reserved) Object.assign(reserved, { status: "incomplete_expired", activeSlotKey: null });
			return { id: "pl_orphan" };
		});
		client.updatePaymentLinkStatus.mockResolvedValue({ id: "pl_orphan" });

		await expect(upgrade()).rejects.toMatchObject({
			body: { code: "SUBSCRIPTION_CHECKOUT_IN_PROGRESS" },
		});
		expect(client.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_orphan", {
			status: "INACTIVE",
		});
	});

	it("reports an existing subscription when a live row takes the slot after the active check", async () => {
		const { adapter, upgrade } = upgradeHarness(client);
		const findMany = adapter.findMany.bind(adapter);
		adapter.findMany = async (args) => {
			const rows = await findMany(args);
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_activated_concurrently",
					status: "active",
					activeSlotKey: SLOT,
					streampaySubscriptionId: "sub_concurrent",
				}),
			});
			return rows as never;
		};

		await expect(upgrade()).rejects.toMatchObject({
			body: { code: "SUBSCRIPTION_ALREADY_ACTIVE" },
		});
		expect(client.createPaymentLink).not.toHaveBeenCalled();
	});
});

describe("subscription slot ownership", () => {
	let client: MockedStreamPayClient;

	beforeEach(() => {
		client = createMockStreamPayClient();
	});

	it("gives the slot to a paid checkout whose reservation was replaced by an unpaid one", async () => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "row_released",
				status: "incomplete_expired",
				activeSlotKey: null,
				streampayPaymentLinkId: "pl_old",
			}),
		});
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "row_replacement",
				status: "incomplete",
				activeSlotKey: SLOT,
				streampayPaymentLinkId: "pl_new",
			}),
		});
		client.getSubscription.mockResolvedValue({
			id: "sub_paid_old_link",
			status: "ACTIVE",
			organization_consumer_id: "cons_mocked",
			items: [{ product_id: PLAN.productId, quantity: 1 }],
			latest_invoice: { payment_link_id: "pl_old" },
		} as never);
		client.updatePaymentLinkStatus.mockResolvedValue({ id: "pl_new" });

		await syncWebhookPayload(
			ctx,
			createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_paid_old_link",
				data: checkoutMetadata("row_released"),
			}),
			client,
			PLANS,
			{},
		);

		const rows = ctx.adapter.tables.subscription ?? [];
		expect(rows.find((row) => row.id === "row_released")).toMatchObject({
			status: "active",
			activeSlotKey: SLOT,
			streampaySubscriptionId: "sub_paid_old_link",
		});
		expect(rows.find((row) => row.id === "row_replacement")).toMatchObject({
			status: "incomplete_expired",
			activeSlotKey: null,
		});
		expect(client.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_new", { status: "INACTIVE" });
		expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({ status: "completed" });
	});

	async function seedReplacedCheckout(
		ctx: MockSyncContext,
		replacement: Parameters<typeof createMockSubscriptionRow>[0] = {},
	) {
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "row_released",
				status: "incomplete_expired",
				activeSlotKey: null,
				streampayPaymentLinkId: "pl_old",
			}),
		});
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "row_replacement",
				status: "incomplete",
				activeSlotKey: SLOT,
				streampayPaymentLinkId: "pl_new",
				...replacement,
			}),
		});
		client.getSubscription.mockResolvedValue({
			id: "sub_paid_old_link",
			status: "ACTIVE",
			organization_consumer_id: "cons_mocked",
			items: [{ product_id: PLAN.productId, quantity: 1 }],
			latest_invoice: { payment_link_id: "pl_old" },
		} as never);
	}

	function deliverPaidOldLink(ctx: MockSyncContext) {
		return syncWebhookPayload(
			ctx,
			createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_paid_old_link",
				data: checkoutMetadata("row_released"),
			}),
			client,
			PLANS,
			{},
		);
	}

	function row(ctx: MockSyncContext, id: string) {
		return ctx.adapter.tables.subscription?.find((candidate) => candidate.id === id);
	}

	it("activates the paid checkout even when the replacement link cannot be deactivated", async () => {
		const ctx = createMockSyncContext();
		await seedReplacedCheckout(ctx);
		client.updatePaymentLinkStatus.mockRejectedValue(mockApiError(400, { message: "rejected" }));

		await deliverPaidOldLink(ctx);

		expect(row(ctx, "row_released")).toMatchObject({ status: "active", activeSlotKey: SLOT });
		expect(row(ctx, "row_replacement")).toMatchObject({ status: "incomplete_expired" });
		expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({ status: "completed" });
		expect(ctx.logs.error).toContainEqual(expect.stringContaining("deactivate it manually"));
	});

	it("treats a reservation already linked to a StreamPay subscription as live", async () => {
		const ctx = createMockSyncContext();
		await seedReplacedCheckout(ctx, { streampaySubscriptionId: "sub_unknown_status" });

		await expect(deliverPaidOldLink(ctx)).rejects.toMatchObject({
			name: "SubscriptionCorrelationError",
		});

		expect(row(ctx, "row_replacement")).toMatchObject({
			status: "incomplete",
			activeSlotKey: SLOT,
		});
		expect(client.updatePaymentLinkStatus).not.toHaveBeenCalled();
	});

	it("retries instead of releasing a reservation whose link was persisted mid-takeover", async () => {
		const ctx = createMockSyncContext();
		await seedReplacedCheckout(ctx, { streampayPaymentLinkId: null });
		const findOne = ctx.adapter.findOne.bind(ctx.adapter);
		ctx.adapter.findOne = async <T>(args: Parameters<typeof findOne>[0]): Promise<T | null> => {
			const found = await findOne<Record<string, unknown>>(args);
			if (!found || !args.where.some((clause) => clause.field === "activeSlotKey")) {
				return found as T | null;
			}
			const snapshot = { ...found };
			found.streampayPaymentLinkId = "pl_persisted";
			return snapshot as T;
		};

		await expect(deliverPaidOldLink(ctx)).rejects.toThrow(/changed while releasing/);

		expect(row(ctx, "row_replacement")).toMatchObject({
			status: "incomplete",
			activeSlotKey: SLOT,
			streampayPaymentLinkId: "pl_persisted",
		});
		expect(row(ctx, "row_released")).toMatchObject({ status: "incomplete_expired" });
		expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({ status: "pending" });
	});

	it("leaves the replacement reservation alone when StreamPay returns stale state", async () => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "row_canceled",
				status: "canceled",
				activeSlotKey: null,
				streampaySubscriptionId: "sub_old",
				providerUpdatedAt: new Date("2026-02-01T00:00:00Z"),
			}),
		});
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "row_replacement",
				status: "incomplete",
				activeSlotKey: SLOT,
				streampayPaymentLinkId: "pl_new",
			}),
		});
		client.getSubscription.mockResolvedValue({
			id: "sub_old",
			status: "ACTIVE",
			updated_at: "2026-01-01T00:00:00Z",
			organization_consumer_id: "cons_mocked",
			items: [{ product_id: PLAN.productId, quantity: 1 }],
		} as never);

		await expect(
			syncWebhookPayload(
				ctx,
				createMockWebhookPayload({ event_type: "SUBSCRIPTION_ACTIVATED", entity_id: "sub_old" }),
				client,
				PLANS,
				{},
			),
		).rejects.toThrow(/stale subscription state/);

		expect(row(ctx, "row_replacement")).toMatchObject({
			status: "incomplete",
			activeSlotKey: SLOT,
		});
		expect(client.updatePaymentLinkStatus).not.toHaveBeenCalled();
	});

	it("dead-letters a revived subscription when another live subscription owns its slot", async () => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "row_revived",
				status: "inactive",
				activeSlotKey: null,
				streampaySubscriptionId: "sub_revived",
			}),
		});
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "row_live",
				status: "active",
				activeSlotKey: SLOT,
				streampaySubscriptionId: "sub_live",
			}),
		});
		client.getSubscription.mockResolvedValue({
			id: "sub_revived",
			status: "ACTIVE",
			organization_consumer_id: "cons_mocked",
			items: [{ product_id: PLAN.productId, quantity: 1 }],
		} as never);

		await expect(
			syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_ACTIVATED",
					entity_id: "sub_revived",
				}),
				client,
				PLANS,
				{},
			),
		).rejects.toMatchObject({ name: "SubscriptionCorrelationError" });

		expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
			status: "dead_letter",
			lastErrorCode: "SubscriptionCorrelationError",
		});
		expect(ctx.adapter.tables.subscription?.find((row) => row.id === "row_live")).toMatchObject({
			status: "active",
			activeSlotKey: SLOT,
		});
	});
});
