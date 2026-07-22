import type { SubscriptionDetailed } from "@streamsdk/typescript";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { $ERROR_CODES } from "../../error-codes";
import type { PluginAdapter } from "./adapter";
import type { ResolvedPlans } from "./plans";
import { isTerminalSubscriptionStatus, toLocalStatus } from "./status";
import type { Subscription } from "./types";

const SUBSCRIPTION_MODEL = "subscription";

export function reconcileProjectionAgainstExisting(
	existing: Subscription | null | undefined,
	projection: Partial<Subscription>,
	options: {
		lifecycleAt?: Date | null;
		stampCancelScheduled?: boolean;
		stampCanceled?: boolean;
	} = {},
): Partial<Subscription> {
	const projected = { ...projection };
	if (existing?.billingStatus === "past_due" && projected.status === "active") {
		projected.status = "past_due";
		projected.billingStatus = "past_due";
	}

	const lifecycleAt = options.lifecycleAt === undefined ? new Date() : options.lifecycleAt;
	if (
		options.stampCancelScheduled !== false &&
		!existing?.cancelAtPeriodEnd &&
		projected.cancelAtPeriodEnd &&
		lifecycleAt
	) {
		projected.cancelScheduledAt = lifecycleAt;
	}
	if (
		options.stampCanceled !== false &&
		projected.status === "canceled" &&
		!existing?.canceledAt &&
		lifecycleAt
	) {
		projected.canceledAt = lifecycleAt;
	}
	return projected;
}

export function projectSubscriptionAgainstExisting(
	existing: Subscription,
	stream: SubscriptionDetailed,
): Partial<Subscription> {
	return reconcileProjectionAgainstExisting(existing, projectSubscriptionFields(stream));
}

export async function applySubscriptionProjection(
	adapter: PluginAdapter,
	stream: SubscriptionDetailed | null | undefined,
	log: { warn: (msg: string) => void },
	source: string,
): Promise<void> {
	const streampaySubscriptionId = stream?.id;
	if (!stream || !streampaySubscriptionId) return;
	try {
		const existing = await adapter.findOne<Subscription>({
			model: SUBSCRIPTION_MODEL,
			where: [{ field: "streampaySubscriptionId", value: streampaySubscriptionId }],
		});
		if (!existing) return;
		await adapter.update({
			model: SUBSCRIPTION_MODEL,
			update: projectSubscriptionAgainstExisting(existing, stream),
			where: [{ field: "id", value: existing.id }],
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		log.warn(
			`${source}: project for sub=${streampaySubscriptionId} failed (${message}). Local row will reconcile on next webhook.`,
		);
	}
}

export async function syncSubscriptionFromUpstream(
	client: { getSubscription: (id: string) => Promise<SubscriptionDetailed> },
	adapter: PluginAdapter,
	streampaySubscriptionId: string,
	log: { warn: (msg: string) => void },
	source: string,
	prefetched?: SubscriptionDetailed,
): Promise<void> {
	let stream = prefetched;
	if (!stream) {
		try {
			stream = await client.getSubscription(streampaySubscriptionId);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(
				`${source}: getSubscription(${streampaySubscriptionId}) failed (${message}). Local row will reconcile on next webhook.`,
			);
			return;
		}
	}
	await applySubscriptionProjection(adapter, stream, log, source);
}

export function projectSubscriptionFields(sub: SubscriptionDetailed): Partial<Subscription> {
	const status = toLocalStatus(sub.status);
	const terminal = isTerminalSubscriptionStatus(status);
	const periodStart = parseDate(sub.current_period_start);
	const periodEnd = parseDate(sub.current_period_end);
	return {
		streampaySubscriptionId: sub.id ?? null,
		streampayConsumerId: sub.organization_consumer_id ?? null,
		amountInSmallestUnit:
			typeof sub.amount_in_smallest_unit === "number"
				? sub.amount_in_smallest_unit
				: amountToSmallestUnit(sub.amount, sub.currency),
		originalAmountInSmallestUnit:
			typeof sub.original_amount_in_smallest_unit === "number"
				? sub.original_amount_in_smallest_unit
				: amountToSmallestUnit(sub.original_amount, sub.currency),
		currency: sub.currency ?? null,
		billingInterval: sub.recurring_interval ?? null,
		billingIntervalCount: sub.recurring_interval_count ?? null,
		status,
		providerStatus: sub.status ?? null,
		periodStart,
		periodEnd,
		currentCycleNumber: sub.current_cycle_number ?? null,
		trialStart: sub.trial_end ? (parseDate(sub.started_at) ?? periodStart) : null,
		trialEnd: parseDate(sub.trial_end),
		cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
		cancelAt: sub.cancel_at_period_end ? periodEnd : null,
		...(sub.cancel_at_period_end ? {} : { cancelScheduledAt: null }),
		endedAt: parseDate(sub.ended_at),
		frozenAt: sub.status === "FROZEN" ? parseDate(sub.latest_freeze?.freeze_start_datetime) : null,
		freezeEndAt: sub.status === "FROZEN" ? parseDate(sub.latest_freeze?.freeze_end_datetime) : null,
		providerUpdatedAt: parseDate(sub.updated_at),
		syncedAt: new Date(),
		...(terminal ? { activeSlotKey: null } : {}),
		updatedAt: new Date(),
	};
}

export function parseDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	// StreamPay webhook timestamps currently omit an RFC 3339 timezone suffix even
	// though they represent UTC. Letting Date parse those values directly makes
	// reconciliation depend on the host timezone (and can make a fresh event look
	// hours stale). Provider values that already carry an offset remain unchanged.
	const normalized =
		/[T ]/.test(value) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? `${value}Z` : value;
	const date = new Date(normalized);
	return Number.isNaN(date.getTime()) ? null : date;
}

function minorUnitExponent(currency: string | null | undefined): number | null {
	switch (currency) {
		case "BHD":
		case "KWD":
		case "OMR":
			return 3;
		case "SAR":
		case "USD":
		case "EUR":
		case "GBP":
		case "AED":
		case "QAR":
			return 2;
		default:
			return null;
	}
}

function amountToSmallestUnit(
	value: string | null | undefined,
	currency: string | null | undefined,
): number | null {
	if (!value) return null;
	const exponent = minorUnitExponent(currency);
	if (exponent === null) return null;
	const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
	if (!match) return null;
	const [, sign, integer, fraction = ""] = match;
	if (!integer) return null;
	const excessFraction = fraction.slice(exponent);
	if (excessFraction && !/^0+$/.test(excessFraction)) return null;
	const normalizedFraction = fraction.slice(0, exponent).padEnd(exponent, "0");
	const factor = 10n ** BigInt(exponent);
	const unsigned = BigInt(integer) * factor + BigInt(normalizedFraction || "0");
	const signed = sign === "-" ? -unsigned : unsigned;
	const numeric = Number(signed);
	return Number.isSafeInteger(numeric) ? numeric : null;
}

const SubscriptionItemSchema = z
	.object({
		product: z.object({ id: z.string() }).passthrough().optional(),
		product_id: z.string().optional(),
		quantity: z.number().optional(),
	})
	.passthrough();

export function subscriptionItemProductId(item: unknown): string | null {
	const parsed = SubscriptionItemSchema.safeParse(item);
	if (!parsed.success) return null;
	return parsed.data.product?.id ?? parsed.data.product_id ?? null;
}

export function subscriptionItemQuantity(item: unknown): number | null {
	const parsed = SubscriptionItemSchema.safeParse(item);
	if (!parsed.success || parsed.data.quantity === undefined) return null;
	return Number.isSafeInteger(parsed.data.quantity) && parsed.data.quantity > 0
		? parsed.data.quantity
		: null;
}

export function inferPlanFromItems(sub: SubscriptionDetailed, plans: ResolvedPlans): string | null {
	if (!Array.isArray(sub.items)) return null;
	return inferPlanFromItemList(sub.items, plans);
}

function inferPlanFromItemList(items: readonly unknown[], plans: ResolvedPlans): string | null {
	const productIds = new Set(
		items.map(subscriptionItemProductId).filter((id): id is string => Boolean(id)),
	);
	const matches = plans.list.filter((plan) => productIds.has(plan.productId));
	if (matches.length > 1) {
		throw new APIError("INTERNAL_SERVER_ERROR", {
			code: $ERROR_CODES.SUBSCRIPTION_INVALID_STATE.code,
			message: "StreamPay returned a subscription containing multiple configured plan products.",
		});
	}
	return matches[0]?.name ?? null;
}

export function projectPlanFields(
	sub: SubscriptionDetailed,
	plans: ResolvedPlans,
): Partial<
	Pick<
		Subscription,
		| "plan"
		| "planVersion"
		| "productId"
		| "group"
		| "seats"
		| "pendingPlan"
		| "pendingProductId"
		| "pendingPlanEffectiveAt"
		| "pendingSeats"
		| "pendingSeatsEffectiveAt"
	>
> {
	const currentPlan = inferPlanFromItems(sub, plans);
	const configuredCurrent = currentPlan ? plans.byName.get(currentPlan) : undefined;
	const currentItem = configuredCurrent
		? sub.items?.find((item) => subscriptionItemProductId(item) === configuredCurrent.productId)
		: sub.items?.[0];
	const currentProductId = subscriptionItemProductId(currentItem);
	const currentSeats = currentItem ? (subscriptionItemQuantity(currentItem) ?? 1) : null;
	const inferredPendingPlan = Array.isArray(sub.pending_change?.target_items)
		? inferPlanFromItemList(sub.pending_change.target_items, plans)
		: null;
	const configuredPending = inferredPendingPlan ? plans.byName.get(inferredPendingPlan) : undefined;
	const pendingItem = configuredPending
		? sub.pending_change?.target_items?.find(
				(item) => subscriptionItemProductId(item) === configuredPending.productId,
			)
		: currentProductId
			? sub.pending_change?.target_items?.find(
					(item) => subscriptionItemProductId(item) === currentProductId,
				)
			: sub.pending_change?.target_items?.[0];
	const pendingProductId = subscriptionItemProductId(pendingItem);
	const pendingSeats = pendingItem ? (subscriptionItemQuantity(pendingItem) ?? 1) : null;
	const pendingEffectiveAt = parseDate(sub.pending_change?.effective_at);
	const planChanges =
		Boolean(inferredPendingPlan) &&
		(inferredPendingPlan !== currentPlan || pendingProductId !== currentProductId);
	return {
		...(currentPlan
			? {
					plan: currentPlan,
					planVersion: configuredCurrent?.version ?? null,
					productId: currentProductId,
					group: configuredCurrent?.group ?? null,
				}
			: currentProductId
				? { productId: currentProductId }
				: {}),
		...(currentSeats === null ? {} : { seats: currentSeats }),
		pendingPlan: planChanges ? inferredPendingPlan : null,
		pendingProductId: planChanges ? pendingProductId : null,
		pendingPlanEffectiveAt: planChanges ? pendingEffectiveAt : null,
		pendingSeats,
		pendingSeatsEffectiveAt: pendingSeats === null ? null : pendingEffectiveAt,
	};
}
