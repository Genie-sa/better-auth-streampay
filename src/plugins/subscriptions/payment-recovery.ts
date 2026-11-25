import type { StreamPayClient } from "../../types";
import { confirmInvoice, findPaidCheckoutInvoice } from "../../utils/payment-evidence";
import type { StreamPayWebhookPayload } from "../../webhooks/events";
import type { SyncContext } from "./adapter";
import type { ResolvedPlans } from "./plans";
import { subscriptionItemProductId } from "./reconcile";
import { syncWebhookPayload } from "./sync";
import {
	APP_ID_METADATA_KEY,
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	REFERENCE_TYPE_METADATA_KEY,
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

async function recoverCheckout(
	ctx: SyncContext,
	row: Subscription,
	{ client, plans, subscriptions }: RecoveryOptions,
): Promise<PaymentRecoveryStatus> {
	const linkId = row.streampayPaymentLinkId;
	const consumerId = row.streampayConsumerId;
	if (!linkId || !consumerId) return "unchanged";
	const plan = plans.byName.get(row.plan);
	if (!plan || plan.productId !== row.productId) return "needs_review";
	const evidence = await findPaidCheckoutInvoice(client, linkId, consumerId);
	if (evidence.status !== "paid")
		return evidence.status === "unpaid" ? "unchanged" : "needs_review";
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
		link.id !== linkId ||
		metadata?.[SUBSCRIPTION_ROW_ID_METADATA_KEY] !== row.id ||
		metadata?.[APP_ID_METADATA_KEY] !== subscriptions.appId ||
		metadata?.[REFERENCE_ID_METADATA_KEY] !== row.referenceId ||
		metadata?.[REFERENCE_TYPE_METADATA_KEY] !== (row.referenceType ?? "user") ||
		metadata?.[PLAN_NAME_METADATA_KEY] !== row.plan ||
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
	const invoiceId = stream.latest_invoice?.id;
	if (
		stream.status !== "ACTIVE" ||
		cycle === undefined ||
		cycle <= baseline ||
		!invoiceId ||
		stream.latest_invoice?.status !== "COMPLETED"
	) {
		return "unchanged";
	}
	const invoice = await confirmInvoice(client, await client.getInvoice(invoiceId));
	if (
		!invoice ||
		invoice.id !== invoiceId ||
		invoice.organization_consumer_id !== row.streampayConsumerId ||
		(invoice.subscription_id ?? invoice.subscription?.id) !== subscriptionId
	) {
		return "needs_review";
	}

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
	return (updated?.renewedCycleNumber ?? 0) >= cycle ? "recovered" : "retry";
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
