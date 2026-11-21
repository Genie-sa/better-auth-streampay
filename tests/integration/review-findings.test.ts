import { describe, expect, it, vi } from "vitest";
import { admin, subscriptions, webhooks } from "../../src";
import {
	claimOrAdvanceWebhookEvent,
	DEFAULT_MAX_WEBHOOK_ATTEMPTS,
} from "../../src/plugins/subscriptions/sync";
import { callAuthEndpoint } from "../utils/auth-instance";
import {
	harness,
	providerSubscription,
	SECRET,
	subscriptionEvent,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

const FIRST_WRITE = "2026-01-01T00:00:00.000Z";
const FIRST_EVENT = "2026-01-01T00:00:01.000Z";
const LATER_WRITE = "2026-01-01T00:05:00.000Z";
const LATER_EVENT = "2026-01-01T00:05:01.000Z";

describe(`review findings end-to-end (${TEST_WITH})`, () => {
	it("retries instead of dead-lettering when two first deliveries create the same subscription", async () => {
		const onSubscriptionActivated = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], onSubscriptionActivated }),
			webhooks({ secret: SECRET }),
		]);
		h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_burst", "ACTIVE"));
		const activated = subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_burst", FIRST_EVENT);
		const adapter = (await h.auth.$context).adapter as unknown as {
			findMany: (input: { model: string }) => Promise<unknown[]>;
		};
		const findMany = adapter.findMany.bind(adapter);
		let siblingDelivered = false;
		vi.spyOn(adapter, "findMany").mockImplementation(async (input) => {
			const rows = await findMany(input);
			if (input.model === "subscription" && !siblingDelivered) {
				siblingDelivered = true;
				await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_CREATED", "sub_burst", FIRST_WRITE));
			}
			return rows;
		});

		expect((await h.deliver(activated)).status).toBe(500);
		expect((await h.deliver(activated)).status).toBe(200);

		expect(onSubscriptionActivated).toHaveBeenCalledTimes(1);
		const inbox = await h.rows("streampayWebhookEvent");
		expect(inbox.find((row) => row.eventType === "SUBSCRIPTION_ACTIVATED")).toMatchObject({
			status: "completed",
		});
	});

	it("lets a late renewal-success event clear past_due and deliver its renewal", async () => {
		const onSubscriptionRenewed = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], onSubscriptionRenewed }),
			webhooks({ secret: SECRET }),
		]);
		h.stream.getSubscription.mockResolvedValue(
			providerSubscription("sub_late", "ACTIVE", {
				current_cycle_number: 1,
				updated_at: FIRST_WRITE,
				latest_invoice: { id: "inv_2", status: "SENT" },
			}),
		);
		await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_late", FIRST_EVENT));
		await h.deliver(
			subscriptionEvent(h, "SUBSCRIPTION_CYCLE_RENEWAL_FAILED", "sub_late", FIRST_EVENT),
		);
		h.stream.getSubscription.mockResolvedValue(
			providerSubscription("sub_late", "ACTIVE", {
				current_cycle_number: 2,
				cancel_at_period_end: true,
				updated_at: LATER_WRITE,
				latest_invoice: { id: "inv_2", status: "COMPLETED" },
			}),
		);
		await h.deliver(
			subscriptionEvent(h, "SUBSCRIPTION_CANCEL_AT_PERIOD_END", "sub_late", LATER_EVENT),
		);

		await h.deliver(
			subscriptionEvent(
				h,
				"SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
				"sub_late",
				"2026-01-01T00:04:00.000Z",
			),
		);

		expect(await h.rows("subscription")).toMatchObject([
			{ status: "active", billingStatus: "current", renewedCycleNumber: 2 },
		]);
		expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
	});

	it("issues a new checkout instead of resuming a reservation older than the window", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
		const [abandoned] = await h.rows("subscription");
		await h.setRow("subscription", String(abandoned?.id), {
			createdAt: new Date(Date.now() - 16 * 60 * 1000),
		});
		h.stream.getPaymentLink.mockResolvedValue({
			id: "pl_1",
			status: "ACTIVE",
			url: "https://pay.example.test/pl_1",
		} as never);

		const response = await h.upgrade({ plan: TEAM.name, seats: 1 });

		expect(await response.json()).toMatchObject({
			reused: false,
			url: "https://pay.example.test/pl_2",
		});
		expect(h.stream.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_1", { status: "INACTIVE" });
	});

	it("does not resume a checkout whose StreamPay link is inactive", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
		h.stream.getPaymentLink.mockResolvedValue({
			id: "pl_1",
			status: "INACTIVE",
			url: "https://pay.example.test/pl_1",
		} as never);

		const response = await h.upgrade({ plan: TEAM.name, seats: 1 });

		expect(await response.json()).toMatchObject({
			reused: false,
			url: "https://pay.example.test/pl_2",
		});
	});

	it("refuses to discard an event that a worker is still processing", async () => {
		const h = await harness([
			subscriptions({ plans: [TEAM] }),
			webhooks({ secret: SECRET }),
			admin({ isAdmin: () => true }),
		]);
		const eventId = "INVOICE_COMPLETED:inv_live:2026-01-01T00:00:00.000Z";
		await (await h.auth.$context).adapter.create({
			model: "streampayWebhookEvent",
			data: {
				eventId,
				eventType: "INVOICE_COMPLETED",
				status: "pending",
				attemptCount: 1,
				receivedAt: new Date(),
				lockedAt: new Date(),
				lockedBy: "worker-1",
				rawPayload: "{}",
			},
		});

		const response = await callAuthEndpoint(
			h.auth,
			`/admin/streampay/webhook-events/${encodeURIComponent(eventId)}`,
			{ method: "DELETE", headers: h.headers },
		);

		expect(response.status).toBe(409);
		expect(await h.rows("streampayWebhookEvent")).toMatchObject([
			{ status: "pending", lockedBy: "worker-1" },
		]);
	});

	it("keeps the stored payload when a delivery without a body dead-letters an event", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		const context = await h.auth.$context;
		const event = subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_spent", FIRST_EVENT);
		await context.adapter.create({
			model: "streampayWebhookEvent",
			data: {
				eventId: `SUBSCRIPTION_ACTIVATED:sub_spent:${FIRST_EVENT}`,
				eventType: "SUBSCRIPTION_ACTIVATED",
				status: "pending",
				attemptCount: DEFAULT_MAX_WEBHOOK_ATTEMPTS,
				receivedAt: new Date(FIRST_WRITE),
				rawPayload: '{"stored":true}',
				signatureHeader: "t=1,v1=stored",
			},
		});

		const claim = await claimOrAdvanceWebhookEvent(
			{ context: context as never },
			event as never,
			null,
			null,
			DEFAULT_MAX_WEBHOOK_ATTEMPTS,
		);

		expect(claim.action).toBe("dead_letter");
		expect(await h.rows("streampayWebhookEvent")).toMatchObject([
			{ status: "dead_letter", rawPayload: '{"stored":true}', signatureHeader: "t=1,v1=stored" },
		]);
	});

	it("refuses a discard when a worker claims the event after the admin read it", async () => {
		const h = await harness([
			subscriptions({ plans: [TEAM] }),
			webhooks({ secret: SECRET }),
			admin({ isAdmin: () => true }),
		]);
		const context = await h.auth.$context;
		const event = subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_raced", FIRST_EVENT);
		const eventId = `SUBSCRIPTION_ACTIVATED:sub_raced:${FIRST_EVENT}`;
		await context.adapter.create({
			model: "streampayWebhookEvent",
			data: {
				eventId,
				eventType: "SUBSCRIPTION_ACTIVATED",
				status: "pending",
				attemptCount: 1,
				receivedAt: new Date(FIRST_WRITE),
				rawPayload: JSON.stringify(event),
			},
		});
		const adapter = context.adapter as unknown as {
			findOne: (input: { model: string }) => Promise<unknown>;
		};
		const findOne = adapter.findOne.bind(adapter);
		let workerClaimed = false;
		vi.spyOn(adapter, "findOne").mockImplementation(async (input) => {
			const row = await findOne(input);
			if (input.model === "streampayWebhookEvent" && !workerClaimed) {
				workerClaimed = true;
				await claimOrAdvanceWebhookEvent(
					{ context: context as never },
					event as never,
					null,
					null,
					DEFAULT_MAX_WEBHOOK_ATTEMPTS,
				);
			}
			return row;
		});

		const response = await callAuthEndpoint(
			h.auth,
			`/admin/streampay/webhook-events/${encodeURIComponent(eventId)}`,
			{ method: "DELETE", headers: h.headers },
		);

		expect(response.status).toBe(409);
		expect(await h.rows("streampayWebhookEvent")).toMatchObject([
			{ status: "pending", attemptCount: 2, lockedBy: expect.any(String) },
		]);
	});

	it("does not let two redeliveries of one attempt both run it", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		h.stream.getSubscription.mockRejectedValue(
			Object.assign(new Error("unavailable"), { status: 503, body: {} }),
		);
		const event = subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_twice", FIRST_EVENT);
		expect((await h.deliver(event)).status).toBe(500);
		const adapter = (await h.auth.$context).adapter as unknown as {
			findOne: (input: { model: string }) => Promise<unknown>;
		};
		const findOne = adapter.findOne.bind(adapter);
		let releaseStaleDelivery = () => {};
		const firstRedeliveryFinished = new Promise<void>((resolve) => {
			releaseStaleDelivery = resolve;
		});
		let inboxReads = 0;
		vi.spyOn(adapter, "findOne").mockImplementation(async (input) => {
			const row = await findOne(input);
			if (input.model === "streampayWebhookEvent" && ++inboxReads === 1)
				await firstRedeliveryFinished;
			return row;
		});

		const staleDelivery = h.deliver(event);
		expect((await h.deliver(event)).status).toBe(500);
		releaseStaleDelivery();

		expect((await staleDelivery).status).toBe(503);
		expect(h.stream.getSubscription).toHaveBeenCalledTimes(2);
		expect(await h.rows("streampayWebhookEvent")).toMatchObject([{ attemptCount: 2 }]);
	});

	it("replaces a fresh concurrent reservation whose checkout link is already gone", async () => {
		const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
		expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
		h.stream.getPaymentLink.mockRejectedValue(
			Object.assign(new Error("not found"), { status: 404, body: {} }),
		);
		const adapter = (await h.auth.$context).adapter as unknown as {
			findMany: (input: { model: string }) => Promise<unknown[]>;
		};
		const findMany = adapter.findMany.bind(adapter);
		let missedConcurrentReservation = false;
		vi.spyOn(adapter, "findMany").mockImplementation(async (input) => {
			const rows = await findMany(input);
			if (input.model === "subscription" && !missedConcurrentReservation) {
				missedConcurrentReservation = true;
				return [];
			}
			return rows;
		});

		const response = await h.upgrade({ plan: TEAM.name, seats: 1 });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			reused: false,
			url: "https://pay.example.test/pl_2",
		});
	});
});
