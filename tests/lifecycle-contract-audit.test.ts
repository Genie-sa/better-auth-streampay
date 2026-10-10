import { describe, expect, it, vi } from "vitest";

vi.mock("better-auth/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("better-auth/api")>()),
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import { buildSubscriptionEndpoints } from "../src/plugins/subscriptions/endpoints";
import { projectSubscriptionAgainstExisting } from "../src/plugins/subscriptions/reconcile";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions } from "./utils/helpers";
import { createMockContext, createMockStreamPayClient } from "./utils/mocks";
import { createMockAdapter, createMockSubscriptionRow } from "./utils/subscription-helpers";

const plan = {
	name: "pro",
	productId: "prod_pro",
	priceInSmallestUnit: 100,
	billingInterval: "MONTH" as const,
};

describe("subscription lifecycle contract audit", () => {
	it("does not expire an activated checkout when the provider omits its URL", async () => {
		const client = createMockStreamPayClient();
		const adapter = createMockAdapter();
		client.createPaymentLink.mockImplementation(async () => {
			const row = adapter.tables.subscription?.[0];
			if (!row) throw new Error("Expected a reserved checkout.");
			await adapter.update({
				model: "subscription",
				where: [{ field: "id", value: row.id }],
				update: { status: "active", streampaySubscriptionId: "sub_confirmed" },
			});
			return { id: "pl_created" };
		});
		client.getPaymentUrl.mockReturnValue(null);
		const endpoints = buildSubscriptionEndpoints(
			createTestStreamPayOptions({ client }),
			{ plans: [plan] },
			async () => ({ list: [plan], byName: new Map([[plan.name, plan]]) }),
		);
		const ctx = createMockContext({ body: { plan: "pro" } });
		ctx.context.adapter = adapter;
		await expect(unwrapHandler(endpoints.upgradeSubscription)(ctx)).rejects.toThrow(/no URL/);
		expect(adapter.tables.subscription?.[0]).toMatchObject({
			status: "active",
			streampaySubscriptionId: "sub_confirmed",
		});
		expect(adapter.tables.subscription?.[0]?.activeSlotKey).not.toBeNull();
	});

	it.each([
		null,
		"pl_other_confirmed",
	])("persists a checkout link after early activation without overwriting a different binding (%s)", async (priorLink) => {
		const client = createMockStreamPayClient();
		const adapter = createMockAdapter();
		client.createPaymentLink.mockImplementation(async () => {
			const row = adapter.tables.subscription?.[0];
			if (!row) throw new Error("Expected a reserved checkout.");
			await adapter.update({
				model: "subscription",
				where: [{ field: "id", value: row.id }],
				update: {
					status: "active",
					streampaySubscriptionId: "sub_confirmed",
					streampayPaymentLinkId: priorLink,
				},
			});
			return { id: "pl_created" };
		});
		client.getPaymentUrl.mockReturnValue("https://checkout.example.test/created");
		const endpoints = buildSubscriptionEndpoints(
			createTestStreamPayOptions({ client }),
			{ plans: [plan] },
			async () => ({ list: [plan], byName: new Map([[plan.name, plan]]) }),
		);
		const ctx = createMockContext({ body: { plan: "pro" } });
		ctx.context.adapter = adapter;
		await expect(unwrapHandler(endpoints.upgradeSubscription)(ctx)).resolves.toMatchObject({
			url: "https://checkout.example.test/created",
		});
		expect(adapter.tables.subscription?.[0]).toMatchObject({
			status: "active",
			streampayPaymentLinkId: priorLink ?? "pl_created",
		});
	});
	it("retains a newer cancellation when an accepted seat-change response finishes last", async () => {
		const client = createMockStreamPayClient();
		const adapter = createMockAdapter();
		await adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "owned_subscription",
				streampaySubscriptionId: "sub_owned",
				status: "active",
				providerUpdatedAt: new Date("2026-01-01T00:00:00Z"),
			}),
		});
		client.getSubscription.mockResolvedValue({
			id: "sub_owned",
			status: "ACTIVE",
			items: [{ product_id: plan.productId, quantity: 1 }],
		});
		client.updateSubscription.mockResolvedValue({
			id: "sub_owned",
			status: "ACTIVE",
			updated_at: "2026-02-01T00:00:00Z",
			items: [{ product_id: plan.productId, quantity: 1 }],
			pending_change: {
				target_items: [{ product_id: plan.productId, quantity: 2 }],
				effective_at: "2026-03-01T00:00:00Z",
			},
		});
		const update = adapter.update;
		let canceled = false;
		adapter.update = async (input) => {
			if (input.model === "subscription" && !canceled) {
				canceled = true;
				await update({
					model: "subscription",
					where: [{ field: "id", value: "owned_subscription" }],
					update: {
						status: "canceled",
						providerUpdatedAt: new Date("2026-03-01T00:00:00Z"),
						activeSlotKey: null,
						pendingSeats: null,
					},
				});
			}
			return update(input);
		};
		const endpoints = buildSubscriptionEndpoints(
			createTestStreamPayOptions({ client }),
			{ plans: [plan] },
			async () => ({ list: [plan], byName: new Map([[plan.name, plan]]) }),
		);
		const ctx = createMockContext({ body: { subscriptionId: "owned_subscription", seats: 2 } });
		ctx.context.adapter = adapter;
		await expect(unwrapHandler(endpoints.updateSubscriptionSeats)(ctx)).resolves.toMatchObject({
			mode: "at_period_end",
		});
		expect(adapter.tables.subscription?.[0]).toMatchObject({
			status: "canceled",
			activeSlotKey: null,
			pendingSeats: null,
			providerUpdatedAt: new Date("2026-03-01T00:00:00Z"),
		});
		expect(client.updateSubscription).toHaveBeenCalledTimes(1);
		expect(ctx.context.logger.warn).toHaveBeenCalled();
	});
	it("does not extend a freeze whose end is exactly the current instant", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
		try {
			const client = createMockStreamPayClient();
			const adapter = createMockAdapter();
			await adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "owned_subscription",
					streampaySubscriptionId: "sub_owned",
					status: "frozen",
				}),
			});
			client.listSubscriptionFreezes.mockResolvedValue({
				data: [
					{
						id: "freeze_ended",
						freeze_start_datetime: "2026-10-09T12:00:00Z",
						freeze_end_datetime: "2026-10-10T12:00:00Z",
					},
				],
			});
			const endpoints = buildSubscriptionEndpoints(
				createTestStreamPayOptions({ client }),
				{ plans: [plan] },
				async () => ({ list: [plan], byName: new Map([[plan.name, plan]]) }),
			);
			const ctx = createMockContext({ body: { subscriptionId: "owned_subscription" } });
			ctx.context.adapter = adapter;
			await expect(unwrapHandler(endpoints.unfreezeSubscription)(ctx)).rejects.toThrow(
				/No active freeze/,
			);
			expect(client.updateSubscriptionFreeze).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("accepts explicit RFC 3339 offsets for both freeze boundaries", () => {
		const endpoints = buildSubscriptionEndpoints(
			createTestStreamPayOptions(),
			{ plans: [plan] },
			async () => ({ list: [plan], byName: new Map([[plan.name, plan]]) }),
		);
		const schema = (
			endpoints.freezeSubscription as unknown as {
				config: { body: { safeParse: (input: unknown) => { success: boolean } } };
			}
		).config.body;
		expect(
			schema.safeParse({
				subscriptionId: "owned",
				freezeStartDatetime: "2026-10-11T12:00:00+03:00",
				freezeEndDatetime: "2026-10-12T12:00:00+03:00",
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({ subscriptionId: "owned", freezeStartDatetime: "2026-10-11T12:00:00" })
				.success,
		).toBe(false);
	});
	it("unfreezes the authoritative latest active freeze when it is beyond the SDK's first page", async () => {
		const client = createMockStreamPayClient();
		const adapter = createMockAdapter();
		await adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "owned_subscription",
				streampaySubscriptionId: "sub_owned",
				status: "frozen",
			}),
		});
		const active = {
			id: "freeze_latest",
			freeze_start_datetime: new Date(Date.now() - 60_000).toISOString(),
			freeze_end_datetime: null,
		};
		client.listSubscriptionFreezes.mockResolvedValue({
			data: [],
			pagination: {
				current_page: 1,
				max_page: 2,
				total_count: 11,
				limit: 10,
				has_next_page: true,
				has_previous_page: false,
			},
		});
		client.getSubscription
			.mockResolvedValueOnce({ id: "sub_owned", status: "FROZEN", latest_freeze: active })
			.mockResolvedValueOnce({ id: "sub_owned", status: "ACTIVE" });
		client.updateSubscriptionFreeze.mockResolvedValue(active);
		const endpoints = buildSubscriptionEndpoints(
			createTestStreamPayOptions({ client }),
			{ plans: [plan] },
			async () => ({ list: [plan], byName: new Map([[plan.name, plan]]) }),
		);
		const ctx = createMockContext({ body: { subscriptionId: "owned_subscription" } });
		ctx.context.adapter = adapter;
		await expect(unwrapHandler(endpoints.unfreezeSubscription)(ctx)).resolves.toEqual({
			unfrozen: true,
		});
		expect(client.updateSubscriptionFreeze).toHaveBeenCalledWith(
			"sub_owned",
			"freeze_latest",
			expect.objectContaining({
				freeze_start_datetime: active.freeze_start_datetime,
				freeze_end_datetime: expect.any(String),
			}),
		);
		expect(adapter.tables.subscription?.[0]?.status).toBe("active");
	});

	it("retains consumed trial history when a later provider snapshot omits trial_end", () => {
		const existing = createMockSubscriptionRow({
			status: "trialing",
			trialStart: new Date("2026-01-01T00:00:00Z"),
			trialEnd: new Date("2026-01-08T00:00:00Z"),
		});
		const projected = projectSubscriptionAgainstExisting(existing, {
			id: "sub_completed_trial",
			status: "CANCELED",
			trial_end: null,
		});
		expect({ ...existing, ...projected }).toMatchObject({
			trialStart: new Date("2026-01-01T00:00:00Z"),
		});
	});

	it("does not claim a freeze is already canceled when the provider list has unseen pages", async () => {
		const client = createMockStreamPayClient();
		const adapter = createMockAdapter();
		await adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "owned_subscription",
				streampaySubscriptionId: "sub_owned",
				status: "active",
			}),
		});
		client.listSubscriptionFreezes.mockResolvedValue({
			data: [
				{
					id: "freeze_old",
					freeze_start_datetime: "2026-01-01T00:00:00Z",
					freeze_end_datetime: "2026-01-02T00:00:00Z",
				},
			],
			pagination: {
				current_page: 1,
				max_page: 2,
				total_count: 11,
				limit: 10,
				has_next_page: true,
				has_previous_page: false,
			},
		});
		const endpoints = buildSubscriptionEndpoints(
			createTestStreamPayOptions({ client }),
			{ plans: [plan] },
			async () => ({ list: [plan], byName: new Map([[plan.name, plan]]) }),
		);
		const ctx = createMockContext({
			body: { subscriptionId: "owned_subscription", freezeId: "freeze_on_second_page" },
		});
		ctx.context.adapter = adapter;
		await expect(unwrapHandler(endpoints.cancelSubscriptionFreeze)(ctx)).rejects.toThrow();
	});
});
