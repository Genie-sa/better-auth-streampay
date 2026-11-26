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

function refund(h: Harness, key: string, amount?: string, note?: string) {
	return callAuthEndpoint(h.auth, "/admin/streampay/payments/pay_1/refund", {
		method: "POST",
		headers: h.headers,
		body: {
			idempotencyKey: key,
			refund_reason: "OTHER",
			...(amount ? { amount } : {}),
			...(note === undefined ? {} : { refund_note: note }),
		},
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
		h.stream.getPayment.mockResolvedValue({
			id: "pay_second",
			currency: "SAR",
			current_status: "SUCCEEDED",
			amount_in_smallest_unit: 100,
			payment_method: "BANK_TRANSFER",
		});
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

	it("verifies every installment and returns a stable invoice and payment IDs", async () => {
		const h = await harness([checkout()]);
		const invoice = {
			...paidInvoice("inv_installments", "pay_2"),
			total_amount: "250.00",
			total_amount_in_smallest_unit: 25_000,
			paid_amount_in_smallest_unit: 25_000,
			remaining_amount_in_smallest_unit: 0,
			payments: [{ id: "pay_2" }, { id: "pay_1" }],
		};
		h.stream.listInvoices.mockResolvedValue({ data: [invoice] });
		const providerPayment = (id: string, overrides: Record<string, unknown> = {}) =>
			({
				id,
				current_status: "SUCCEEDED",
				currency: "SAR",
				amount_in_smallest_unit: 12_500,
				payment_method: "MADA",
				...overrides,
			}) as never;
		h.stream.getPayment.mockImplementation(async (id) => providerPayment(id));
		const endpoint = h.auth.api.verifyStreampayCheckoutPayment;
		if (typeof endpoint !== "function")
			throw new Error("Checkout verification endpoint is missing.");
		const verify = (allowManualPayments = false) =>
			endpoint({
				body: {
					paymentLinkId: "pl_1",
					consumerId: "cons_1",
					amountInSmallestUnit: 25_000,
					currency: "SAR",
					allowManualPayments,
				},
			});
		const expected = {
			status: "paid",
			invoiceId: "inv_installments",
			paymentId: "pay_1",
			paymentIds: ["pay_1", "pay_2"],
		};
		expect(await verify()).toEqual(expected);
		h.stream.listInvoices.mockResolvedValue({
			data: [{ ...invoice, payments: [...invoice.payments].reverse() }],
		});
		expect(await verify()).toEqual(expected);

		for (const overrides of [
			{ current_status: "PENDING" },
			{ current_status: "PARTIALLY_REFUNDED" },
			{ amount_refunded: "1.00" },
			{ refunds: [{ status: "PENDING" }] },
			{ amount_in_smallest_unit: 12_499 },
			{ currency: "USD" },
			{ id: "different-payment" },
			{ payment_method: null },
			{ payment_method: "UNKNOWN_METHOD" },
		]) {
			h.stream.getPayment.mockImplementation(async (id) =>
				providerPayment(id, id === "pay_1" ? overrides : {}),
			);
			expect(await verify(), JSON.stringify(overrides)).toEqual({ status: "needs_review" });
		}

		h.stream.getPayment.mockImplementation(async (id) =>
			providerPayment(id, id === "pay_1" ? { payment_method: "CASH" } : {}),
		);
		expect(await verify()).toEqual({ status: "needs_review" });
		expect(await verify(true)).toEqual(expected);

		for (const overrides of [
			{ payments: [{ id: "pay_1" }, { id: "pay_1" }] },
			{ paid_amount_in_smallest_unit: 12_500 },
			{ remaining_amount_in_smallest_unit: 1 },
			{ total_refunded: "5.00" },
			{ payment_link_id: "different-link" },
			{ organization_consumer_id: "different-consumer" },
			{ subscription: { id: "sub_1" } },
		]) {
			h.stream.listInvoices.mockResolvedValue({ data: [{ ...invoice, ...overrides }] });
			expect(await verify(true), JSON.stringify(overrides)).toEqual({ status: "needs_review" });
		}
	});
});

describe(`durable refund requests end to end (${TEST_WITH})`, () => {
	it.each([
		["full with generated note", undefined, undefined],
		["full with caller note", undefined, "Customer request"],
		["partial with generated note", "0.20", undefined],
		["partial with caller note", "0.20", "Customer request"],
	] as const)("confirms a successful response with a provider refund record (%s)", async (_, amount, note) => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "SUCCEEDED", "0.00", []));
		const refunded = amount ?? "1.00";
		h.stream.refundPayment.mockImplementation(async (_, request) =>
			payment("pay_1", amount ? "PARTIALLY_REFUNDED" : "REFUNDED", refunded, [
				{
					id: "exact-refund",
					status: "REFUNDED",
					amount_refunded: refunded,
					refund_reason: request.refund_reason,
					refund_note: request.refund_note,
				},
			]),
		);

		expect((await refund(h, "refund-success", amount, note)).status).toBe(200);
		expect(h.stream.refundPayment.mock.calls[0]?.[1].refund_note).toEqual(
			note ?? expect.stringMatching(/^better-auth-streampay:/),
		);
		expect(await (await refundStatus(h, "refund-success")).json()).toMatchObject({
			status: "confirmed",
			providerRefundId: "exact-refund",
			amountRefunded: refunded,
		});
		expect(await h.rows("streampayRefundIntent")).toMatchObject([{ activePaymentId: null }]);
	});

	it("remembers a pending refund ID returned with a caller note", async () => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "SUCCEEDED", "0.00", []));
		const pending = {
			id: "pending-refund",
			status: "PENDING",
			amount_refunded: "0.20",
			refund_reason: "OTHER",
			refund_note: "Refund for order",
		};
		h.stream.refundPayment.mockResolvedValue(payment("pay_1", "SUCCEEDED", "0.00", [pending]));
		expect((await refund(h, "pending", "0.20", pending.refund_note)).status).toBe(409);
		expect(await h.rows("streampayRefundIntent")).toMatchObject([
			{ status: "pending", activePaymentId: "pay_1", providerRefundId: pending.id },
		]);
		h.stream.getPayment.mockResolvedValue(
			payment("pay_1", "PARTIALLY_REFUNDED", "0.20", [{ ...pending, status: "REFUNDED" }]),
		);
		expect(await (await refundStatus(h, "pending")).json()).toMatchObject({
			status: "confirmed",
			providerRefundId: pending.id,
		});
		expect(h.stream.refundPayment).toHaveBeenCalledTimes(1);
	});

	it("holds a lost response with an unproven caller note for review", async () => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		const note = "Customer request";
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "SUCCEEDED", "0.00", []));
		h.stream.refundPayment.mockRejectedValue(new Error("provider reply lost"));
		expect((await refund(h, "unproven-note", "0.20", note)).status).toBe(409);
		expect(h.stream.refundPayment.mock.calls[0]?.[1].refund_note).toBe(note);
		h.stream.getPayment.mockResolvedValue(
			payment("pay_1", "PARTIALLY_REFUNDED", "0.20", [
				{
					id: "unknown-refund",
					status: "REFUNDED",
					amount_refunded: "0.20",
					refund_reason: "OTHER",
					refund_note: note,
				},
			]),
		);
		expect(await (await refundStatus(h, "unproven-note")).json()).toMatchObject({
			status: "needs_review",
			providerRefundId: null,
		});
		expect(await h.rows("streampayRefundIntent")).toMatchObject([{ activePaymentId: "pay_1" }]);
		expect((await refund(h, "other-key", "0.20")).status).toBe(409);
		expect(h.stream.refundPayment).toHaveBeenCalledTimes(1);
	});

	it("rejects an intent before writing if another refund is pending", async () => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		const earlier = { id: "other-refund", status: "PENDING", amount_refunded: "1.00" };
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "SUCCEEDED", "0.00", [earlier]));
		expect((await refund(h, "our-key")).status).toBe(409);
		h.stream.getPayment.mockResolvedValue(
			payment("pay_1", "REFUNDED", "1.00", [{ ...earlier, status: "REFUNDED" }]),
		);
		expect(await (await refundStatus(h, "our-key")).json()).toMatchObject({
			status: "rejected",
			providerRefundId: null,
		});
		expect(await h.rows("streampayRefundIntent")).toMatchObject([{ activePaymentId: null }]);
		expect(h.stream.refundPayment).not.toHaveBeenCalled();
	});

	it.each([
		[null, "confirmed", null],
		["invalid JSON", "needs_review", "pay_1"],
	] as const)("handles a stored refund evidence value of %s", async (refundEvidence, status, activePaymentId) => {
		const h = await harness([admin({ durableRefunds: true, isAdmin: () => true })]);
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "SUCCEEDED", "0.00", []));
		h.stream.refundPayment.mockRejectedValue(new Error("provider reply lost"));
		expect((await refund(h, "stored-evidence")).status).toBe(409);
		const id = (await h.rows("streampayRefundIntent"))[0]?.id;
		if (typeof id !== "string") throw new Error("Missing refund intent.");
		await h.setRow("streampayRefundIntent", id, { refundEvidence });
		h.stream.getPayment.mockResolvedValue(payment("pay_1", "REFUNDED", "1.00", []));
		expect(await (await refundStatus(h, "stored-evidence")).json()).toMatchObject({ status });
		expect(await h.rows("streampayRefundIntent")).toMatchObject([{ activePaymentId }]);
		expect(h.stream.refundPayment).toHaveBeenCalledTimes(1);
	});

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
		h.stream.getPayment.mockResolvedValue(
			payment("pay_1", "PARTIALLY_REFUNDED", "0.10", [previous, { ...foreign, status: "PENDING" }]),
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
