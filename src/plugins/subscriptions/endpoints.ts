import type {
	CreatePaymentLinkDto,
	FreezeSubscriptionCreateRequest,
	SubscriptionCancel,
	SubscriptionDetailed,
	SubscriptionUpdate,
} from "@streamsdk/typescript";
import type { GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { $ERROR_CODES } from "../../error-codes";
import type { StreamPayOptions } from "../../types";
import { StreamPayAmount } from "../../utils/amount";
import { ensureConsumerForUser } from "../../utils/ensure-consumer";
import { toAPIError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import { asSessionUser, type StreamPaySessionUser } from "../../utils/session";
import { checkLimit, hasFeature, type ResolvedPlans } from "./plans";
import {
	type PluginAdapter,
	subscriptionItemProductId,
	syncSubscriptionFromUpstream,
} from "./sync";
import {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	type Subscription,
	type SubscriptionsOptions,
	UPGRADE_IDEMPOTENCY_WINDOW_MS,
} from "./types";

const SUBSCRIPTION_MODEL = "subscription";

const UpgradeBody = z.object({
	plan: z.string().min(1),
	referenceId: z.string().min(1).optional(),
	successUrl: z.string().url().optional(),
	failureUrl: z.string().url().optional(),
});

const SuccessQuery = z.object({
	subscriptionId: z.string().uuid(),
	callbackURL: z.string().url().optional(),
});

const CancelBody = z.object({
	subscriptionId: z.string().uuid(),
	cancelRelatedInvoices: z.boolean().optional(),
	cancelAtPeriodEnd: z.boolean().optional(),
});

const ChangePlanBody = z.object({
	plan: z.string().min(1),
	mode: z.enum(["at_period_end", "immediate"]).optional(),
	successUrl: z.string().url().optional(),
	failureUrl: z.string().url().optional(),
});

const FreezeBody = z.object({
	subscriptionId: z.string().uuid(),
	freezeStartDatetime: z.string().datetime(),
	freezeEndDatetime: z.string().datetime().nullable().optional(),
	notes: z.string().optional(),
});

const UnfreezeBody = z.object({
	subscriptionId: z.string().uuid(),
});

const CurrentQuery = z
	.object({
		group: z.string().min(1).optional(),
	})
	.optional();

const HasFeatureQuery = z.object({
	feature: z.string().min(1),
	group: z.string().min(1).optional(),
});

const CheckLimitQuery = z.object({
	feature: z.string().min(1),
	count: z.coerce.number().int().min(0),
	group: z.string().min(1).optional(),
});

function requireUser(ctx: GenericEndpointContext): StreamPaySessionUser {
	const user = asSessionUser(ctx.context.session?.user);
	if (!user) {
		throw new APIError("UNAUTHORIZED", {
			message: "Subscription endpoints require an authenticated session.",
		});
	}
	if (user.isAnonymous) {
		throw new APIError("UNAUTHORIZED", {
			message: "Anonymous users cannot manage subscriptions.",
		});
	}
	return user;
}

async function authorizeReference(
	ctx: GenericEndpointContext,
	user: StreamPaySessionUser,
	referenceId: string,
	action: "upgrade" | "cancel" | "freeze" | "unfreeze" | "read" | "change-plan",
	subsOptions: SubscriptionsOptions,
): Promise<void> {
	if (referenceId === user.id) return;
	if (!subsOptions.authorizeReference) {
		throw new APIError("FORBIDDEN", {
			code: $ERROR_CODES.FORBIDDEN.code,
			message: "Cross-account subscription actions require an `authorizeReference` callback.",
		});
	}
	const ok = await subsOptions.authorizeReference({ user, referenceId, action }, ctx);
	if (!ok) {
		throw new APIError("FORBIDDEN", {
			code: "SUBSCRIPTION_REFERENCE_NOT_AUTHORIZED",
			message: "Not authorized for this subscription reference.",
		});
	}
}

function getAdapter(ctx: GenericEndpointContext): PluginAdapter {
	const adapter = ctx.context.adapter;
	if (!adapter) {
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: "Better Auth adapter is not available on the request context.",
		});
	}
	return adapter as unknown as PluginAdapter;
}

function echoSubscriptionPatch(
	stream: SubscriptionDetailed,
): Pick<SubscriptionUpdate, "items" | "coupons"> {
	const items: SubscriptionUpdate["items"] = [];
	for (const item of stream.items ?? []) {
		const productId = item.product?.id;
		const quantity = item.quantity;
		if (!productId || quantity === undefined) continue;
		items.push({ product_id: productId, quantity });
	}
	const coupons: SubscriptionUpdate["coupons"] = [];
	for (const c of stream.coupon_calculation_metadata?.coupons ?? []) {
		if (c.coupon_id) coupons.push(c.coupon_id);
	}
	return { items, coupons };
}

async function findOwnedSubscription(
	ctx: GenericEndpointContext,
	user: StreamPaySessionUser,
	streampaySubscriptionId: string,
	subsOptions: SubscriptionsOptions,
	action: "cancel" | "freeze" | "unfreeze" | "change-plan",
): Promise<Subscription> {
	const adapter = getAdapter(ctx);
	const row = await adapter.findOne<Subscription>({
		model: SUBSCRIPTION_MODEL,
		where: [{ field: "streampaySubscriptionId", value: streampaySubscriptionId }],
	});
	if (!row) {
		throw new APIError("NOT_FOUND", {
			code: "SUBSCRIPTION_NOT_FOUND",
			message: "Subscription not found.",
		});
	}
	await authorizeReference(ctx, user, row.referenceId, action, subsOptions);
	return row;
}

export function buildSubscriptionEndpoints(
	options: StreamPayOptions,
	subsOptions: SubscriptionsOptions,
	plansRef: () => Promise<ResolvedPlans>,
) {
	const client = options.client;

	return {
		upgradeSubscription: createAuthEndpoint(
			"/subscription/upgrade",
			{
				method: "POST",
				body: UpgradeBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = requireUser(ctx);
				const referenceId = ctx.body.referenceId ?? user.id;
				await authorizeReference(ctx, user, referenceId, "upgrade", subsOptions);

				const plans = await plansRef();
				const plan = plans.byName.get(ctx.body.plan);
				if (!plan) {
					throw new APIError("NOT_FOUND", {
						code: "SUBSCRIPTION_PLAN_NOT_FOUND",
						message: `Plan "${ctx.body.plan}" is not configured.`,
					});
				}

				const adapter = getAdapter(ctx);
				const existingActive = await adapter.findMany<Subscription>({
					model: SUBSCRIPTION_MODEL,
					where: [
						{ field: "referenceId", value: referenceId },
						...(plan.group ? [{ field: "group", value: plan.group }] : []),
					],
				});
				const liveActive = existingActive.find(
					(row) => row.status === "active" || row.status === "frozen" || row.status === "past_due",
				);
				if (liveActive) {
					throw new APIError("CONFLICT", {
						code: "SUBSCRIPTION_ALREADY_ACTIVE",
						message: plan.group
							? `An active subscription already exists in plan group "${plan.group}". Cancel it before upgrading.`
							: "An active subscription already exists. Cancel it before upgrading.",
					});
				}

				const now = Date.now();
				const reuseCandidate = existingActive.find(
					(row) =>
						row.plan === plan.name &&
						row.status === "incomplete" &&
						row.createdAt instanceof Date &&
						now - row.createdAt.getTime() < UPGRADE_IDEMPOTENCY_WINDOW_MS,
				);
				if (reuseCandidate) {
					return ctx.json({
						subscriptionId: reuseCandidate.id,
						reused: true,
						status: reuseCandidate.status,
						plan: reuseCandidate.plan,
					});
				}

				const ensureCtx = { context: ctx.context };
				const { consumerId } = await ensureConsumerForUser(options, ensureCtx, user);

				const linkInput: CreatePaymentLinkDto = {
					name: `Subscription — ${plan.name}`,
					items: [{ product_id: plan.productId, quantity: 1, allow_custom_quantity: false }],
					max_number_of_payments: 1,
					organization_consumer_id: consumerId,
					custom_metadata: {
						[PLAN_NAME_METADATA_KEY]: plan.name,
						[REFERENCE_ID_METADATA_KEY]: referenceId,
					},
				};
				if (ctx.body.successUrl) linkInput.success_redirect_url = ctx.body.successUrl;
				if (ctx.body.failureUrl) linkInput.failure_redirect_url = ctx.body.failureUrl;

				let url: string | null;
				let paymentLinkId: string;
				try {
					const link = await client.createPaymentLink(linkInput);
					if (!link?.id) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "StreamPay returned a payment link without an id.",
						});
					}
					paymentLinkId = link.id;
					url = client.getPaymentUrl(link);
				} catch (err) {
					toAPIError(
						{
							logPrefix: `upgradeSubscription failed for plan=${plan.name} ref=${referenceId}:`,
							userMessage: "Failed to start subscription checkout.",
						},
						err,
						getLogger(ctx),
					);
				}

				if (!url) {
					getLogger(ctx).error(`createPaymentLink returned link=${paymentLinkId} with no url.`);
					throw new APIError("INTERNAL_SERVER_ERROR", {
						message: "Payment link was created but no URL was returned.",
					});
				}

				const row = await adapter.create<Subscription>({
					model: SUBSCRIPTION_MODEL,
					data: {
						referenceId,
						plan: plan.name,
						group: plan.group ?? null,
						streampayConsumerId: consumerId,
						status: "incomplete",
						amountHalalat: plan.priceHalalat,
						currency: "SAR",
						billingInterval: plan.billingInterval,
						billingIntervalCount: plan.billingIntervalCount ?? 1,
						cancelAtPeriodEnd: false,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				});

				return ctx.json({
					subscriptionId: row.id,
					url,
					redirect: true,
					reused: false,
					status: "incomplete",
					plan: plan.name,
				});
			},
		),

		subscriptionSuccess: createAuthEndpoint(
			"/subscription/success",
			{
				method: "GET",
				query: SuccessQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = requireUser(ctx);
				const adapter = getAdapter(ctx);
				const row = await adapter.findOne<Subscription>({
					model: SUBSCRIPTION_MODEL,
					where: [{ field: "id", value: ctx.query.subscriptionId }],
				});
				if (!row) {
					throw new APIError("NOT_FOUND", {
						code: "SUBSCRIPTION_NOT_FOUND",
						message: "Subscription not found.",
					});
				}
				await authorizeReference(ctx, user, row.referenceId, "read", subsOptions);

				if (row.status !== "incomplete") {
					return ctx.json({
						subscription: row,
						synced: false,
					});
				}

				if (!row.streampayConsumerId) {
					return ctx.json({ subscription: row, synced: false });
				}
				try {
					const plans = await plansRef();
					const plan = plans.byName.get(row.plan);
					if (!plan) {
						getLogger(ctx).warn(
							`subscriptionSuccess: plan "${row.plan}" is no longer configured — skipping fallback sync for row=${row.id}.`,
						);
						return ctx.json({ subscription: row, synced: false });
					}
					const list = await client.listSubscriptions({ page: 1, size: 100 });
					const match = list.data?.find(
						(sub) =>
							sub.organization_consumer_id === row.streampayConsumerId &&
							sub.status !== "CANCELED" &&
							Array.isArray(sub.items) &&
							sub.items.some((item) => subscriptionItemProductId(item) === plan.productId),
					);
					if (!match?.id) {
						return ctx.json({ subscription: row, synced: false });
					}
					const updated = await adapter.update<Subscription>({
						model: SUBSCRIPTION_MODEL,
						update: {
							streampaySubscriptionId: match.id,
							status: match.status === "ACTIVE" ? "active" : "incomplete",
							periodStart: match.current_period_start ? new Date(match.current_period_start) : null,
							periodEnd: match.current_period_end ? new Date(match.current_period_end) : null,
							amountHalalat: (() => {
								if (!match.amount) return row.amountHalalat;
								try {
									return StreamPayAmount.toHalalat(match.amount);
								} catch {
									return row.amountHalalat;
								}
							})(),
							updatedAt: new Date(),
						},
						where: [{ field: "id", value: row.id }],
					});
					return ctx.json({ subscription: updated ?? row, synced: true });
				} catch (err) {
					toAPIError(
						`subscriptionSuccess fallback sync failed for row=${row.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		cancelSubscription: createAuthEndpoint(
			"/subscription/cancel",
			{
				method: "POST",
				body: CancelBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = requireUser(ctx);
				const adapter = getAdapter(ctx);
				const row = await findOwnedSubscription(
					ctx,
					user,
					ctx.body.subscriptionId,
					subsOptions,
					"cancel",
				);
				if (row.status === "canceled") {
					throw new APIError("BAD_REQUEST", {
						code: "SUBSCRIPTION_ALREADY_CANCELED",
						message: "Subscription is already canceled.",
					});
				}
				if (row.cancelAtPeriodEnd) {
					throw new APIError("BAD_REQUEST", {
						code: "SUBSCRIPTION_ALREADY_SCHEDULED_CANCEL",
						message: "Subscription is already scheduled to cancel at period end.",
					});
				}
				if (!row.streampaySubscriptionId) {
					throw new APIError("BAD_REQUEST", {
						code: "SUBSCRIPTION_INVALID_STATE",
						message: "Subscription has not been confirmed by StreamPay yet.",
					});
				}

				if (ctx.body.cancelAtPeriodEnd) {
					try {
						const stream = await client.getSubscription(row.streampaySubscriptionId);
						const patch: SubscriptionUpdate = {
							...echoSubscriptionPatch(stream),
							until_cycle_number: stream.current_cycle_number ?? 1,
						};
						const result = await client.updateSubscription(row.streampaySubscriptionId, patch);
						await adapter.update({
							model: SUBSCRIPTION_MODEL,
							update: {
								cancelAtPeriodEnd: true,
								updatedAt: new Date(),
							},
							where: [{ field: "id", value: row.id }],
						});
						return ctx.json(result);
					} catch (err) {
						toAPIError(
							{
								logPrefix: `cancelAtPeriodEnd failed for row=${row.id}:`,
								userMessage: "Subscription cancel-at-period-end failed.",
							},
							err,
							getLogger(ctx),
						);
					}
				}

				const payload: SubscriptionCancel = {
					cancel_related_invoices: ctx.body.cancelRelatedInvoices ?? false,
				};
				try {
					const result = await client.cancelSubscription(row.streampaySubscriptionId, payload);
					await syncSubscriptionFromUpstream(
						client,
						adapter,
						row.streampaySubscriptionId,
						getLogger(ctx),
						"cancelSubscription",
					);
					return ctx.json(result);
				} catch (err) {
					toAPIError(
						{
							logPrefix: `cancelSubscription failed for row=${row.id}:`,
							userMessage: "Subscription cancellation failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),

		changeSubscriptionPlan: createAuthEndpoint(
			"/subscription/change-plan",
			{
				method: "POST",
				body: ChangePlanBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = requireUser(ctx);
				const adapter = getAdapter(ctx);
				const plans = await plansRef();
				const nextPlan = plans.byName.get(ctx.body.plan);
				if (!nextPlan) {
					throw new APIError("NOT_FOUND", {
						code: "SUBSCRIPTION_PLAN_NOT_FOUND",
						message: `Plan "${ctx.body.plan}" is not configured.`,
					});
				}

				const existing = await adapter.findMany<Subscription>({
					model: SUBSCRIPTION_MODEL,
					where: [
						{ field: "referenceId", value: user.id },
						...(nextPlan.group ? [{ field: "group", value: nextPlan.group }] : []),
					],
				});
				const row = existing.find(
					(r) => r.status === "active" || r.status === "frozen" || r.status === "past_due",
				);
				if (!row) {
					throw new APIError("NOT_FOUND", {
						code: "SUBSCRIPTION_NOT_FOUND",
						message: "No active subscription to change plan from.",
					});
				}
				await authorizeReference(ctx, user, row.referenceId, "change-plan", subsOptions);
				if (!row.streampaySubscriptionId) {
					throw new APIError("BAD_REQUEST", {
						code: "SUBSCRIPTION_INVALID_STATE",
						message: "Subscription has not been confirmed by StreamPay yet.",
					});
				}
				if (row.plan === nextPlan.name) {
					throw new APIError("BAD_REQUEST", {
						code: "SUBSCRIPTION_ALREADY_ON_PLAN",
						message: `Already on plan "${nextPlan.name}".`,
					});
				}

				const mode = ctx.body.mode ?? "at_period_end";

				if (mode === "immediate") {
					try {
						const stream = await client.getSubscription(row.streampaySubscriptionId);
						const existingCoupons: SubscriptionUpdate["coupons"] = [];
						for (const c of stream.coupon_calculation_metadata?.coupons ?? []) {
							if (c.coupon_id) existingCoupons.push(c.coupon_id);
						}
						const patch: SubscriptionUpdate = {
							items: [{ product_id: nextPlan.productId, quantity: 1 }],
							coupons: existingCoupons,
						};
						const result = await client.updateSubscription(row.streampaySubscriptionId, patch);
						await adapter.update({
							model: SUBSCRIPTION_MODEL,
							update: {
								plan: nextPlan.name,
								group: nextPlan.group ?? null,
								updatedAt: new Date(),
							},
							where: [{ field: "id", value: row.id }],
						});
						await syncSubscriptionFromUpstream(
							client,
							adapter,
							row.streampaySubscriptionId,
							getLogger(ctx),
							"changeSubscriptionPlan",
						);
						return ctx.json({
							mode: "immediate",
							subscription: result,
							plan: nextPlan.name,
						});
					} catch (err) {
						toAPIError(
							{
								logPrefix: `change-plan (immediate) failed for row=${row.id}:`,
								userMessage: "Plan change failed.",
							},
							err,
							getLogger(ctx),
						);
					}
				}

				try {
					const stream = await client.getSubscription(row.streampaySubscriptionId);
					const patch: SubscriptionUpdate = {
						...echoSubscriptionPatch(stream),
						until_cycle_number: stream.current_cycle_number ?? 1,
					};
					await client.updateSubscription(row.streampaySubscriptionId, patch);
					await adapter.update({
						model: SUBSCRIPTION_MODEL,
						update: {
							cancelAtPeriodEnd: true,
							updatedAt: new Date(),
						},
						where: [{ field: "id", value: row.id }],
					});

					const ensureCtx = { context: ctx.context };
					const { consumerId } = await ensureConsumerForUser(options, ensureCtx, user);
					const linkInput: CreatePaymentLinkDto = {
						name: `Plan change — ${nextPlan.name}`,
						items: [
							{
								product_id: nextPlan.productId,
								quantity: 1,
								allow_custom_quantity: false,
							},
						],
						max_number_of_payments: 1,
						organization_consumer_id: consumerId,
						custom_metadata: {
							[PLAN_NAME_METADATA_KEY]: nextPlan.name,
							[REFERENCE_ID_METADATA_KEY]: user.id,
						},
					};
					if (ctx.body.successUrl) linkInput.success_redirect_url = ctx.body.successUrl;
					if (ctx.body.failureUrl) linkInput.failure_redirect_url = ctx.body.failureUrl;
					const link = await client.createPaymentLink(linkInput);
					const url = client.getPaymentUrl(link);

					const nextRow = await adapter.create<Subscription>({
						model: SUBSCRIPTION_MODEL,
						data: {
							referenceId: user.id,
							plan: nextPlan.name,
							group: nextPlan.group ?? null,
							streampayConsumerId: consumerId,
							status: "incomplete",
							amountHalalat: nextPlan.priceHalalat,
							currency: "SAR",
							billingInterval: nextPlan.billingInterval,
							billingIntervalCount: nextPlan.billingIntervalCount ?? 1,
							cancelAtPeriodEnd: false,
							createdAt: new Date(),
							updatedAt: new Date(),
						},
					});

					return ctx.json({
						mode: "at_period_end",
						currentSubscriptionId: row.id,
						nextSubscriptionId: nextRow.id,
						url,
						plan: nextPlan.name,
					});
				} catch (err) {
					toAPIError(
						{
							logPrefix: `change-plan (at_period_end) failed for row=${row.id}:`,
							userMessage: "Plan change scheduling failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),

		freezeSubscription: createAuthEndpoint(
			"/subscription/freeze",
			{
				method: "POST",
				body: FreezeBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = requireUser(ctx);
				const adapter = getAdapter(ctx);
				const row = await findOwnedSubscription(
					ctx,
					user,
					ctx.body.subscriptionId,
					subsOptions,
					"freeze",
				);
				if (row.status !== "active") {
					throw new APIError("BAD_REQUEST", {
						code: "SUBSCRIPTION_INVALID_STATE",
						message: "Only active subscriptions can be frozen.",
					});
				}
				if (!row.streampaySubscriptionId) {
					throw new APIError("BAD_REQUEST", {
						code: "SUBSCRIPTION_INVALID_STATE",
						message: "Subscription has not been confirmed by StreamPay yet.",
					});
				}

				const payload: FreezeSubscriptionCreateRequest = {
					freeze_start_datetime: ctx.body.freezeStartDatetime,
				};
				if (ctx.body.freezeEndDatetime !== undefined) {
					payload.freeze_end_datetime = ctx.body.freezeEndDatetime;
				}
				if (ctx.body.notes !== undefined) {
					payload.notes = ctx.body.notes;
				}

				try {
					const freeze = await client.freezeSubscription(row.streampaySubscriptionId, payload);
					await syncSubscriptionFromUpstream(
						client,
						adapter,
						row.streampaySubscriptionId,
						getLogger(ctx),
						"freezeSubscription",
					);
					return ctx.json(freeze);
				} catch (err) {
					toAPIError(
						{
							logPrefix: `freezeSubscription failed for row=${row.id}:`,
							userMessage: "Subscription freeze failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),

		unfreezeSubscription: createAuthEndpoint(
			"/subscription/unfreeze",
			{
				method: "POST",
				body: UnfreezeBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = requireUser(ctx);
				const adapter = getAdapter(ctx);
				const row = await findOwnedSubscription(
					ctx,
					user,
					ctx.body.subscriptionId,
					subsOptions,
					"unfreeze",
				);
				if (row.status !== "frozen") {
					throw new APIError("BAD_REQUEST", {
						code: "SUBSCRIPTION_NOT_FROZEN",
						message: "Subscription is not currently frozen.",
					});
				}
				if (!row.streampaySubscriptionId) {
					throw new APIError("BAD_REQUEST", {
						code: "SUBSCRIPTION_INVALID_STATE",
						message: "Subscription has not been confirmed by StreamPay yet.",
					});
				}

				const nowMs = Date.now();
				try {
					const freezes = await client.listSubscriptionFreezes(row.streampaySubscriptionId);
					const active = freezes.data?.find((freeze) => {
						if (!freeze.id || !freeze.freeze_start_datetime) return false;
						const start = new Date(freeze.freeze_start_datetime).getTime();
						const end = freeze.freeze_end_datetime
							? new Date(freeze.freeze_end_datetime).getTime()
							: Number.POSITIVE_INFINITY;
						return start <= nowMs && nowMs <= end;
					});
					if (!active?.id || !active.freeze_start_datetime) {
						throw new APIError("BAD_REQUEST", {
							code: "SUBSCRIPTION_NOT_FROZEN",
							message: "No active freeze period found to cancel.",
						});
					}

					await client.updateSubscriptionFreeze(row.streampaySubscriptionId, active.id, {
						freeze_start_datetime: active.freeze_start_datetime,
						freeze_end_datetime: new Date(nowMs).toISOString(),
						notes: active.notes ?? null,
					});
					await syncSubscriptionFromUpstream(
						client,
						adapter,
						row.streampaySubscriptionId,
						getLogger(ctx),
						"unfreezeSubscription",
					);
					return ctx.json({ unfrozen: true });
				} catch (err) {
					toAPIError(
						{
							logPrefix: `unfreezeSubscription failed for row=${row.id}:`,
							userMessage: "Subscription unfreeze failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),

		listSubscriptions: createAuthEndpoint(
			"/subscription/list",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = requireUser(ctx);
				const adapter = getAdapter(ctx);
				const rows = await adapter.findMany<Subscription>({
					model: SUBSCRIPTION_MODEL,
					where: [{ field: "referenceId", value: user.id }],
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
				const user = requireUser(ctx);
				const adapter = getAdapter(ctx);
				const where: Array<{ field: string; value: unknown }> = [
					{ field: "referenceId", value: user.id },
				];
				if (ctx.query?.group) {
					where.push({ field: "group", value: ctx.query.group });
				}
				const rows = await adapter.findMany<Subscription>({
					model: SUBSCRIPTION_MODEL,
					where,
				});
				const live = rows.find(
					(row) => row.status === "active" || row.status === "frozen" || row.status === "past_due",
				);
				if (!live) return ctx.json(null);
				const plans = await plansRef();
				return ctx.json({
					...live,
					plan: plans.byName.get(live.plan) ?? null,
				});
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
				const user = requireUser(ctx);
				const adapter = getAdapter(ctx);
				const where: Array<{ field: string; value: unknown }> = [
					{ field: "referenceId", value: user.id },
				];
				if (ctx.query.group) where.push({ field: "group", value: ctx.query.group });
				const rows = await adapter.findMany<Subscription>({ model: SUBSCRIPTION_MODEL, where });
				const plans = await plansRef();
				const live = rows.find((row) => row.status === "active" || row.status === "frozen");
				if (!live) return ctx.json({ hasFeature: false });
				const plan = plans.byName.get(live.plan);
				return ctx.json({ hasFeature: hasFeature(live, plan, ctx.query.feature) });
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
				const user = requireUser(ctx);
				const adapter = getAdapter(ctx);
				const where: Array<{ field: string; value: unknown }> = [
					{ field: "referenceId", value: user.id },
				];
				if (ctx.query.group) where.push({ field: "group", value: ctx.query.group });
				const rows = await adapter.findMany<Subscription>({ model: SUBSCRIPTION_MODEL, where });
				const plans = await plansRef();
				const live = rows.find((row) => row.status === "active" || row.status === "frozen");
				if (!live) return ctx.json({ allowed: false, limit: 0, remaining: 0 });
				const plan = plans.byName.get(live.plan);
				return ctx.json(checkLimit(live, plan, ctx.query.feature, ctx.query.count));
			},
		),
	};
}
