import { describe, expect, it, vi } from "vitest";
import { subscriptions, webhooks } from "../../src";
import {
	type Harness,
	harness,
	providerSubscription,
	SECRET,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

const subId = "sub_history";
const windows = [
	"2026-06-01T00:00:00Z",
	"2026-07-01T00:00:00Z",
	"2026-08-01T00:00:00Z",
	"2026-09-01T00:00:00Z",
] as const;

async function reserve(h: Harness) {
	const response = await h.upgrade({ plan: TEAM.name });
	expect(response.status).toBe(200);
	const { subscriptionId } = await response.json();
	return subscriptionId as string;
}

function reconcile(h: Harness) {
	const endpoint = h.auth.api.reconcileStreampaySubscriptionPayments;
	if (typeof endpoint !== "function") throw new Error("Missing reconciliation endpoint.");
	return endpoint({ body: { limit: 5 } });
}

function recurringInvoice(id: string, start: string, end: string) {
	return {
		id,
		type: "RECURRING" as const,
		status: "COMPLETED" as const,
		payment_link_id: "pl_1",
		organization_consumer_id: "cons_1",
		currency: "SAR" as const,
		subscription_id: subId,
		subscription: { id: subId },
		period_start: start,
		period_end: end,
		total_amount: "1.00",
		payments: [{ id: `payment-${id}` }],
	};
}

async function renewalHistory() {
	const onSubscriptionRenewed = vi.fn();
	const h = await harness([
		subscriptions({ plans: [TEAM], reconcilePayments: true, onSubscriptionRenewed }),
		webhooks({ secret: SECRET }),
	]);
	const id = await reserve(h);
	await h.setRow("subscription", id, {
		status: "active",
		streampaySubscriptionId: subId,
		currentCycleNumber: 1,
		renewedCycleNumber: 1,
		periodStart: new Date(windows[0]),
		periodEnd: new Date(windows[1]),
	});
	const first = recurringInvoice("cycle-2", windows[1], windows[2]);
	const latest = recurringInvoice("cycle-3", windows[2], windows[3]);
	h.stream.getSubscription.mockResolvedValue(
		providerSubscription(subId, "ACTIVE", {
			current_cycle_number: 3,
			current_period_start: windows[2],
			current_period_end: windows[3],
			currency: "SAR",
			latest_invoice: latest,
			updated_at: windows[2],
		}),
	);
	h.stream.getInvoice.mockImplementation(async (id) => (id === latest.id ? latest : first));
	h.stream.getPayment.mockImplementation(async (id) => ({
		id,
		currency: "SAR",
		current_status: "SUCCEEDED",
		amount_in_smallest_unit: 100,
	}));
	h.stream.listInvoices.mockResolvedValue({ data: [latest, first] });
	return { h, id, first, latest, onSubscriptionRenewed };
}

function completion(invoiceId: string) {
	return {
		event_type: "INVOICE_COMPLETED",
		entity_type: "INVOICE",
		entity_id: invoiceId,
		timestamp: windows[2],
	};
}

describe(`subscription payment history (${TEST_WITH})`, () => {
	it("links a verified free trial without running paid activation callbacks", async () => {
		const trial = { ...TEAM, trialPeriodDays: 7 };
		const onSubscriptionActivated = vi.fn();
		const h = await harness([
			subscriptions({
				plans: [trial],
				reconcilePayments: true,
				onSubscriptionActivated,
				appId: "example",
			}),
		]);
		const id = await reserve(h);
		const request = h.stream.createPaymentLink.mock.calls[0]?.[0];
		expect(request?.trial_period_days).toBe(7);
		h.stream.getPaymentLink.mockResolvedValue({
			id: "pl_1",
			organization_consumer_id: "cons_1",
			trial_period_days: 7,
			amount_collected_in_smallest_unit: 0,
			custom_metadata: request?.custom_metadata ?? {},
		});
		h.stream.listInvoices.mockResolvedValue({ data: [] });
		const provider = (status: string, linkId = "pl_1") =>
			providerSubscription(subId, status, {
				currency: "SAR",
				trial_period_days: 7,
				trial_end: new Date(Date.now() + 86_400_000).toISOString(),
				updated_at: windows[0],
				latest_invoice: { id: "draft-invoice", payment_link_id: linkId },
			});
		h.stream.listSubscriptions.mockResolvedValue({ data: [provider("TRIALING")] });
		h.stream.listInvoices.mockResolvedValueOnce({
			data: [recurringInvoice("paid-link", windows[0], windows[1])],
		});
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "needs_review" }] });
		expect(h.stream.listSubscriptions).not.toHaveBeenCalled();
		h.stream.getPayment.mockClear();
		h.stream.getSubscription.mockResolvedValue(provider("TRIAL_PENDING"));
		expect(await reconcile(h)).toMatchObject({
			results: [{ subscriptionId: id, status: "unchanged" }],
		});
		h.stream.getSubscription.mockResolvedValue(provider("TRIALING", "other-link"));
		expect(await reconcile(h)).toMatchObject({
			results: [{ subscriptionId: id, status: "needs_review" }],
		});
		h.stream.getSubscription.mockResolvedValue(provider("TRIALING"));
		h.stream.listSubscriptions.mockResolvedValueOnce({
			data: [provider("TRIALING")],
			pagination: { has_next_page: true },
		});
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "needs_review" }] });
		h.stream.listSubscriptions.mockResolvedValueOnce({
			data: [
				provider("TRIALING"),
				providerSubscription("second-subscription", "TRIALING", {
					latest_invoice: { payment_link_id: "pl_1" },
				}),
			],
		});
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "needs_review" }] });
		await h.setRow("subscription", id, { providerUpdatedAt: new Date(windows[1]) });
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "retry" }] });
		await h.setRow("subscription", id, { providerUpdatedAt: null });
		expect(await reconcile(h)).toMatchObject({
			results: [{ subscriptionId: id, status: "recovered" }],
		});
		expect(await h.rows("subscription")).toMatchObject([
			{ id, status: "trialing", streampaySubscriptionId: subId },
		]);
		expect(onSubscriptionActivated).not.toHaveBeenCalled();
		expect(h.stream.getPayment).not.toHaveBeenCalled();
	});

	it("delivers two missed cycles in order without moving the period ahead of evidence", async () => {
		const { h, first, latest, onSubscriptionRenewed } = await renewalHistory();
		h.stream.listInvoices.mockResolvedValue({ data: [latest] });
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "needs_review" }] });
		expect(onSubscriptionRenewed).not.toHaveBeenCalled();

		h.stream.listInvoices.mockResolvedValue({ data: [latest, first] });
		expect((await h.deliver(completion(latest.id))).status).toBe(200);
		expect(onSubscriptionRenewed).not.toHaveBeenCalled();

		expect(await reconcile(h)).toMatchObject({ results: [{ status: "recovered" }] });
		expect(await h.rows("subscription")).toMatchObject([
			{
				currentCycleNumber: 1,
				renewedCycleNumber: 2,
				periodEnd: new Date(windows[1]),
			},
		]);
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "recovered" }] });
		expect(await h.rows("subscription")).toMatchObject([
			{
				currentCycleNumber: 3,
				renewedCycleNumber: 3,
				periodEnd: new Date(windows[3]),
			},
		]);
		expect((await h.deliver(completion(first.id))).status).toBe(200);
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "unchanged" }] });
		expect(onSubscriptionRenewed).toHaveBeenCalledTimes(2);
		expect(onSubscriptionRenewed).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ idempotencyKey: `subscription:${subId}:renewal:2` }),
		);
		expect(onSubscriptionRenewed).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ idempotencyKey: `subscription:${subId}:renewal:3` }),
		);
	});

	it("keeps legacy rows without a cycle number on latest-period verification", async () => {
		const { h, id, onSubscriptionRenewed } = await renewalHistory();
		await h.setRow("subscription", id, { currentCycleNumber: null, renewedCycleNumber: null });

		expect(await reconcile(h)).toMatchObject({ results: [{ status: "recovered" }] });
		expect(h.stream.listInvoices).not.toHaveBeenCalled();
		expect(h.stream.getPayment).toHaveBeenCalledWith("payment-cycle-3");
		expect(onSubscriptionRenewed).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ idempotencyKey: `subscription:${subId}:renewal:3` }),
		);
	});

	it("uses the verified provider currency when an older historical row is missing it", async () => {
		const { h, id, onSubscriptionRenewed } = await renewalHistory();
		await h.setRow("subscription", id, { currency: null });
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "recovered" }] });
		expect(onSubscriptionRenewed).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ idempotencyKey: `subscription:${subId}:renewal:2` }),
		);
	});

	it("defers missing anchors, truncated histories, and duplicate or overlapping periods", async () => {
		const { h, id, first, latest, onSubscriptionRenewed } = await renewalHistory();
		await h.setRow("subscription", id, { periodEnd: null });
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "needs_review" }] });
		await h.setRow("subscription", id, { periodEnd: new Date(windows[1]) });
		const older = recurringInvoice("cycle-1", windows[0], windows[1]);
		for (const data of [
			[latest, first],
			[latest, first, older],
		]) {
			h.stream.listInvoices.mockResolvedValueOnce({ data, pagination: { has_next_page: true } });
			expect(await reconcile(h)).toMatchObject({ results: [{ status: "needs_review" }] });
		}
		for (const candidate of [first, recurringInvoice("overlap", windows[0], windows[2])]) {
			h.stream.listInvoices.mockResolvedValueOnce({ data: [latest, first, candidate] });
			expect(await reconcile(h)).toMatchObject({ results: [{ status: "needs_review" }] });
		}
		h.stream.listInvoices.mockResolvedValueOnce({
			data: [
				latest,
				first,
				older,
				recurringInvoice("long-overlap", "2026-05-01T00:00:00Z", windows[2]),
			],
		});
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "needs_review" }] });
		expect(onSubscriptionRenewed).not.toHaveBeenCalled();
	});

	it("retries the same historical callback before processing a later cycle", async () => {
		const { h, latest, onSubscriptionRenewed } = await renewalHistory();
		onSubscriptionRenewed.mockRejectedValueOnce(new Error("Callback temporarily unavailable."));
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "retry" }] });
		const key = `subscription:${subId}:renewal:2`;
		expect(onSubscriptionRenewed).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ idempotencyKey: key }),
		);
		for (let i = 0; i < 6; i += 1) {
			expect(await reconcile(h)).toMatchObject({ results: [{ status: "retry" }] });
		}
		expect(await h.rows("streampayWebhookEvent")).toMatchObject([
			{ status: "pending", attemptCount: 1 },
		]);
		expect((await h.deliver(completion(latest.id))).status).toBe(500);
		expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
		const [row] = await h.rows("subscription");
		const owner = (await h.rows("streampayWebhookEvent")).find(
			(event) => event.eventId === row?.renewalCallbackEventId,
		);
		if (typeof owner?.id !== "string") throw new Error("Missing historical callback receipt.");
		await h.setRow("streampayWebhookEvent", owner.id, { nextAttemptAt: new Date(0) });
		const processDue = h.auth.api.processDueStreampayWebhookEvents;
		if (typeof processDue !== "function") throw new Error("Missing inbox retry endpoint.");
		expect(await processDue({ body: { limit: 1 } })).toMatchObject({
			succeeded: [owner.eventId],
			failed: [],
		});
		expect(onSubscriptionRenewed).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ idempotencyKey: key }),
		);
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "recovered" }] });
		expect(onSubscriptionRenewed).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ idempotencyKey: `subscription:${subId}:renewal:3` }),
		);
	});

	it("retries when provider evidence changes during a synthetic delivery", async () => {
		const { h, latest, onSubscriptionRenewed } = await renewalHistory();
		const stable = await h.stream.getSubscription(subId);
		h.stream.getSubscription
			.mockResolvedValueOnce(stable)
			.mockResolvedValueOnce({ ...stable, latest_invoice: { ...latest, id: "new-invoice" } });

		expect(await reconcile(h)).toMatchObject({ results: [{ status: "retry" }] });
		expect(await reconcile(h)).toMatchObject({ results: [{ status: "retry" }] });
		expect(onSubscriptionRenewed).not.toHaveBeenCalled();
		const [receipt] = await h.rows("streampayWebhookEvent");
		expect(receipt).toMatchObject({
			status: "pending",
			attemptCount: 1,
			eventId: "delivery:recovery-renewal:cycle-2",
		});
		if (typeof receipt?.id !== "string") throw new Error("Missing renewal receipt.");
		await h.setRow("streampayWebhookEvent", receipt.id, { nextAttemptAt: new Date(0) });
		const processDue = h.auth.api.processDueStreampayWebhookEvents;
		if (typeof processDue !== "function") throw new Error("Missing inbox retry endpoint.");
		expect(await processDue({ body: { limit: 1 } })).toMatchObject({
			succeeded: [receipt.eventId],
			failed: [],
		});
		expect(onSubscriptionRenewed).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ idempotencyKey: `subscription:${subId}:renewal:2` }),
		);
	});
});
