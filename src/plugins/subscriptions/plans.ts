import { z } from "zod";
import type { PlansInput, StreamPayPlanLike, Subscription } from "./types";

export interface ResolvedPlans {
	list: readonly StreamPayPlanLike[];
	byName: Map<string, StreamPayPlanLike>;
}

const PlanSchema = z.object({
	name: z.string().min(1, "every plan must have a non-empty `name`."),
	productId: z.string().min(1, "missing a non-empty `productId`."),
	priceHalalat: z
		.number({ error: "must have a non-negative numeric `priceHalalat`." })
		.refine((n) => Number.isFinite(n) && n >= 0, {
			message: "must have a non-negative numeric `priceHalalat`.",
		}),
	billingInterval: z.enum(["WEEK", "MONTH", "QUARTER", "YEAR"], {
		error: () => "has invalid `billingInterval`. Expected one of: WEEK, MONTH, QUARTER, YEAR.",
	}),
	billingIntervalCount: z
		.number()
		.refine((n) => Number.isInteger(n) && n >= 1, {
			message: "has invalid `billingIntervalCount` — must be a positive integer.",
		})
		.optional(),
	group: z.string().optional(),
	limits: z.record(z.string(), z.unknown()).optional(),
});

const PlansSchema = z
	.array(PlanSchema)
	.nonempty("`plans` resolved to an empty list. Provide at least one plan.")
	.superRefine((plans, ctx) => {
		const seen = new Set<string>();
		for (const [index, plan] of plans.entries()) {
			if (seen.has(plan.name)) {
				ctx.addIssue({
					code: "custom",
					path: [index, "name"],
					message: `duplicate plan name "${plan.name}" — plan names must be unique.`,
				});
			}
			seen.add(plan.name);
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

/** Whether the subscription's plan grants `feature`. Returns false for non-live (expired/canceled) subscriptions. */
export function hasFeature<P extends StreamPayPlanLike>(
	subscription: Subscription,
	plan: P | undefined,
	feature: FeatureKey<P>,
): boolean {
	if (!plan?.limits) return false;
	if (subscription.status !== "active" && subscription.status !== "frozen") return false;
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

/** Check a numeric quota (`feature`) on the subscription's plan against `count`. */
export function checkLimit<P extends StreamPayPlanLike>(
	subscription: Subscription,
	plan: P | undefined,
	feature: FeatureKey<P>,
	requested: number,
): LimitCheckResult {
	if (!plan?.limits || (subscription.status !== "active" && subscription.status !== "frozen")) {
		return { allowed: false, limit: 0, remaining: 0 };
	}
	const raw = plan.limits[feature];
	const limit = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
	const normalizedRequested = Number.isFinite(requested) && requested >= 0 ? requested : 0;
	const allowed = normalizedRequested <= limit;
	const remaining = Math.max(0, limit - normalizedRequested);
	return { allowed, limit, remaining };
}
