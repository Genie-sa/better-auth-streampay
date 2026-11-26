import type { StreamPayClient } from "../../types";
import { findPaidCheckoutInvoice } from "../../utils/payment-evidence";
import type { StreamPayWebhookPayload } from "../../webhooks/events";
import type { SyncContext } from "./adapter";
import type { ResolvedPlans } from "./plans";
import {
	isOlderProviderState,
	lifecycleWriteGuard,
	parseDate,
	projectSubscriptionAgainstExisting,
	subscriptionItemProductId,
} from "./reconcile";
import { confirmLatestRenewal, findNextHistoricalRenewal } from "./renewal-evidence";
import { syncWebhookPayload } from "./sync";
import {
	APP_ID_METADATA_KEY,
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	REFERENCE_TYPE_METADATA_KEY,
	type StreamPayPlanLike,
	SUBSCRIPTION_ROW_ID_METADATA_KEY,
	type Subscription,
	type SubscriptionsOptions,
} from "./types";

const MODEL = "subscription";
export type PaymentRecoveryStatus = "recovered" | "unchanged" | "needs_review" | "retry";

type RecoveryOptions = {
	client: StreamPayClient;
	plans: ResolvedPlans;
	subscriptions: SubscriptionsOptions;
};

function ownsCheckoutLink(
	link: Awaited<ReturnType<StreamPayClient["getPaymentLink"]>>,
	row: Subscription,
	options: SubscriptionsOptions,
) {
	const metadata = link.custom_metadata;
	return (
		link.id === row.streampayPaymentLinkId &&
		metadata?.[SUBSCRIPTION_ROW_ID_METADATA_KEY] === row.id &&
		metadata?.[APP_ID_METADATA_KEY] === options.appId &&
		metadata?.[REFERENCE_ID_METADATA_KEY] === row.referenceId &&
		metadata?.[REFERENCE_TYPE_METADATA_KEY] === (row.referenceType ?? "user") &&
		metadata?.[PLAN_NAME_METADATA_KEY] === row.plan
	);
}

async function recoverTrial(
	ctx: SyncContext,
	row: Subscription,
	{ client, plans, subscriptions }: RecoveryOptions,
	plan: StreamPayPlanLike,
	linkId: string,
	consumerId: string,
	fallback: PaymentRecoveryStatus,
): Promise<PaymentRecoveryStatus> {
	if (!plan.trialPeriodDays || !row.activeSlotKey) return fallback;
	const link = await client.getPaymentLink(linkId);
	if (!link.trial_period_days) return fallback;
	if (
		!ownsCheckoutLink(link, row, subscriptions) ||
		link.organization_consumer_id !== consumerId ||
		link.trial_period_days !== plan.trialPeriodDays
	)
		return "needs_review";

	const list = await client.listSubscriptions({
		organization_consumer_id: consumerId,
		product_ids: [plan.productId],
		limit: 10,
	});
	if (list.pagination?.has_next_page || (list.data?.length ?? 0) > 10) return "needs_review";
	const candidates = (list.data ?? []).filter(
		(candidate) => candidate.latest_invoice?.payment_link_id === linkId,
	);
	const [candidate] = candidates;
	if (candidates.length === 0) return list.data?.length ? "needs_review" : fallback;
	if (candidates.length !== 1 || !candidate?.id) return "needs_review";

	const stream = await client.getSubscription(candidate.id);
	if (
		stream.id !== candidate.id ||
		stream.organization_consumer_id !== consumerId ||
		stream.latest_invoice?.payment_link_id !== linkId ||
		stream.trial_period_days !== plan.trialPeriodDays ||
		stream.currency !== row.currency ||
		stream.items?.length !== 1 ||
		subscriptionItemProductId(stream.items[0]) !== plan.productId
	)
		return "needs_review";
	if (stream.status === "TRIAL_PENDING") return "unchanged";
	const trialEnd = parseDate(stream.trial_end);
	if (stream.status !== "TRIALING" || !trialEnd || trialEnd.getTime() <= Date.now())
		return "needs_review";

	const projected = projectSubscriptionAgainstExisting(row, stream, plans);
	if (isOlderProviderState(row, projected)) return "retry";
	const updated = await ctx.context.adapter.update<Subscription>({
		model: MODEL,
		where: [
			...lifecycleWriteGuard(row),
			{ field: "streampayPaymentLinkId", value: linkId },
			{ field: "activeSlotKey", value: row.activeSlotKey },
		],
		update: projected,
	});
	return updated ? "recovered" : "retry";
}

async function recoverCheckout(
	ctx: SyncContext,
	row: Subscription,
	options: RecoveryOptions,
): Promise<PaymentRecoveryStatus> {
	const { client, plans, subscriptions } = options;
	const linkId = row.streampayPaymentLinkId;
	const consumerId = row.streampayConsumerId;
	if (!linkId || !consumerId) return "unchanged";
	const plan = plans.byName.get(row.plan);
	if (!plan || plan.productId !== row.productId) return "needs_review";
	const evidence = await findPaidCheckoutInvoice(client, linkId, consumerId);
	if (evidence.status !== "paid") {
		return recoverTrial(
			ctx,
			row,
			options,
			plan,
			linkId,
			consumerId,
			evidence.status === "unpaid" ? "unchanged" : "needs_review",
		);
	}
	const invoice = evidence.invoice;
	const subscriptionId = invoice?.subscription_id ?? invoice?.subscription?.id;
	if (
		!invoice ||
		!subscriptionId ||
		invoice.currency !== row.currency ||
		invoice.total !== row.amountInSmallestUnit
	) {
		return "needs_review";
	}

	const [stream, link] = await Promise.all([
		client.getSubscription(subscriptionId),
		client.getPaymentLink(linkId),
	]);
	const metadata = link.custom_metadata;
	if (
		!ownsCheckoutLink(link, row, subscriptions) ||
		stream.id !== subscriptionId ||
		stream.organization_consumer_id !== consumerId ||
		stream.status !== "ACTIVE" ||
		!stream.items?.some((item) => subscriptionItemProductId(item) === plan.productId)
	) {
		return "needs_review";
	}
	const activation: StreamPayWebhookPayload = {
		webhook_delivery_id: `recovery-activation:${subscriptionId}`,
		event_type: "SUBSCRIPTION_ACTIVATED",
		entity_type: "SUBSCRIPTION",
		entity_id: subscriptionId,
		entity_url: "",
		status: "ACTIVE",
		timestamp: stream.updated_at ?? new Date().toISOString(),
		data: {
			metadata: metadata ?? {},
			payment_link: { id: linkId, url: "" },
			invoice: { id: invoice.id, url: "" },
		},
	};
	await syncWebhookPayload(ctx, activation, client, plans, subscriptions, {
		rawBody: JSON.stringify(activation),
		...(subscriptions.maxWebhookAttempts === undefined
			? {}
			: { maxAttempts: subscriptions.maxWebhookAttempts }),
		retryOnCallbackError: subscriptions.retryOnCallbackError !== false,
	});
	const updated = await ctx.context.adapter.findOne<Subscription>({
		model: MODEL,
		where: [{ field: "id", value: row.id }],
	});
	return updated?.streampaySubscriptionId === subscriptionId && updated.status === "active"
		? "recovered"
		: "needs_review";
}

async function recoverRenewal(
	ctx: SyncContext,
	row: Subscription,
	{ client, plans, subscriptions }: RecoveryOptions,
): Promise<PaymentRecoveryStatus> {
	const subscriptionId = row.streampaySubscriptionId;
	if (
		!subscriptionId ||
		(row.status !== "active" && row.status !== "past_due" && row.status !== "trialing")
	) {
		return "unchanged";
	}
	const stream = await client.getSubscription(subscriptionId);
	if (
		stream.id !== subscriptionId ||
		!row.streampayConsumerId ||
		stream.organization_consumer_id !== row.streampayConsumerId
	) {
		return "needs_review";
	}
	const cycle = stream.current_cycle_number;
	const baseline = row.renewedCycleNumber ?? row.currentCycleNumber ?? 0;
	const latestInvoiceId = stream.latest_invoice?.id;
	if (
		stream.status !== "ACTIVE" ||
		cycle === undefined ||
		!Number.isSafeInteger(cycle) ||
		cycle <= baseline ||
		!latestInvoiceId ||
		stream.latest_invoice?.status !== "COMPLETED"
	) {
		return "unchanged";
	}
	let invoiceId = latestInvoiceId;
	let claimedCycle = cycle;
	if (cycle - baseline > 1) {
		const historical = await findNextHistoricalRenewal(client, stream, row, baseline);
		if (!historical) return "needs_review";
		({ invoiceId, cycle: claimedCycle } = historical);
	} else if (!(await confirmLatestRenewal(client, row, invoiceId))) return "needs_review";

	const renewal: StreamPayWebhookPayload = {
		webhook_delivery_id: `recovery-renewal:${invoiceId}`,
		event_type: "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
		entity_type: "SUBSCRIPTION",
		entity_id: subscriptionId,
		entity_url: "",
		status: "ACTIVE",
		timestamp: stream.updated_at ?? new Date().toISOString(),
		data: { invoice: { id: invoiceId, url: "" } },
	};
	await syncWebhookPayload(ctx, renewal, client, plans, subscriptions, {
		rawBody: JSON.stringify(renewal),
		...(subscriptions.maxWebhookAttempts === undefined
			? {}
			: { maxAttempts: subscriptions.maxWebhookAttempts }),
		retryOnCallbackError: subscriptions.retryOnCallbackError !== false,
	});
	const updated = await ctx.context.adapter.findOne<Subscription>({
		model: MODEL,
		where: [{ field: "id", value: row.id }],
	});
	return (updated?.renewedCycleNumber ?? 0) >= claimedCycle ? "recovered" : "retry";
}

export async function reconcileSubscriptionPayment(
	ctx: SyncContext,
	row: Subscription,
	options: RecoveryOptions,
) {
	if (row.status === "incomplete" && !row.streampaySubscriptionId)
		return recoverCheckout(ctx, row, options);
	return recoverRenewal(ctx, row, options);
}

export async function reconcileSubscriptionPayments(
	ctx: SyncContext,
	options: RecoveryOptions,
	input: { limit: number; offset: number },
) {
	const rows = await ctx.context.adapter.findMany<Subscription>({
		model: MODEL,
		offset: input.offset,
		limit: input.limit,
		sortBy: { field: "id", direction: "asc" },
	});
	const results: Array<{ subscriptionId: string; status: PaymentRecoveryStatus }> = [];
	for (const row of rows) {
		try {
			results.push({
				subscriptionId: row.id,
				status: await reconcileSubscriptionPayment(ctx, row, options),
			});
		} catch {
			ctx.context.logger.warn(
				`Subscription payment reconciliation could not finish for row=${row.id}`,
			);
			results.push({ subscriptionId: row.id, status: "retry" });
		}
	}
	return { results, nextOffset: rows.length === input.limit ? input.offset + rows.length : null };
}
