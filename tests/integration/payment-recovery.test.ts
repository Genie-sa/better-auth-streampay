import { describe, expect, it, vi } from "vitest";
import { admin, checkout, subscriptions, webhooks } from "../../src";
import { callAuthEndpoint } from "../utils/auth-instance";
import { mockApiError } from "../utils/helpers";
import {
	type Harness,
	harness,
	providerSubscription,
	SECRET,
	subscriptionEvent,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

const stamp = "2026-11-01T09:00:00Z";

function paidInvoice(id: string, paymentId: string, subscriptionId?: string) {
	return {
		id,
		status: "COMPLETED" as const,
		payment_link_id: "pl_1",
		organization_consumer_id: "cons_1",
		currency: "SAR" as const,
		total_amount: "1.00",
		payments: [{ id: paymentId }],
		...(subscriptionId
			? { subscription: { id: subscriptionId }, subscription_id: subscriptionId }
			: {}),
	};
}

function payment(id: string, status: string, amountRefunded?: string, refunds?: unknown[]) {
	return {
		id,
		current_status: status,
		currency: "SAR",
		amount_in_smallest_unit: 100,
		...(amountRefunded === undefined ? {} : { amount_refunded: amountRefunded }),
		...(refunds === undefined ? {} : { refunds }),
	} as never;
}

async function reserve(h: Harness) {
	const response = await h.upgrade({ plan: TEAM.name });
	expect(response.status).toBe(200);
	const { subscriptionId } = await response.json();
	const link = h.stream.createPaymentLink.mock.calls[0]?.[0];
	expect(link).toBeDefined();
	h.stream.getPaymentLink.mockResolvedValue({
		id: "pl_1",
		custom_metadata: link?.custom_metadata ?? {},
	});
	return subscriptionId as string;
}

function scheduled(h: Harness) {
	const endpoint = h.auth.api.reconcileStreampaySubscriptionPayments;
	if (typeof endpoint !== "function")
		throw new Error("Payment reconciliation endpoint is missing.");
	return endpoint({ body: { limit: 10 } });
}

function refund(h: Harness, key: string, amount?: string) {
	return callAuthEndpoint(h.auth, "/admin/streampay/payments/pay_1/refund", {
		method: "POST",
		headers: h.headers,
		body: { idempotencyKey: key, refund_reason: "OTHER", ...(amount ? { amount } : {}) },
	});
}

function refundStatus(h: Harness, key: string) {
	return callAuthEndpoint(
		h.auth,
		`/admin/streampay/payments/pay_1/refund-intent?idempotencyKey=${key}`,
		{
			headers: h.headers,
		},
	);
}

describe(`payment reconciliation end to end (${TEST_WITH})`, () => {
	it("recovers a paid checkout and a missed renewal, then handles late signed events once", async () => {
		const onSubscriptionActivated = vi.fn();
		const onSubscriptionRenewed = vi.fn();
		const h = await harness([
			subscriptions({
				plans: [TEAM],
				reconcilePayments: true,
				onSubscriptionActivated,
				onSubscriptionRenewed,
			}),
			webhooks({ secret: SECRET }),
		]);
		const rowId = await reserve(h);
		const first = paidInvoice("inv_first", "pay_first", "sub_paid");
		h.stream.listInvoices.mockResolvedValue({ data: [first] });
		h.stream.getPayment.mockResolvedValue(payment("pay_first", "SETTLED"));
		h.stream.getSubscription.mockResolvedValue(
			providerSubscription("sub_paid", "ACTIVE", {
				current_cycle_number: 1,
				current_period_start: stamp,
				updated_at: stamp,
				latest_invoice: first,
			}),
		);

		expect(await scheduled(h)).toMatchObject({
			results: [{ subscriptionId: rowId, status: "recovered" }],
		});
		expect(await h.rows("subscription")).toMatchObject([
			{ status: "active", streampaySubscriptionId: "sub_paid" },
		]);
		expect(onSubscriptionActivated).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				idempotencyKey: "subscription:sub_paid:checkout-activation",
			}),
		);
		expect(h.stream.listInvoices).toHaveBeenCalledWith(
			expect.objectContaining({ payment_link_id: "pl_1", include_payments: true }),
		);
		const original = {
			...subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_paid", stamp, rowId),
			webhook_delivery_id: "first-delivery",
		};
		expect((await h.deliver(original)).status).toBe(200);
		expect(onSubscriptionActivated).toHaveBeenCalledTimes(1);

		const second = paidInvoice("inv_second", "pay_second", "sub_paid");
		const renewalStamp = "2026-12-01T09:00:00Z";
		h.stream.getSubscription.mockResolvedValue(
			providerSubscription("sub_paid", "ACTIVE", {
				current_cycle_number: 2,
				current_period_start: renewalStamp,
				updated_at: renewalStamp,
				latest_invoice: second,
			}),
		);
		h.stream.getInvoice.mockResolvedValue(second);
		h.stream.getPayment.mockResolvedValue(payment("pay_second", "SUCCEEDED"));
		expect(await scheduled(h)).toMatchObject({
			results: [{ subscriptionId: rowId, status: "recovered" }],
		});
		const renewal = subscriptionEvent(
			h,
			"SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
			"sub_paid",
			renewalStamp,
			rowId,
		);
		expect((await h.deliver({ ...renewal, webhook_delivery_id: "renewal-delivery" })).status).toBe(
			200,
		);
		expect(onSubscriptionRenewed).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				idempotencyKey: "subscription:sub_paid:renewal:2",
			}),
		);
		expect(await h.rows("subscription")).toMatchObject([{ renewedCycleNumber: 2 }]);
	});

	it("holds an ambiguous checkout for review and leaves its reservation incomplete", async () => {
		const onSubscriptionActivated = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], reconcilePayments: true, onSubscriptionActivated }),
		]);
		const rowId = await reserve(h);
		h.stream.listInvoices.mockResolvedValue({
			data: [paidInvoice("inv_one", "pay_1", "sub_1"), paidInvoice("inv_two", "pay_2", "sub_2")],
		});
		expect(await scheduled(h)).toMatchObject({
			results: [{ subscriptionId: rowId, status: "needs_review" }],
		});
		expect(await h.rows("subscription")).toMatchObject([{ status: "incomplete" }]);
		expect(h.stream.getPayment).not.toHaveBeenCalled();
		expect(onSubscriptionActivated).not.toHaveBeenCalled();
	});

	it("delivers and retries a reactivation separately from the original paid checkout", async () => {
		const onSubscriptionActivated = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], reconcilePayments: true, onSubscriptionActivated }),
			webhooks({ secret: SECRET }),
		]);
		const rowId = await reserve(h);
		const invoice = paidInvoice("inv_first", "pay_first", "sub_paid");
		h.stream.listInvoices.mockResolvedValue({ data: [invoice] });
		h.stream.getPayment.mockResolvedValue(payment("pay_first", "SETTLED"));
		const providerState = (status: string, updated_at: string) =>
			providerSubscription("sub_paid", status, {
				current_cycle_number: 1,
				current_period_start: stamp,
				updated_at,
				latest_invoice: invoice,
			});
		h.stream.getSubscription.mockResolvedValue(providerState("ACTIVE", stamp));
		await scheduled(h);
		expect(onSubscriptionActivated).toHaveBeenCalledTimes(1);

		const inactiveAt = "2026-11-03T09:00:00Z";
		h.stream.getSubscription.mockResolvedValue(providerState("INACTIVE", inactiveAt));
		expect(
			(await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_INACTIVATED", "sub_paid", inactiveAt)))
				.status,
		).toBe(200);
		const reactivatedAt = "2026-11-03T09:10:00Z";
		h.stream.getSubscription.mockResolvedValue(providerState("ACTIVE", reactivatedAt));
		const reactivated = {
			...subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_paid", reactivatedAt, rowId),
			webhook_delivery_id: "reactivation",
		};
		onSubscriptionActivated.mockRejectedValueOnce(new Error("callback temporarily unavailable"));
		expect((await h.deliver(reactivated)).status).toBe(500);
		expect((await h.deliver(reactivated)).status).toBe(200);
		expect((await h.deliver(reactivated)).status).toBe(200);
		expect(onSubscriptionActivated).toHaveBeenCalledTimes(3);
		for (const call of [2, 3]) {
			expect(onSubscriptionActivated).toHaveBeenNthCalledWith(
				call,
				expect.objectContaining({
					idempotencyKey: "onSubscriptionActivated:delivery:reactivation",
				}),
			);
		}
	});

	it("checks a one-time payment against an exact provider invoice and the app quote", async () => {
		const h = await harness([checkout()]);
		h.stream.listInvoices.mockResolvedValue({ data: [paidInvoice("inv_one", "pay_1")] });
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "SUCCEEDED"));
		const endpoint = h.auth.api.verifyStreampayCheckoutPayment;
		if (typeof endpoint !== "function")
			throw new Error("Checkout verification endpoint is missing.");
		const verify = (amountInSmallestUnit: number) =>
			endpoint({
				body: { paymentLinkId: "pl_1", currency: "SAR", amountInSmallestUnit },
			});
		expect(await verify(100)).toEqual({ status: "paid", invoiceId: "inv_one", paymentId: "pay_1" });
		expect(await verify(101)).toEqual({ status: "needs_review" });
		expect(
			(
				await callAuthEndpoint(h.auth, "/checkout/verify-payment", {
					method: "POST",
					headers: h.headers,
					body: { paymentLinkId: "pl_1", currency: "SAR", amountInSmallestUnit: 100 },
				})
			).status,
		).toBe(404);
	});
});

describe(`durable refund requests end to end (${TEST_WITH})`, () => {
	it.each([
		"REFUNDED",
		"CANCELED",
	])("reconciles a lost partial refund response by the exact provider row (%s)", async (outcome) => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		const previous = {
			id: "older-refund",
			status: "REFUNDED",
			amount_refunded: "0.10",
			refund_reason: "OTHER",
		};
		h.stream.getPayment.mockResolvedValue(
			payment("pay_1", "PARTIALLY_REFUNDED", "0.10", [previous]),
		);
		h.stream.refundPayment.mockRejectedValue(new Error("provider reply lost"));

		expect((await refund(h, "partial-ambiguous", "0.20")).status).toBe(409);
		const request = h.stream.refundPayment.mock.calls[0]?.[1];
		expect(request?.refund_note).toMatch(/^better-auth-streampay:/);
		const foreign = { ...previous, id: "same-amount", amount_refunded: "0.20" };
		h.stream.getPayment.mockResolvedValue(
			payment("pay_1", "PARTIALLY_REFUNDED", "0.30", [previous, foreign]),
		);
		expect(await (await refundStatus(h, "partial-ambiguous")).json()).toMatchObject({
			status: "needs_review",
			providerRefundId: null,
		});

		const matched = { ...foreign, id: "our-refund", refund_note: request?.refund_note };
		h.stream.getPayment.mockResolvedValue(
			payment("pay_1", "PARTIALLY_REFUNDED", "0.30", [
				previous,
				foreign,
				{ ...matched, status: "PENDING" },
			]),
		);
		expect(await (await refundStatus(h, "partial-ambiguous")).json()).toMatchObject({
			status: "pending",
			providerRefundId: "our-refund",
		});
		expect((await refund(h, "other-key", "0.20")).status).toBe(409);

		h.stream.getPayment.mockResolvedValue(
			payment("pay_1", "PARTIALLY_REFUNDED", outcome === "REFUNDED" ? "0.50" : "0.30", [
				previous,
				foreign,
				{ ...matched, status: outcome },
			]),
		);
		expect(await (await refundStatus(h, "partial-ambiguous")).json()).toMatchObject({
			status: outcome === "REFUNDED" ? "confirmed" : "rejected",
			providerRefundId: "our-refund",
		});
		expect((await refund(h, "partial-ambiguous", "0.20")).status).toBe(
			outcome === "REFUNDED" ? 200 : 409,
		);
		expect(h.stream.refundPayment).toHaveBeenCalledTimes(1);
		expect(await h.rows("streampayRefundIntent")).toMatchObject([
			{ activePaymentId: null, providerRefundId: "our-refund" },
		]);
	});

	it("holds the claim when StreamPay refuses the remaining balance after a partial refund", async () => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		h.stream.getPayment.mockResolvedValue(
			payment("pay_1", "PARTIALLY_REFUNDED", "0.10", [
				{
					id: "partial",
					status: "REFUNDED",
					amount_refunded: "0.10",
				},
			]),
		);
		h.stream.refundPayment.mockRejectedValue(
			mockApiError(400, {
				error: { code: "PAYMENT_REFUNDED_ALREADY" },
			}),
		);
		expect((await refund(h, "remaining")).status).toBe(409);
		expect(await (await refundStatus(h, "remaining")).json()).toMatchObject({
			status: "needs_review",
			amountRefunded: "0.10",
			providerRefundId: null,
		});
		expect((await refund(h, "second-attempt")).status).toBe(409);
		expect(h.stream.refundPayment).toHaveBeenCalledTimes(1);
	});

	it("runs one provider write across same and different keys while a refund is in flight", async () => {
		const onRefund = vi.fn();
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true, onRefund })]);
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "SUCCEEDED"));
		let complete: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			complete = resolve;
		});
		h.stream.refundPayment.mockImplementation(async () => {
			await barrier;
			return payment("pay_1", "REFUNDED", "1.000");
		});
		const first = refund(h, "attempt-one");
		await vi.waitFor(() => expect(h.stream.refundPayment).toHaveBeenCalledTimes(1));
		try {
			expect((await refund(h, "attempt-one")).status).toBe(409);
			expect((await refund(h, "attempt-two")).status).toBe(409);
			expect(await (await refundStatus(h, "attempt-one")).json()).toMatchObject({
				status: "pending",
			});
		} finally {
			complete();
		}
		expect((await first).status).toBe(200);
		expect(await (await refundStatus(h, "attempt-one")).json()).toMatchObject({
			status: "confirmed",
			amountRefunded: "1.000",
		});
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "REFUNDED", "1.000"));
		expect((await refund(h, "attempt-one")).status).toBe(200);
		expect((await refund(h, "attempt-one", "0.50")).status).toBe(409);
		expect(h.stream.refundPayment).toHaveBeenCalledTimes(1);
		expect(onRefund).toHaveBeenCalledTimes(1);
	});

	it("keeps an uncertain partial refund for review across repeated local requests", async () => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "PARTIALLY_REFUNDED", "0.100"));
		h.stream.refundPayment.mockRejectedValue(new Error("provider connection lost"));
		expect((await refund(h, "partial", "0.20")).status).toBe(409);
		expect(await (await refundStatus(h, "partial")).json()).toMatchObject({
			status: "needs_review",
			amountRefunded: "0.100",
		});
		expect((await refund(h, "partial", "0.20")).status).toBe(409);
		expect((await refund(h, "another", "0.20")).status).toBe(409);
		expect(h.stream.refundPayment).toHaveBeenCalledTimes(1);
	});

	it("confirms a partial refund only when the cumulative refund changes by the requested amount", async () => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "PARTIALLY_REFUNDED", "0.100"));
		h.stream.refundPayment.mockResolvedValue(payment("pay_1", "PARTIALLY_REFUNDED", "0.300"));
		expect((await refund(h, "partial-confirmed", "0.20")).status).toBe(200);
		expect(await (await refundStatus(h, "partial-confirmed")).json()).toMatchObject({
			status: "confirmed",
			amountRefunded: "0.300",
		});
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "PARTIALLY_REFUNDED", "0.300"));
		h.stream.refundPayment.mockResolvedValue(payment("pay_1", "PARTIALLY_REFUNDED", "0.400"));
		expect((await refund(h, "partial-review", "0.20")).status).toBe(409);
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "PARTIALLY_REFUNDED", "0.400"));
		expect(await (await refundStatus(h, "partial-review")).json()).toMatchObject({
			status: "needs_review",
			amountRefunded: "0.400",
		});
	});

	it("rejects unrepresentable and excessive partial amounts before a provider write", async () => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "PARTIALLY_REFUNDED", "0.100"));
		expect((await refund(h, "zero", "0.00")).status).toBe(400);
		expect((await refund(h, "fraction", "0.001")).status).toBe(400);
		expect((await refund(h, "balance", "0.91")).status).toBe(400);
		expect(h.stream.refundPayment).not.toHaveBeenCalled();
		h.stream.refundPayment.mockResolvedValue(payment("pay_1", "REFUNDED", "1.000"));
		expect((await refund(h, "refund-remaining")).status).toBe(200);
	});
});

describe(`delivery identity end to end (${TEST_WITH})`, () => {
	const event = {
		event_type: "PAYMENT_PARTIALLY_REFUNDED",
		entity_type: "PAYMENT",
		entity_id: "pay_1",
		timestamp: stamp,
	};

	it("deduplicates a provider delivery without merging separate deliveries for the same entity", async () => {
		const onPayload = vi.fn();
		const h = await harness([webhooks({ secret: SECRET, deduplicate: true, onPayload })]);
		const one = { ...event, webhook_delivery_id: "provider-one" };
		expect((await h.deliver(one)).status).toBe(200);
		expect((await h.deliver(one)).status).toBe(200);
		expect((await h.deliver({ ...event, webhook_delivery_id: "provider-two" })).status).toBe(200);
		expect(onPayload).toHaveBeenCalledTimes(2);
		expect(await h.rows("streampayWebhookEvent")).toMatchObject([
			{ eventId: "handlers:delivery:provider-one", status: "completed" },
			{ eventId: "handlers:delivery:provider-two", status: "completed" },
		]);
	});

	it("honors a completed legacy inbox record if the delivery now includes a provider ID", async () => {
		const onPayload = vi.fn();
		const h = await harness([webhooks({ secret: SECRET, deduplicate: true, onPayload })]);
		expect((await h.deliver(event)).status).toBe(200);
		expect((await h.deliver({ ...event, webhook_delivery_id: "provider-new" })).status).toBe(200);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(await h.rows("streampayWebhookEvent")).toHaveLength(1);
	});
});
