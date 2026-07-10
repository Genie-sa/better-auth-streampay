import type { GenericEndpointContext } from "better-auth";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { authorizeReference, getAdapter, requireUser, resolveReference } from "./access";
import { checkLimit, hasFeature, hasSubscriptionAccess, type ResolvedPlans } from "./plans";
import { DEFAULT_ACCESS_STATUSES, type Subscription, type SubscriptionsOptions } from "./types";

const SUBSCRIPTION_MODEL = "subscription";

const ReferenceQueryFields = {
	referenceId: z.string().min(1).optional(),
	referenceType: z.enum(["user", "organization", "custom"]).optional(),
} as const;

const ListQuery = z.object(ReferenceQueryFields).optional();

const CurrentQuery = z
	.object({
		...ReferenceQueryFields,
		group: z.string().min(1).optional(),
	})
	.optional();

const HasFeatureQuery = z.object({
	...ReferenceQueryFields,
	feature: z.string().min(1),
	group: z.string().min(1).optional(),
});

const CheckLimitQuery = z.object({
	...ReferenceQueryFields,
	feature: z.string().min(1),
	count: z.coerce.number().int().min(0),
	group: z.string().min(1).optional(),
});

async function resolveLiveSubscription(
	ctx: GenericEndpointContext,
	query: {
		referenceId?: string | undefined;
		referenceType?: "user" | "organization" | "custom" | undefined;
		group?: string | undefined;
	},
	subsOptions: SubscriptionsOptions,
	accessStatuses: readonly Subscription["status"][],
): Promise<Subscription | null> {
	const user = requireUser(ctx);
	const reference = resolveReference(user, query);
	await authorizeReference(
		ctx,
		user,
		reference.referenceId,
		reference.referenceType,
		"read",
		subsOptions,
	);
	const rows = await getAdapter(ctx).findMany<Subscription>({
		model: SUBSCRIPTION_MODEL,
		where: [
			{ field: "referenceId", value: reference.referenceId },
			{ field: "referenceType", value: reference.referenceType },
			{ field: "group", value: query.group ?? null },
		],
	});
	return rows.find((row) => hasSubscriptionAccess(row, accessStatuses)) ?? null;
}

export function buildSubscriptionReadEndpoints(
	subsOptions: SubscriptionsOptions,
	plansRef: () => Promise<ResolvedPlans>,
) {
	const accessStatuses = subsOptions.accessStatuses ?? DEFAULT_ACCESS_STATUSES;
	return {
		listSubscriptions: createAuthEndpoint(
			"/subscription/list",
			{
				method: "GET",
				query: ListQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = requireUser(ctx);
				const reference = resolveReference(user, ctx.query);
				await authorizeReference(
					ctx,
					user,
					reference.referenceId,
					reference.referenceType,
					"read",
					subsOptions,
				);
				const rows = await getAdapter(ctx).findMany<Subscription>({
					model: SUBSCRIPTION_MODEL,
					where: [
						{ field: "referenceId", value: reference.referenceId },
						{ field: "referenceType", value: reference.referenceType },
					],
				});
				const plans = await plansRef();
				return ctx.json(
					rows.map((row) => ({
						...row,
						plan: plans.byName.get(row.plan) ?? null,
					})),
				);
			},
		),

		currentSubscription: createAuthEndpoint(
			"/subscription/current",
			{
				method: "GET",
				query: CurrentQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const live = await resolveLiveSubscription(
					ctx,
					ctx.query ?? {},
					subsOptions,
					accessStatuses,
				);
				if (!live) return ctx.json(null);
				const plans = await plansRef();
				return ctx.json({ ...live, plan: plans.byName.get(live.plan) ?? null });
			},
		),

		hasSubscriptionFeature: createAuthEndpoint(
			"/subscription/has-feature",
			{
				method: "GET",
				query: HasFeatureQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const live = await resolveLiveSubscription(ctx, ctx.query, subsOptions, accessStatuses);
				if (!live) return ctx.json({ hasFeature: false });
				const plan = (await plansRef()).byName.get(live.plan);
				return ctx.json({
					hasFeature: hasFeature(live, plan, ctx.query.feature, accessStatuses),
				});
			},
		),

		checkSubscriptionLimit: createAuthEndpoint(
			"/subscription/check-limit",
			{
				method: "GET",
				query: CheckLimitQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const live = await resolveLiveSubscription(ctx, ctx.query, subsOptions, accessStatuses);
				if (!live) return ctx.json({ allowed: false, limit: 0, remaining: 0 });
				const plan = (await plansRef()).byName.get(live.plan);
				return ctx.json(checkLimit(live, plan, ctx.query.feature, ctx.query.count, accessStatuses));
			},
		),
	};
}
