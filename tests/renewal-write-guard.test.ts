import { describe, expect, it, vi } from "vitest";
import { syncWebhookPayload } from "../src/plugins/subscriptions/sync";
import { createMockStreamPayClient } from "./utils/mocks";
import {
	createMockSubscriptionRow,
	createMockSyncContext,
	createMockWebhookPayload,
} from "./utils/subscription-helpers";

const plans = { list: [], byName: new Map() };

describe("renewal evidence write guard (S7)", () => {
	it("retries instead of renewing a row whose consumer binding changed concurrently", async () => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "renewing_row",
				streampaySubscriptionId: "sub_renew",
				streampayConsumerId: "cons_before",
				status: "active",
				periodEnd: new Date("2026-02-01T00:00:00Z"),
				currentCycleNumber: 1,
			}),
		});
		const client = createMockStreamPayClient();
		client.getSubscription.mockResolvedValue({
			id: "sub_renew",
			status: "ACTIVE",
			current_period_end: "2026-03-01T00:00:00Z",
			current_cycle_number: 2,
			organization_consumer_id: "cons_before",
		});
		const update = ctx.adapter.update.bind(ctx.adapter);
		ctx.adapter.update = async (args) => {
			const renewalWrite = args.where.some((clause) => clause.field === "currentCycleNumber");
			const stored = ctx.adapter.tables.subscription?.[0];
			if (renewalWrite && stored) stored.streampayConsumerId = "cons_rebound";
			return update(args);
		};
		const onSubscriptionRenewed = vi.fn();

		await expect(
			syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
					entity_type: "SUBSCRIPTION",
					entity_id: "sub_renew",
				}),
				client,
				plans,
				{ onSubscriptionRenewed },
				{ dedupe: false },
			),
		).rejects.toThrow(/retry delivery/);

		expect(onSubscriptionRenewed).not.toHaveBeenCalled();
		expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
			currentCycleNumber: 1,
			streampayConsumerId: "cons_rebound",
		});
	});
});
