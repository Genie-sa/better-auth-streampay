import type { SubscriptionDetailed } from "@streamsdk/typescript";
import { z } from "zod";
import type { StreamPayClient } from "../../types";
import { confirmInvoice } from "../../utils/payment-evidence";
import { parseDate } from "./reconcile";
import type { Subscription } from "./types";

const HISTORY_LIMIT = 50;
const id = z.string().min(1);
const recurringInvoice = z.object({
	id,
	type: z.literal("RECURRING"),
	status: z.literal("COMPLETED"),
	organization_consumer_id: id,
	subscription_id: id.nullish(),
	subscription: z.object({ id }).nullish(),
	currency: id,
	period_start: z.string(),
	period_end: z.string(),
});

export async function confirmLatestRenewal(
	client: StreamPayClient,
	row: Subscription,
	invoiceId: string,
) {
	const invoice = await confirmInvoice(client, await client.getInvoice(invoiceId));
	return (
		invoice?.id === invoiceId &&
		invoice.organization_consumer_id === row.streampayConsumerId &&
		(invoice.subscription_id ?? invoice.subscription?.id) === row.streampaySubscriptionId &&
		(row.currency === null || invoice.currency === row.currency)
	);
}

function readPeriod(input: unknown, row: Subscription) {
	const invoice = recurringInvoice.safeParse(input);
	if (!invoice.success) return null;
	const { id, subscription, subscription_id, organization_consumer_id, currency } = invoice.data;
	const start = parseDate(invoice.data.period_start)?.getTime();
	const end = parseDate(invoice.data.period_end)?.getTime();
	if (
		(subscription_id ?? subscription?.id) !== row.streampaySubscriptionId ||
		(subscription && subscription_id && subscription.id !== subscription_id) ||
		organization_consumer_id !== row.streampayConsumerId ||
		currency !== row.currency ||
		start === undefined ||
		end === undefined ||
		end <= start
	)
		return null;
	return { id, start, end };
}

export async function findNextHistoricalRenewal(
	client: StreamPayClient,
	stream: SubscriptionDetailed,
	row: Subscription,
	baseline: number,
) {
	const latestCycle = stream.current_cycle_number;
	const latestId = stream.latest_invoice?.id;
	const currentStart = parseDate(stream.current_period_start)?.getTime();
	const currentEnd = parseDate(stream.current_period_end)?.getTime();
	if (
		latestCycle === undefined ||
		!stream.id ||
		!Number.isSafeInteger(latestCycle) ||
		!Number.isSafeInteger(baseline) ||
		baseline < 0 ||
		latestCycle - baseline <= 1 ||
		latestCycle - baseline >= HISTORY_LIMIT ||
		!latestId ||
		currentStart === undefined ||
		currentEnd === undefined
	)
		return null;

	const list = await client.listInvoices({
		subscription_id: stream.id,
		limit: HISTORY_LIMIT,
		sort_field: "period_start",
		sort_direction: "desc",
		statuses: ["COMPLETED"],
	});
	const invoices = list.data ?? [];
	if (invoices.length > HISTORY_LIMIT) return null;
	const recurring = invoices.filter((candidate) => candidate.type === "RECURRING");
	const periods = recurring.flatMap((candidate) => {
		const period = readPeriod(candidate, row);
		return period ? [period] : [];
	});
	if (
		periods.length !== recurring.length ||
		new Set(periods.map(({ id }) => id)).size !== periods.length
	)
		return null;
	const gap = latestCycle - baseline;
	// Anchor the chain to StreamPay's current cycle. Each preceding invoice must end
	// exactly where the newer one starts, with one invoice per billing period.
	const ordered = periods.sort((a, b) => b.start - a.start);
	const chain = ordered.slice(0, gap);
	const target = chain[gap - 1];
	const older = ordered[gap];
	if (
		!target ||
		chain[0]?.id !== latestId ||
		chain[0].start !== currentStart ||
		chain[0].end !== currentEnd ||
		(row.currentCycleNumber === baseline &&
			row.periodEnd &&
			target.start !== row.periodEnd.getTime()) ||
		chain.some(({ start }, index) => index < gap - 1 && chain[index + 1]?.end !== start) ||
		(older !== undefined && older.end > target.start) ||
		(list.pagination?.has_next_page && !older)
	)
		return null;

	const candidate = await client.getInvoice(target.id);
	const period = readPeriod(candidate, row);
	if (period?.id !== target.id || period.start !== target.start || period.end !== target.end)
		return null;
	const confirmed = await confirmInvoice(client, candidate);
	return confirmed ? { invoiceId: target.id, cycle: baseline + 1 } : null;
}
