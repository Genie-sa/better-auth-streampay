import { describe, expect, it, vi } from "vitest";
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

const PAYMENT_EVENT = {
	event_type: "PAYMENT_SUCCEEDED",
	entity_type: "PAYMENT",
	entity_id: "pay_1",
	timestamp: "2026-01-01T00:00:00.000Z",
};
const PAYMENT_EVENT_ID = "handlers:PAYMENT_SUCCEEDED:pay_1:2026-01-01T00:00:00.000Z";

async function inboxRow(h: Harness, eventId: string) {
	return (await h.rows("streampayWebhookEvent")).find((row) => row.eventId === eventId);
}

async function processDue(
	h: Harness,
): Promise<{ succeeded: string[]; failed: Array<{ eventId: string; error: string }> }> {
	const endpoint = h.auth.api.processDueStreampayWebhookEvents;
	if (typeof endpoint !== "function") throw new Error("process-due endpoint is not registered");
	return endpoint({ body: { limit: 10 } });
}

async function makeDue(h: Harness, eventId: string) {
	const row = await inboxRow(h, eventId);
	await h.setRow("streampayWebhookEvent", String(row?.id), {
		nextAttemptAt: new Date(Date.now() - 1000),
	});
}

describe(`webhook inbox end-to-end (${TEST_WITH})`, () => {
	it("dead-letters a generic handler event after webhooks({ maxWebhookAttempts })", async () => {
		const onPayload = vi.fn().mockRejectedValue(new Error("handler down"));
		const h = await harness([
			webhooks({ secret: SECRET, deduplicate: true, maxWebhookAttempts: 2, onPayload }),
		]);

		expect((await h.deliver(PAYMENT_EVENT)).status).toBe(500);
		expect(await inboxRow(h, PAYMENT_EVENT_ID)).toMatchObject({ status: "pending" });
		expect((await h.deliver(PAYMENT_EVENT)).status).toBe(500);
		expect(await inboxRow(h, PAYMENT_EVENT_ID)).toMatchObject({
			status: "dead_letter",
			attemptCount: 2,
		});
		expect((await h.deliver(PAYMENT_EVENT)).status).toBe(200);

		expect(onPayload).toHaveBeenCalledTimes(2);
	});

	it("retries a due subscription event and grants access once StreamPay recovers", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		h.stream.getSubscription.mockRejectedValueOnce(
			Object.assign(new Error("unavailable"), { status: 503, body: {} }),
		);
		const event = subscriptionEvent(
			h,
			"SUBSCRIPTION_ACTIVATED",
			"sub_due",
			PAYMENT_EVENT.timestamp,
		);
		const eventId = `SUBSCRIPTION_ACTIVATED:sub_due:${PAYMENT_EVENT.timestamp}`;
		expect((await h.deliver(event)).status).toBe(500);
		await makeDue(h, eventId);
		h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_due", "ACTIVE"));

		expect(await processDue(h)).toEqual({ succeeded: [eventId], failed: [] });

		expect(await inboxRow(h, eventId)).toMatchObject({ status: "completed" });
		const current = await callAuthEndpoint(h.auth, "/subscription/current", { headers: h.headers });
		expect(await current.json()).toMatchObject({ status: "active" });
	});

	it("dead-letters a due subscription event after subscriptions({ maxWebhookAttempts })", async () => {
		const h = await harness([
			subscriptions({ plans: [TEAM], maxWebhookAttempts: 2 }),
			webhooks({ secret: SECRET }),
		]);
		h.stream.getSubscription.mockRejectedValue(
			Object.assign(new Error("unavailable"), { status: 503, body: {} }),
		);
		const eventId = `SUBSCRIPTION_ACTIVATED:sub_down:${PAYMENT_EVENT.timestamp}`;
		await h.deliver(
			subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_down", PAYMENT_EVENT.timestamp),
		);
		await makeDue(h, eventId);

		const result = await processDue(h);

		expect(result.failed.map((failure) => failure.eventId)).toEqual([eventId]);
		expect(await inboxRow(h, eventId)).toMatchObject({ status: "dead_letter", attemptCount: 2 });
	});

	it("keeps a leftover handlers: event pending when generic dedupe is turned off", async () => {
		const onPayload = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM] }),
			webhooks({ secret: SECRET, onPayload }),
		]);
		await (await h.auth.$context).adapter.create({
			model: "streampayWebhookEvent",
			data: {
				eventId: PAYMENT_EVENT_ID,
				eventType: PAYMENT_EVENT.event_type,
				status: "pending",
				attemptCount: 1,
				receivedAt: new Date(),
				nextAttemptAt: new Date(Date.now() - 1000),
				rawPayload: JSON.stringify({ entity_url: "", status: "OK", data: {}, ...PAYMENT_EVENT }),
			},
		});

		const result = await processDue(h);

		expect(result.failed.map((failure) => failure.eventId)).toEqual([PAYMENT_EVENT_ID]);
		expect(onPayload).not.toHaveBeenCalled();
		expect(h.stream.getSubscription).not.toHaveBeenCalled();
		expect(await inboxRow(h, PAYMENT_EVENT_ID)).toMatchObject({
			status: "pending",
			nextAttemptAt: null,
			lastErrorCode: "WEBHOOK_INBOX_SCOPE_DISABLED",
		});
	});

	it("releases the renewal owner when an admin discards an event stored before subscription dedupe was turned off", async () => {
		const h = await harness([
			subscriptions({ plans: [TEAM], enableWebhookEventTable: false }),
			webhooks({ secret: SECRET, deduplicate: true }),
			admin({ isAdmin: () => true }),
		]);
		const eventId = "INVOICE_COMPLETED:inv_old:2026-01-01T00:00:00.000Z";
		const adapter = (await h.auth.$context).adapter;
		const owner = await adapter.create<Row>({
			model: "subscription",
			data: {
				referenceId: h.userId,
				referenceType: "user",
				plan: TEAM.name,
				status: "active",
				billingStatus: "current",
				renewalCallbackEventId: eventId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await adapter.create({
			model: "streampayWebhookEvent",
			data: {
				eventId,
				eventType: "INVOICE_COMPLETED",
				status: "dead_letter",
				attemptCount: 5,
				receivedAt: new Date(),
			},
		});

		const response = await callAuthEndpoint(
			h.auth,
			`/admin/streampay/webhook-events/${encodeURIComponent(eventId)}`,
			{ method: "DELETE", headers: h.headers },
		);

		expect(response.status).toBe(200);
		expect(await inboxRow(h, eventId)).toMatchObject({ status: "completed" });
		expect((await h.rows("subscription")).find((row) => row.id === owner.id)).toMatchObject({
			renewalCallbackEventId: null,
		});
	});
});
