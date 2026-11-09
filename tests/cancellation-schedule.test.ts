import { describe, expect, it } from "vitest";
import { syncWebhookPayload } from "../src/plugins/subscriptions/sync";
import { subscriptionSlotKey } from "../src/plugins/subscriptions/types";
import { createMockStreamPayClient } from "./utils/mocks";
import {
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

describe("cancellation schedule stamping", () => {
	it("stamps cancelScheduledAt when the cancel event follows a webhook that already saw the flag", async () => {
		const client = createMockStreamPayClient();
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				status: "active",
				activeSlotKey: SLOT,
				streampaySubscriptionId: "sub_cancel",
			}),
		});
		client.getSubscription.mockResolvedValue({
			id: "sub_cancel",
			status: "ACTIVE",
			cancel_at_period_end: true,
			current_period_end: "2026-02-01T00:00:00Z",
			organization_consumer_id: "cons_mocked",
			items: [{ product_id: PLAN.productId, quantity: 1 }],
		} as never);

		await syncWebhookPayload(
			ctx,
			createMockWebhookPayload({
				event_type: "SUBSCRIPTION_PLAN_UPDATED",
				entity_id: "sub_cancel",
				timestamp: "2026-01-10T00:00:00.000Z",
			}),
			client,
			PLANS,
			{},
		);
		await syncWebhookPayload(
			ctx,
			createMockWebhookPayload({
				event_type: "SUBSCRIPTION_CANCEL_AT_PERIOD_END",
				entity_id: "sub_cancel",
				timestamp: "2026-01-09T00:00:00.000Z",
			}),
			client,
			PLANS,
			{},
		);

		expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
			cancelAtPeriodEnd: true,
			cancelScheduledAt: new Date("2026-01-09T00:00:00.000Z"),
		});
	});
});
