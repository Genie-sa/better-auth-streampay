import { describe, expect, it } from "vitest";
import { admin, subscriptions, webhooks } from "../../src";
import { callAuthEndpoint } from "../utils/auth-instance";
import {
	type Harness,
	harness,
	providerSubscription,
	type Row,
	SECRET,
	subscriptionEvent,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

const PERIOD_END = "2026-02-01T00:00:00.000Z";

async function activeSubscription(h: Harness): Promise<Row> {
	h.stream.getSubscription.mockResolvedValue(
		providerSubscription("sub_live", "ACTIVE", {
			current_period_end: PERIOD_END,
			updated_at: "2026-01-01T00:00:00.000Z",
		}),
	);
	expect(
		(
			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_live", "2026-01-01T00:00:00.000Z"),
			)
		).status,
	).toBe(200);
	const [row] = await h.rows("subscription");
	if (!row) throw new Error("Expected the activated subscription row.");
	return row;
}

function withPendingSeats(seats: number, extra: Row = {}) {
	return providerSubscription("sub_live", "ACTIVE", {
		current_period_end: PERIOD_END,
		updated_at: "2026-01-02T00:00:00.000Z",
		pending_change: {
			effective_at: PERIOD_END,
			target_items: [{ product_id: TEAM.productId, quantity: seats }],
		},
		...extra,
	});
}

describe(`subscription projection end-to-end (${TEST_WITH})`, () => {
	it("refreshes the pending seat change when a customer schedules cancellation", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		const row = await activeSubscription(h);
		h.stream.cancelSubscription.mockResolvedValue(
			withPendingSeats(3, { cancel_at_period_end: true }),
		);

		const response = await callAuthEndpoint(h.auth, "/subscription/cancel", {
			method: "POST",
			body: { subscriptionId: row.id },
			headers: h.headers,
		});

		expect(response.status).toBe(200);
		expect((await h.rows("subscription"))[0]).toMatchObject({
			cancelAtPeriodEnd: true,
			pendingSeats: 3,
			catalogMapped: true,
		});
	});

	it("refreshes the pending seat change when a customer restores renewal", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		const row = await activeSubscription(h);
		h.stream.uncancelSubscription.mockResolvedValue(undefined);
		h.stream.getSubscription.mockResolvedValue(withPendingSeats(4));

		const response = await callAuthEndpoint(h.auth, "/subscription/uncancel", {
			method: "POST",
			body: { subscriptionId: row.id },
			headers: h.headers,
		});

		expect(response.status).toBe(200);
		expect((await h.rows("subscription"))[0]).toMatchObject({ pendingSeats: 4 });
	});

	it("keeps access when a provider response omits the subscription items", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		const row = await activeSubscription(h);
		const { items: _items, ...withoutItems } = providerSubscription("sub_live", "ACTIVE", {
			current_period_end: PERIOD_END,
			updated_at: "2026-01-02T00:00:00.000Z",
			cancel_at_period_end: true,
		}) as unknown as Row;
		h.stream.cancelSubscription.mockResolvedValue(withoutItems as never);

		await callAuthEndpoint(h.auth, "/subscription/cancel", {
			method: "POST",
			body: { subscriptionId: row.id },
			headers: h.headers,
		});

		expect((await h.rows("subscription"))[0]).toMatchObject({
			cancelAtPeriodEnd: true,
			catalogMapped: true,
			plan: TEAM.name,
		});
	});

	it("projects plan fields after an admin changes the subscription at StreamPay", async () => {
		const h = await harness([
			subscriptions({ plans: [TEAM] }),
			webhooks({ secret: SECRET }),
			admin({ isAdmin: () => true }),
		]);
		await activeSubscription(h);
		h.stream.updateSubscription.mockResolvedValue(withPendingSeats(5));

		const response = await callAuthEndpoint(h.auth, "/admin/streampay/subscriptions/sub_live", {
			method: "PATCH",
			body: { items: [{ product_id: TEAM.productId, quantity: 5 }] },
			headers: h.headers,
		});

		expect(response.status).toBe(200);
		expect((await h.rows("subscription"))[0]).toMatchObject({ pendingSeats: 5 });
	});

	it("still cancels when a function-backed plan catalog is temporarily unavailable", async () => {
		let catalogUp = true;
		const h = await harness([
			subscriptions({
				plans: async () => {
					if (!catalogUp) throw new Error("catalog service down");
					return [TEAM];
				},
			}),
			webhooks({ secret: SECRET }),
		]);
		const row = await activeSubscription(h);
		catalogUp = false;
		h.stream.cancelSubscription.mockResolvedValue(
			withPendingSeats(3, { cancel_at_period_end: true }),
		);

		const response = await callAuthEndpoint(h.auth, "/subscription/cancel", {
			method: "POST",
			body: { subscriptionId: row.id },
			headers: h.headers,
		});

		expect(response.status).toBe(200);
		expect((await h.rows("subscription"))[0]).toMatchObject({
			cancelAtPeriodEnd: true,
			catalogMapped: true,
			plan: TEAM.name,
		});
	});

	it("projects the cancellation when an admin cancels at StreamPay", async () => {
		const h = await harness([
			subscriptions({ plans: [TEAM] }),
			webhooks({ secret: SECRET }),
			admin({ isAdmin: () => true }),
		]);
		await activeSubscription(h);
		h.stream.cancelSubscription.mockResolvedValue(
			withPendingSeats(2, { cancel_at_period_end: true }),
		);

		const response = await callAuthEndpoint(
			h.auth,
			"/admin/streampay/subscriptions/sub_live/cancel",
			{ method: "POST", body: {}, headers: h.headers },
		);

		expect(response.status).toBe(200);
		expect((await h.rows("subscription"))[0]).toMatchObject({
			cancelAtPeriodEnd: true,
			pendingSeats: 2,
		});
	});
});
