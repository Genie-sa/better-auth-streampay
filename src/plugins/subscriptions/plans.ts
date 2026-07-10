import { z } from "zod";
import {
	DEFAULT_ACCESS_STATUSES,
	type PlansInput,
	type StreamPayPlanLike,
	type Subscription,
	type SubscriptionStatus,
} from "./types";

const SUBSCRIPTION_INTERVALS = ["WEEK", "MONTH", "QUARTER", "YEAR"] as const;

export interface ResolvedPlans {
	list: readonly StreamPayPlanLike[];
	byName: Map<string, StreamPayPlanLike>;
}

const PlanSchema = z.object({
	name: z.string().min(1, "every plan must have a non-empty `name`."),
	productId: z.string().min(1, "missing a non-empty `productId`."),
	priceInSmallestUnit: z.custom<number>(
		(value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
		"must have a non-negative safe-integer `priceInSmallestUnit`.",
	),
	currency: z.enum(["SAR", "USD", "EUR", "GBP", "AED", "BHD", "KWD", "OMR", "QAR"]).optional(),
	version: z.string().min(1, "has an empty `version`.").optional(),
	billingInterval: z.custom<(typeof SUBSCRIPTION_INTERVALS)[number]>(
		(value) =>
			typeof value === "string" && SUBSCRIPTION_INTERVALS.some((interval) => interval === value),
		"has invalid `billingInterval`. Expected one of: WEEK, MONTH, QUARTER, YEAR.",
	),
	billingIntervalCount: z
		.number()
		.refine((n) => Number.isInteger(n) && n >= 1, {
			message: "has invalid `billingIntervalCount` — must be a positive integer.",
		})
		.optional(),
	trialPeriodDays: z
		.number()
		.refine((n) => Number.isInteger(n) && n >= 1 && n <= 365, {
			message: "has invalid `trialPeriodDays` — must be an integer from 1 to 365.",
		})
		.optional(),
	group: z.string().min(1, "has an empty `group`.").optional(),
	limits: z.record(z.string(), z.unknown()).optional(),
});

const PlansSchema = z
	.array(PlanSchema)
	.nonempty("`plans` resolved to an empty list. Provide at least one plan.")
	.superRefine((plans, ctx) => {
		const seenNames = new Set<string>();
		const seenProductIds = new Set<string>();
		for (const [index, plan] of plans.entries()) {
			if (seenNames.has(plan.name)) {
				ctx.addIssue({
					code: "custom",
					path: [index, "name"],
					message: `duplicate plan name "${plan.name}" — plan names must be unique.`,
				});
			}
			seenNames.add(plan.name);
			if (seenProductIds.has(plan.productId)) {
				ctx.addIssue({
					code: "custom",
					path: [index, "productId"],
					message: `duplicate productId "${plan.productId}" — webhook plan inference requires unique product IDs.`,
				});
			}
			seenProductIds.add(plan.productId);
		}
	});

export function validatePlansShape(plans: readonly StreamPayPlanLike[]): void {
	const result = PlansSchema.safeParse(plans);
	if (result.success) return;
	const first = result.error.issues[0];
	if (!first) throw new TypeError("subscriptions(): invalid plans.");
	const planIndex = typeof first.path[0] === "number" ? first.path[0] : null;
	const label =
		planIndex !== null && first.path.length > 1
			? `plan "${plans[planIndex]?.name ?? planIndex}" `
			: "";
	throw new TypeError(`subscriptions(): ${label}${first.message}`);
}

function buildIndex(list: readonly StreamPayPlanLike[]): ResolvedPlans {
	const byName = new Map<string, StreamPayPlanLike>();
	for (const plan of list) byName.set(plan.name, plan);
	return { list, byName };
}

export function createPlanResolver(plans: PlansInput | undefined): () => Promise<ResolvedPlans> {
	let cached: ResolvedPlans | null = null;
	let inFlight: Promise<ResolvedPlans> | null = null;

	return async function getPlans(): Promise<ResolvedPlans> {
		if (cached) return cached;
		if (inFlight) return inFlight;
		if (!plans) throw new TypeError("subscriptions(): `plans` is required.");

		inFlight = (async () => {
			const list = typeof plans === "function" ? await plans() : plans;
			validatePlansShape(list);
			const resolved = buildIndex(list);
			cached = resolved;
			return resolved;
		})();

		try {
			return await inFlight;
		} finally {
			inFlight = null;
		}
	};
}

export type FeatureKey<P> = P extends { limits?: infer L }
	? L extends Record<string, unknown>
		? Extract<keyof L, string>
		: string
	: string;

export function hasSubscriptionAccess(
	subscription: Pick<Subscription, "status">,
	accessStatuses: readonly SubscriptionStatus[] = DEFAULT_ACCESS_STATUSES,
): boolean {
	return accessStatuses.includes(subscription.status);
}

export function hasFeature<P extends StreamPayPlanLike>(
	subscription: Subscription,
	plan: P | undefined,
	feature: FeatureKey<P>,
	accessStatuses: readonly SubscriptionStatus[] = DEFAULT_ACCESS_STATUSES,
): boolean {
	if (!plan?.limits) return false;
	if (!hasSubscriptionAccess(subscription, accessStatuses)) return false;
	const value = plan.limits[feature];
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value > 0;
	return Boolean(value);
}

export interface LimitCheckResult {
	allowed: boolean;
	limit: number;
	remaining: number;
}

export function checkLimit<P extends StreamPayPlanLike>(
	subscription: Subscription,
	plan: P | undefined,
	feature: FeatureKey<P>,
	requested: number,
	accessStatuses: readonly SubscriptionStatus[] = DEFAULT_ACCESS_STATUSES,
): LimitCheckResult {
	if (!plan?.limits || !hasSubscriptionAccess(subscription, accessStatuses)) {
		return { allowed: false, limit: 0, remaining: 0 };
	}
	const raw = plan.limits[feature];
	const limit = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
	const normalizedRequested = Number.isFinite(requested) && requested >= 0 ? requested : 0;
	const allowed = normalizedRequested <= limit;
	const remaining = Math.max(0, limit - normalizedRequested);
	return { allowed, limit, remaining };
}
