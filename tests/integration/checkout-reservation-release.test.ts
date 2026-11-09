import { describe, expect, it } from "vitest";
import { subscriptions, webhooks } from "../../src";
import {
	currentPlan,
	type Harness,
	harness,
	providerSubscription,
	SECRET,
	subscriptionEvent,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

async function startAbandonedThenReplacementCheckout(h: Harness) {
	expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
	const [abandoned] = await h.rows("subscription");
	if (!abandoned) throw new Error("Expected the first checkout reservation.");
	await h.setRow("subscription", String(abandoned.id), {
		createdAt: new Date(Date.now() - 16 * 60 * 1000),
	});
	expect((await h.upgrade({ plan: TEAM.name, seats: 2 })).status).toBe(200);
	return String(abandoned.id);
}

describe(`checkout reservation release end-to-end (${TEST_WITH})`, () => {
	describe("replaced checkout reservations", () => {
		it("deactivates the abandoned checkout link before issuing a replacement", async () => {
			const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);

			await startAbandonedThenReplacementCheckout(h);

			expect(h.stream.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_1", {
				status: "INACTIVE",
			});
		});

		it("grants access when the customer pays the abandoned checkout link", async () => {
			const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
			const abandonedRowId = await startAbandonedThenReplacementCheckout(h);
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_paid", "ACTIVE", { latest_invoice: { payment_link_id: "pl_1" } }),
			);

			const response = await h.deliver(
				subscriptionEvent(
					h,
					"SUBSCRIPTION_ACTIVATED",
					"sub_paid",
					"2026-01-01T00:00:00.000Z",
					abandonedRowId,
				),
			);

			expect(response.status).toBe(200);
			expect(await currentPlan(h)).toMatchObject({ id: abandonedRowId, status: "active" });
			const replacement = (await h.rows("subscription")).find((row) => row.id !== abandonedRowId);
			expect(replacement).toMatchObject({ status: "incomplete_expired", activeSlotKey: null });
			expect(h.stream.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_2", {
				status: "INACTIVE",
			});
			expect(await h.rows("streampayWebhookEvent")).toMatchObject([{ status: "completed" }]);
		});
	});

	describe("a revived subscription whose slot is taken", () => {
		it("dead-letters on the first delivery as a permanent correlation failure", async () => {
			const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
			h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_old", "ACTIVE"));
			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_old", "2026-01-01T00:00:00.000Z"),
			);
			h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_old", "INACTIVE"));
			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_INACTIVATED", "sub_old", "2026-01-02T00:00:00.000Z"),
			);
			h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_new", "ACTIVE"));
			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_new", "2026-01-03T00:00:00.000Z"),
			);
			h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_old", "ACTIVE"));

			const response = await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_old", "2026-01-04T00:00:00.000Z"),
			);

			expect(response.status).toBe(200);
			const events = await h.rows("streampayWebhookEvent");
			expect(
				events.find((event) => String(event.eventId).endsWith("2026-01-04T00:00:00.000Z")),
			).toMatchObject({
				status: "dead_letter",
				attemptCount: 1,
				lastErrorCode: "SubscriptionCorrelationError",
			});
			expect(await currentPlan(h)).toMatchObject({ streampaySubscriptionId: "sub_new" });
		});
	});

	describe("a checkout racing a concurrent activation", () => {
		it("reports the active subscription instead of a database error", async () => {
			let h: Harness | undefined;
			let activateDuringEligibility = false;
			h = await harness([
				subscriptions({
					plans: [{ ...TEAM, trialPeriodDays: 7 }],
					isTrialEligible: async () => {
						if (activateDuringEligibility && h) {
							activateDuringEligibility = false;
							const [reserved] = await h.rows("subscription");
							h.stream.getSubscription.mockResolvedValue(
								providerSubscription("sub_racing", "ACTIVE"),
							);
							await h.deliver(
								subscriptionEvent(
									h,
									"SUBSCRIPTION_ACTIVATED",
									"sub_racing",
									"2026-01-01T00:00:00.000Z",
									String(reserved?.id),
								),
							);
						}
						return true;
					},
				}),
				webhooks({ secret: SECRET }),
			]);
			expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
			activateDuringEligibility = true;

			const response = await h.upgrade({ plan: TEAM.name, seats: 2 });

			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: "SUBSCRIPTION_ALREADY_ACTIVE" });
		});
	});
});
