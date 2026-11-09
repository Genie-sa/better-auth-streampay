import { describe, expect, it } from "vitest";
import { subscriptions, webhooks } from "../../src";
import {
	harness,
	providerSubscription,
	SECRET,
	subscriptionEvent,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

describe(`cancellation schedule end-to-end (${TEST_WITH})`, () => {
	describe("out-of-order webhooks", () => {
		it("stamps cancelScheduledAt when another event saw the cancellation first", async () => {
			const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
			h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_c", "ACTIVE"));
			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_c", "2026-01-01T00:00:00.000Z"),
			);
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_c", "ACTIVE", {
					cancel_at_period_end: true,
					current_period_end: "2026-02-01T00:00:00Z",
				}),
			);
			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_PLAN_UPDATED", "sub_c", "2026-01-10T00:00:00.000Z"),
			);

			await h.deliver(
				subscriptionEvent(
					h,
					"SUBSCRIPTION_CANCEL_AT_PERIOD_END",
					"sub_c",
					"2026-01-09T00:00:00.000Z",
				),
			);

			const [row] = await h.rows("subscription");
			expect(row?.cancelAtPeriodEnd).toBe(true);
			expect(new Date(String(row?.cancelScheduledAt)).toISOString()).toBe(
				"2026-01-09T00:00:00.000Z",
			);
		});
	});
});
