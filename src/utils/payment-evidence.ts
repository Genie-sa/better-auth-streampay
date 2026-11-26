import { z } from "zod";
import type { StreamPayClient } from "../types";
import { amountToSmallestUnit } from "./amount";

const id = z.string().min(1);
const minorAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const AUTOMATED_PAYMENT_METHODS = new Set([
	"MADA",
	"MASTERCARD",
	"VISA",
	"APPLE_PAY",
	"SAMSUNG_PAY",
	"AMEX",
	"PGW_CARD_UNSPECIFIED",
	"BNPL",
]);
const MANUAL_PAYMENT_METHODS = new Set(["CASH", "BANK_TRANSFER", "CARD", "QURRAH"]);
const MAX_INSTALLMENTS = 52;
const PAYMENT_LOOKUP_CONCURRENCY = 6;

const paidInvoice = z.object({
	id,
	status: z.literal("COMPLETED"),
	payment_link_id: id.nullish(),
	subscription_id: id.nullish(),
	subscription: z.object({ id }).nullish(),
	organization_consumer_id: id,
	currency: id,
	total_amount: z.string(),
	total_amount_in_smallest_unit: minorAmount.optional(),
	paid_amount_in_smallest_unit: minorAmount.optional(),
	paid_amount: z.string().optional(),
	remaining_amount_in_smallest_unit: minorAmount.nullish(),
	total_refunded: z.string().optional(),
	payments: z.array(z.object({ id })).min(1).max(MAX_INSTALLMENTS),
});

const paidPayment = z.object({
	id,
	currency: id,
	current_status: z.enum(["SUCCEEDED", "SETTLED"]),
	amount_in_smallest_unit: minorAmount.positive(),
	payment_method: id.nullish(),
	amount_refunded: z.union([z.string(), z.number()]).nullish(),
	refunds: z.array(z.object({ status: z.literal("CANCELED") })).nullish(),
});

type PaymentPolicy = { allowInstallments?: boolean; allowManualPayments?: boolean };

export async function confirmInvoice(
	client: StreamPayClient,
	candidate: unknown,
	policy: PaymentPolicy = {},
) {
	const invoice = paidInvoice.safeParse(candidate);
	if (!invoice.success) return null;
	const { subscription, subscription_id, currency } = invoice.data;
	if (subscription && subscription_id && subscription.id !== subscription_id) return null;
	const paymentIds = invoice.data.payments.map((payment) => payment.id).sort();
	const [paymentId] = paymentIds;
	const multiple = paymentIds.length > 1;
	if (
		!paymentId ||
		(multiple && (!policy.allowInstallments || subscription || subscription_id)) ||
		new Set(paymentIds).size !== paymentIds.length
	)
		return null;

	const total = amountToSmallestUnit(invoice.data.total_amount, currency);
	if (
		total === null ||
		total <= 0 ||
		(invoice.data.total_amount_in_smallest_unit ?? total) !== total ||
		(invoice.data.paid_amount_in_smallest_unit ?? total) !== total ||
		(invoice.data.paid_amount !== undefined &&
			amountToSmallestUnit(invoice.data.paid_amount, currency) !== total) ||
		(invoice.data.remaining_amount_in_smallest_unit ?? 0) !== 0 ||
		amountToSmallestUnit(invoice.data.total_refunded ?? "0", currency) !== 0
	)
		return null;

	let verifiedTotal = 0;
	for (let i = 0; i < paymentIds.length; i += PAYMENT_LOOKUP_CONCURRENCY) {
		const payments = await Promise.all(
			paymentIds
				.slice(i, i + PAYMENT_LOOKUP_CONCURRENCY)
				.map(async (id) => ({ id, result: paidPayment.safeParse(await client.getPayment(id)) })),
		);
		for (const { id, result } of payments) {
			if (
				!result.success ||
				result.data.id !== id ||
				result.data.currency !== currency ||
				amountToSmallestUnit(String(result.data.amount_refunded ?? 0), currency) !== 0
			)
				return null;
			// Older provider responses may omit the method for a single payment.
			const method = result.data.payment_method;
			if (
				method
					? !(
							AUTOMATED_PAYMENT_METHODS.has(method) ||
							(policy.allowManualPayments && MANUAL_PAYMENT_METHODS.has(method))
						)
					: multiple
			)
				return null;
			verifiedTotal += result.data.amount_in_smallest_unit;
			if (!Number.isSafeInteger(verifiedTotal) || verifiedTotal > total) return null;
		}
	}
	return verifiedTotal === total ? { ...invoice.data, total, paymentId, paymentIds } : null;
}

export async function findPaidCheckoutInvoice(
	client: StreamPayClient,
	linkId: string,
	consumerId?: string,
	policy?: PaymentPolicy,
) {
	const list = await client.listInvoices({
		payment_link_id: linkId,
		include_payments: true,
		statuses: ["COMPLETED"],
		limit: 2,
	});
	const invoices = list.data ?? [];
	if (invoices.length === 0) {
		const link = await client.getPaymentLink(linkId);
		if (link.id !== linkId || Number(link.amount_collected_in_smallest_unit) > 0) {
			return { status: "needs_review" } as const;
		}
		return { status: "unpaid" } as const;
	}
	const [candidate] = invoices;
	if (
		invoices.length !== 1 ||
		list.pagination?.has_next_page ||
		candidate?.payment_link_id !== linkId ||
		(consumerId !== undefined && candidate.organization_consumer_id !== consumerId)
	) {
		return { status: "needs_review" } as const;
	}
	const invoice = await confirmInvoice(client, candidate, policy);
	return invoice ? ({ status: "paid", invoice } as const) : ({ status: "needs_review" } as const);
}
