import { describe, expect, it, vi } from "vitest";
import { subscriptions, webhooks } from "../../src";
import { parkUnreplayableWebhookEvent, type WebhookEventRow } from "../../src/webhooks/inbox";
import {
	type Harness,
	harness,
	providerSubscription,
	SECRET,
	subscriptionEvent,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

const PARKED_EVENT_ID = "SUBSCRIPTION_PLAN_UPDATED:sub_due:2026-01-01T00:00:00.000Z";
const DUE_EVENT_ID = "SUBSCRIPTION_ACTIVATED:sub_due:2026-01-02T00:00:00.000Z";
const PAST = new Date("2026-01-01T00:00:00.000Z");

async function processDue(
	h: Harness,
	limit: number,
): Promise<{ succeeded: string[]; failed: Array<{ eventId: string; error: string }> }> {
	const endpoint = h.auth.api.processDueStreampayWebhookEvents;
	if (typeof endpoint !== "function") throw new Error("process-due endpoint is not registered");
	return endpoint({ body: { limit } });
}

async function inboxRow(h: Harness, eventId: string) {
	return (await h.rows("streampayWebhookEvent")).find((row) => row.eventId === eventId);
}

async function insertPendingRowWithoutPayload(h: Harness, nextAttemptAt: Date | null) {
	await (await h.auth.$context).adapter.create({
		model: "streampayWebhookEvent",
		data: {
			eventId: PARKED_EVENT_ID,
			eventType: "SUBSCRIPTION_PLAN_UPDATED",
			status: "pending",
			attemptCount: 1,
			receivedAt: PAST,
			lastAttemptAt: PAST,
			nextAttemptAt,
			rawPayload: null,
			signatureHeader: null,
			lastError: "callback failed",
		},
	});
}

function parkedEventRedelivery(h: Harness) {
	return subscriptionEvent(h, "SUBSCRIPTION_PLAN_UPDATED", "sub_due", PAST.toISOString());
}

describe(`due webhook queue end-to-end (${TEST_WITH})`, () => {
	it("does not let a pending event without a stored payload block later due events", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		await insertPendingRowWithoutPayload(h, PAST);
		h.stream.getSubscription.mockRejectedValue(
			Object.assign(new Error("unavailable"), { status: 503, body: {} }),
		);
		await h.deliver(
			subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_due", "2026-01-02T00:00:00.000Z"),
		);
		await h.setRow("streampayWebhookEvent", String((await inboxRow(h, DUE_EVENT_ID))?.id), {
			nextAttemptAt: new Date("2026-01-02T00:00:00.000Z"),
		});
		h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_due", "ACTIVE"));

		const first = await processDue(h, 1);
		const second = await processDue(h, 1);

		expect(first.failed.map((failure) => failure.eventId)).toEqual([PARKED_EVENT_ID]);
		expect(second.succeeded).toEqual([DUE_EVENT_ID]);
		expect(await inboxRow(h, PARKED_EVENT_ID)).toMatchObject({
			status: "pending",
			nextAttemptAt: null,
			lastErrorCode: "UNREPLAYABLE_PAYLOAD",
		});

		expect((await h.deliver(parkedEventRedelivery(h))).status).toBe(200);
		expect(await inboxRow(h, PARKED_EVENT_ID)).toMatchObject({ status: "completed" });
	});

	it("stores the payload when a redelivery reclaims an event that has none", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		await insertPendingRowWithoutPayload(h, null);
		h.stream.getSubscription.mockImplementation(async () => {
			const stored = await inboxRow(h, PARKED_EVENT_ID);
			throw new Error(`worker stopped with payload=${typeof stored?.rawPayload}`);
		});

		expect((await h.deliver(parkedEventRedelivery(h))).status).toBe(500);

		expect((await inboxRow(h, PARKED_EVENT_ID))?.lastError).toContain("payload=string");
	});

	it("does not let a stale parking read strand an event that a redelivery repaired", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		await insertPendingRowWithoutPayload(h, null);
		const staleRead = (await inboxRow(h, PARKED_EVENT_ID)) as unknown as WebhookEventRow;
		h.stream.getSubscription.mockRejectedValue(
			Object.assign(new Error("unavailable"), { status: 503, body: {} }),
		);
		await h.deliver(parkedEventRedelivery(h));

		await parkUnreplayableWebhookEvent(
			{ context: { adapter: (await h.auth.$context).adapter as never } },
			staleRead,
			"no payload",
		);

		expect(await inboxRow(h, PARKED_EVENT_ID)).toMatchObject({
			status: "pending",
			attemptCount: 2,
			nextAttemptAt: expect.anything(),
			rawPayload: expect.any(String),
		});
	});

	it("does not let an overlapping due-queue run retry an event before its backoff", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		h.stream.getSubscription.mockRejectedValue(
			Object.assign(new Error("unavailable"), { status: 503, body: {} }),
		);
		await h.deliver(
			subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_due", "2026-01-02T00:00:00.000Z"),
		);
		await h.setRow("streampayWebhookEvent", String((await inboxRow(h, DUE_EVENT_ID))?.id), {
			nextAttemptAt: PAST,
		});
		h.stream.getSubscription.mockClear();
		const adapter = (await h.auth.$context).adapter as unknown as {
			findMany: (input: { model: string }) => Promise<unknown[]>;
		};
		const findMany = adapter.findMany.bind(adapter);
		let releaseStaleRun = () => {};
		const firstRunFinished = new Promise<void>((resolve) => {
			releaseStaleRun = resolve;
		});
		let inboxQueries = 0;
		vi.spyOn(adapter, "findMany").mockImplementation(async (input) => {
			// Count at call time: the two due queries of one run resolve in either order on PostgreSQL.
			const staleRunQuery = input.model === "streampayWebhookEvent" && ++inboxQueries <= 2;
			const rows = await findMany(input);
			if (staleRunQuery) await firstRunFinished;
			return rows;
		});

		const staleRun = processDue(h, 1);
		await processDue(h, 1);
		releaseStaleRun();
		await staleRun;

		expect(h.stream.getSubscription).toHaveBeenCalledTimes(1);
		expect(await inboxRow(h, DUE_EVENT_ID)).toMatchObject({ status: "pending", attemptCount: 2 });
	});
});
