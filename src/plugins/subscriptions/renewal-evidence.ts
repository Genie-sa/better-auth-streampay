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

export function renewalBaseline(row: Subscription) {
	return row.renewedCycleNumber ?? row.currentCycleNumber ?? null;
}

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

function readPeriod(input: unknown, row: Subscription, expectedCurrency: string) {
	const invoice = recurringInvoice.safeParse(input);
	if (!invoice.success) return null;
	const { id, subscription, subscription_id, organization_consumer_id, currency } = invoice.data;
	const start = parseDate(invoice.data.period_start)?.getTime();
	const end = parseDate(invoice.data.period_end)?.getTime();
	if (
		(subscription_id ?? subscription?.id) !== row.streampaySubscriptionId ||
		(subscription && subscription_id && subscription.id !== subscription_id) ||
		organization_consumer_id !== row.streampayConsumerId ||
		currency !== expectedCurrency ||
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
	const localCycle = row.currentCycleNumber;
	const localEnd = row.periodEnd?.getTime();
	const currency = row.currency ?? stream.currency ?? stream.latest_invoice?.currency;
	const latestId = stream.latest_invoice?.id;
	const currentStart = parseDate(stream.current_period_start)?.getTime();
	const currentEnd = parseDate(stream.current_period_end)?.getTime();
	if (
		latestCycle === undefined ||
		!stream.id ||
		stream.id !== row.streampaySubscriptionId ||
		!row.streampayConsumerId ||
		row.streampayConsumerId !== stream.organization_consumer_id ||
		!Number.isSafeInteger(latestCycle) ||
		!Number.isSafeInteger(baseline) ||
		baseline < 1 ||
		localCycle === null ||
		!Number.isSafeInteger(localCycle) ||
		localCycle < 1 ||
		localCycle > baseline ||
		localEnd === undefined ||
		latestCycle - baseline <= 1 ||
		latestCycle - localCycle > HISTORY_LIMIT ||
		!currency ||
		!latestId ||
		currentStart === undefined ||
		currentEnd === undefined
	)
		return null;

	const list = await client.listInvoices({
		subscription_id: stream.id,
		limit: HISTORY_LIMIT,
		statuses: ["COMPLETED"],
	});
	const invoices = list.data ?? [];
	if (list.pagination?.has_next_page || invoices.length > HISTORY_LIMIT) return null;
	const recurring = invoices.filter((candidate) => candidate.type === "RECURRING");
	const periods = recurring.flatMap((candidate) => {
		const period = readPeriod(candidate, row, currency);
		return period ? [period] : [];
	});
	if (
		periods.length !== recurring.length ||
		new Set(periods.map(({ id }) => id)).size !== periods.length
	)
		return null;
	const span = latestCycle - localCycle;
	// Anchor both ends of the chain, including periods whose callbacks were already recovered.
	const [latest, ...earlier] = periods.sort((a, b) => b.start - a.start);
	const fromLocal = earlier[span - 2];
	const target = earlier[latestCycle - baseline - 2];
	const older = earlier[span - 1];
	if (
		!target ||
		latest?.id !== latestId ||
		latest.start !== currentStart ||
		latest.end !== currentEnd ||
		fromLocal?.start !== localEnd ||
		earlier
			.slice(0, span - 1)
			.some(({ end }, index) => end !== (index === 0 ? latest.start : earlier[index - 1]?.start)) ||
		(older !== undefined && older.end > localEnd)
	)
		return null;

	const candidate = await client.getInvoice(target.id);
	const period = readPeriod(candidate, row, currency);
	if (period?.id !== target.id || period.start !== target.start || period.end !== target.end)
		return null;
	const confirmed = await confirmInvoice(client, candidate);
	return confirmed ? { invoiceId: target.id, cycle: baseline + 1 } : null;
}
