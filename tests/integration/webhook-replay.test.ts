import { describe, expect, it, vi } from "vitest";
import { admin, subscriptions, webhooks } from "../../src";
import {
	currentPlan,
	harness,
	providerSubscription,
	replayWebhookEvent,
	SECRET,
	subscriptionEvent,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

describe(`webhook replay end-to-end (${TEST_WITH})`, () => {
	describe("manual replay", () => {
		it("a transient replay failure does not discard StreamPay's later redelivery", async () => {
			const h = await harness([
				subscriptions({ plans: [TEAM] }),
				webhooks({ secret: SECRET }),
				admin({ isAdmin: () => true }),
			]);
			const outage = Object.assign(new Error("unavailable"), { status: 503, body: {} });
			h.stream.getSubscription.mockRejectedValue(outage);
			const event = subscriptionEvent(
				h,
				"SUBSCRIPTION_ACTIVATED",
				"sub_outage",
				"2026-01-01T00:00:00.000Z",
			);
			const eventId = "SUBSCRIPTION_ACTIVATED:sub_outage:2026-01-01T00:00:00.000Z";
			expect((await h.deliver(event)).status).toBe(500);

			expect((await replayWebhookEvent(h, eventId)).status).toBe(500);
			expect(await h.rows("streampayWebhookEvent")).toMatchObject([{ status: "pending" }]);

			h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_outage", "ACTIVE"));
			expect((await h.deliver(event)).status).toBe(200);
			expect(await h.rows("streampayWebhookEvent")).toMatchObject([{ status: "completed" }]);
			expect(await currentPlan(h)).toMatchObject({ streampaySubscriptionId: "sub_outage" });
		});

		it("a failed callback replay does not discard StreamPay's later redelivery", async () => {
			const onPayload = vi.fn().mockRejectedValue(new Error("callback unavailable"));
			const h = await harness([
				webhooks({ secret: SECRET, deduplicate: true, onPayload }),
				admin({ isAdmin: () => true }),
			]);
			const event = {
				event_type: "FUTURE_EVENT",
				entity_type: "FUTURE_ENTITY",
				entity_id: "future",
				timestamp: "2026-01-01T00:00:00.000Z",
			};
			expect((await h.deliver(event)).status).toBe(500);

			expect(
				(await replayWebhookEvent(h, "handlers:FUTURE_EVENT:future:2026-01-01T00:00:00.000Z"))
					.status,
			).toBe(500);
			onPayload.mockResolvedValue(undefined);
			expect((await h.deliver(event)).status).toBe(200);

			expect(onPayload).toHaveBeenCalledTimes(3);
			expect(await h.rows("streampayWebhookEvent")).toMatchObject([{ status: "completed" }]);
		});

		it("replay honors retryOnCallbackError: false", async () => {
			const h = await harness([
				subscriptions({
					plans: [TEAM],
					retryOnCallbackError: false,
					onSubscriptionActivated: () => {
						throw new Error("application callback failed");
					},
				}),
				webhooks({ secret: SECRET }),
				admin({ isAdmin: () => true }),
			]);
			const outage = Object.assign(new Error("unavailable"), { status: 503, body: {} });
			h.stream.getSubscription.mockRejectedValueOnce(outage);
			const eventId = "SUBSCRIPTION_ACTIVATED:sub_cb:2026-01-01T00:00:00.000Z";
			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_cb", "2026-01-01T00:00:00.000Z"),
			);
			h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_cb", "ACTIVE"));

			expect((await replayWebhookEvent(h, eventId)).status).toBe(200);
			expect(await h.rows("streampayWebhookEvent")).toMatchObject([{ status: "completed" }]);
		});
	});
});
