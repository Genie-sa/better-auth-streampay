import { z } from "zod";
import type { StreamPayClient } from "../types";
import { amountToSmallestUnit } from "./amount";

const id = z.string().min(1);
const paidInvoice = z.object({
	id,
	status: z.literal("COMPLETED"),
	payment_link_id: id.nullish(),
	subscription_id: id.nullish(),
	subscription: z.object({ id }).nullish(),
	organization_consumer_id: id,
	currency: id,
	total_amount: z.string(),
	payments: z.array(z.object({ id })).length(1),
});

const paidPayment = z.object({
	id,
	currency: id,
	current_status: z.enum(["SUCCEEDED", "SETTLED"]),
	amount_in_smallest_unit: z.number().int().positive(),
});

export async function confirmInvoice(client: StreamPayClient, candidate: unknown) {
	const invoice = paidInvoice.safeParse(candidate);
	if (!invoice.success) return null;
	const { subscription, subscription_id } = invoice.data;
	if (subscription && subscription_id && subscription.id !== subscription_id) return null;
	const [entry] = invoice.data.payments;
	if (!entry) return null;
	const payment = paidPayment.safeParse(await client.getPayment(entry.id));
	const total = amountToSmallestUnit(invoice.data.total_amount, invoice.data.currency);
	return payment.success &&
		payment.data.id === entry.id &&
		payment.data.currency === invoice.data.currency &&
		payment.data.amount_in_smallest_unit === total
		? { ...invoice.data, total, paymentId: entry.id }
		: null;
}

export async function findPaidCheckoutInvoice(
	client: StreamPayClient,
	linkId: string,
	consumerId?: string,
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
	const invoice = await confirmInvoice(client, candidate);
	return invoice ? ({ status: "paid", invoice } as const) : ({ status: "needs_review" } as const);
}
