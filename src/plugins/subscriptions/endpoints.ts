import type {
	CreatePaymentLinkDto,
	FreezeSubscriptionCreateRequest,
	SubscriptionCancel,
	SubscriptionDetailed,
	SubscriptionUpdate,
} from "@streamsdk/typescript";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { $ERROR_CODES } from "../../error-codes";
import type { StreamPayOptions } from "../../types";
import { ensureConsumerForUser } from "../../utils/ensure-consumer";
import { toAPIError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import {
	authorizeReference,
	getAdapter,
	requireConfirmedOwnedSubscription,
	requireUser,
} from "./access";
import { deleteReservedSubscription, resumeOrReserveCheckoutSlot } from "./checkout-reservation";
import {
	configuredPlanForSubscription,
	isAlreadyCanceledFreezeError,
	subscriptionCouponIds,
	subscriptionItemsForUpdate,
} from "./lifecycle";
import type { ResolvedPlans } from "./plans";
import { buildSubscriptionReadEndpoints } from "./reads";
import {
	parseDate,
	projectPlanFields,
	projectSubscriptionAgainstExisting,
	projectSubscriptionFields,
	subscriptionItemProductId,
	subscriptionItemQuantity,
	syncSubscriptionFromUpstream,
} from "./reconcile";
import { buildSeatCheckoutItem, quotedSeatTotal, resolveSeatCount } from "./seats";
import { isCheckoutSuccessStatus, isManageableSubscriptionStatus } from "./status";
import {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	REFERENCE_TYPE_METADATA_KEY,
	SUBSCRIPTION_ROW_ID_METADATA_KEY,
	type Subscription,
	type SubscriptionReferenceType,
	type SubscriptionsOptions,
	subscriptionSlotKey,
} from "./types";

const SUBSCRIPTION_MODEL = "subscription";
const UpgradeBody = z
	.object({
		plan: z.string().min(1),
		seats: z.number().int().positive().safe().optional(),
		referenceId: z.string().min(1).optional(),
		referenceType: z.enum(["user", "organization", "custom"]).optional(),
		successUrl: z.string().url().optional(),
		failureUrl: z.string().url().optional(),
	})
	.strict();

const SuccessQuery = z.object({
	subscriptionId: z.string().min(1),
});

const CancelBody = z.object({
	subscriptionId: z.string().min(1),
	cancelRelatedInvoices: z.boolean().optional(),
	cancelAtPeriodEnd: z.boolean().optional(),
});

const ChangePlanBody = z
	.object({
		subscriptionId: z.string().min(1),
		plan: z.string().min(1),
		seats: z.number().int().positive().safe().optional(),
	})
	.strict();

const UpdateSeatsBody = z
	.object({
		subscriptionId: z.string().min(1),
		seats: z.number().int().positive().safe(),
	})
	.strict();

const FreezeBody = z.object({
	subscriptionId: z.string().min(1),
	freezeStartDatetime: z.string().datetime(),
	freezeEndDatetime: z.string().datetime().nullable().optional(),
	notes: z.string().optional(),
});

const UnfreezeBody = z.object({
	subscriptionId: z.string().min(1),
});

const CancelFreezeBody = z.object({
	subscriptionId: z.string().min(1),
	freezeId: z.string().min(1),
});

const SUCCESS_RECONCILIATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

function isCheckoutSubscriptionCandidate(
	subscription: SubscriptionDetailed,
	row: Subscription,
	productId: string,
): boolean {
	if (subscription.organization_consumer_id !== row.streampayConsumerId) return false;
	if (!isCheckoutSuccessStatus(subscription.status)) return false;
	if (!subscription.items?.some((item) => subscriptionItemProductId(item) === productId)) {
		return false;
	}

	const upstreamPaymentLinkId = subscription.latest_invoice?.payment_link_id;
	if (
		row.streampayPaymentLinkId &&
		upstreamPaymentLinkId &&
		upstreamPaymentLinkId !== row.streampayPaymentLinkId
	) {
		return false;
	}
	if (row.streampayPaymentLinkId && upstreamPaymentLinkId === row.streampayPaymentLinkId) {
		return true;
	}

	if (!subscription.created_at || !(row.createdAt instanceof Date)) return false;
	const createdAt = parseDate(subscription.created_at)?.getTime();
	return (
		createdAt !== undefined &&
		createdAt >= row.createdAt.getTime() - SUCCESS_RECONCILIATION_CLOCK_SKEW_MS
	);
}

export function buildSubscriptionEndpoints(
	options: StreamPayOptions,
	subsOptions: SubscriptionsOptions,
	plansRef: () => Promise<ResolvedPlans>,
) {
	const client = options.client;
	const cancelPendingChangeEndpoint = <Path extends string>(path: Path) =>
		createAuthEndpoint(
			path,
			{
				method: "POST",
				body: UnfreezeBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const { adapter, row } = await requireConfirmedOwnedSubscription(
					ctx,
					ctx.body.subscriptionId,
					subsOptions,
					"cancel-plan-change",
				);

				try {
					const plans = await plansRef();
					const current = await client.getSubscription(row.streampaySubscriptionId);
					if (!current.pending_change) {
						await adapter.update({
							model: SUBSCRIPTION_MODEL,
							update: {
								...projectSubscriptionAgainstExisting(row, current),
								...projectPlanFields(current, plans),
								pendingPlan: null,
								pendingProductId: null,
								pendingPlanEffectiveAt: null,
								pendingSeats: null,
								pendingSeatsEffectiveAt: null,
							},
							where: [{ field: "id", value: row.id }],
						});
						return ctx.json({ canceled: true, reused: true, subscription: current });
					}
					await client.deletePendingSubscriptionChange(row.streampaySubscriptionId);
					const stream = await client.getSubscription(row.streampaySubscriptionId);
					await adapter.update({
						model: SUBSCRIPTION_MODEL,
						update: {
							...projectSubscriptionAgainstExisting(row, stream),
							...projectPlanFields(stream, plans),
							pendingPlan: null,
							pendingProductId: null,
							pendingPlanEffectiveAt: null,
							pendingSeats: null,
							pendingSeatsEffectiveAt: null,
						},
						where: [{ field: "id", value: row.id }],
					});
					return ctx.json({ canceled: true, reused: false, subscription: stream });
				} catch (err) {
					toAPIError(
						{
							logPrefix: `cancel pending subscription change failed for row=${row.id}:`,
							userMessage: "Canceling the pending subscription change failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		);

	return {
		...buildSubscriptionReadEndpoints(subsOptions, plansRef),
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
				const referenceType: SubscriptionReferenceType =
					ctx.body.referenceType ?? (referenceId === user.id ? "user" : "custom");
				await authorizeReference(ctx, user, referenceId, referenceType, "upgrade", subsOptions);

				const plans = await plansRef();
				const plan = plans.byName.get(ctx.body.plan);
				if (!plan) {
					throw new APIError("NOT_FOUND", {
						code: $ERROR_CODES.SUBSCRIPTION_PLAN_NOT_FOUND.code,
						message: `Plan "${ctx.body.plan}" is not configured.`,
					});
				}
				const seats = resolveSeatCount(plan, ctx.body.seats);
				const quotedTotal = quotedSeatTotal(plan, seats);

				const adapter = getAdapter(ctx);
				const existingActive = await adapter.findMany<Subscription>({
					model: SUBSCRIPTION_MODEL,
					where: [
						{ field: "referenceId", value: referenceId },
						{ field: "referenceType", value: referenceType },
						{ field: "group", value: plan.group ?? null },
					],
				});
				const defaultTrialEligible = !existingActive.some(
					(row) =>
						row.trialStart instanceof Date ||
						row.trialEnd instanceof Date ||
						row.status === "trial_pending" ||
						row.status === "trialing",
				);
				const trialEligible =
					plan.trialPeriodDays === undefined
						? false
						: subsOptions.isTrialEligible
							? await subsOptions.isTrialEligible(
									{
										user,
										referenceId,
										referenceType,
										plan,
										previousSubscriptions: existingActive,
										defaultEligible: defaultTrialEligible,
									},
									ctx,
								)
							: defaultTrialEligible;
				const liveActive = existingActive.find((row) => isManageableSubscriptionStatus(row.status));
				if (liveActive) {
					throw new APIError("CONFLICT", {
						code: $ERROR_CODES.SUBSCRIPTION_ALREADY_ACTIVE.code,
						message: plan.group
							? `An active subscription already exists in plan group "${plan.group}". Use the change-plan endpoint to move it.`
							: "An active subscription already exists. Use the change-plan endpoint to move it.",
					});
				}

				const activeSlotKey = subscriptionSlotKey(referenceType, referenceId, plan.group);
				const reservation = await resumeOrReserveCheckoutSlot({
					client,
					adapter,
					candidates: existingActive,
					activeSlotKey,
					planName: plan.name,
					seats,
					now: Date.now(),
					log: getLogger(ctx),
					createReservation: async () => {
						const { consumerId } = await ensureConsumerForUser(
							options,
							{ context: ctx.context },
							user,
						);
						return {
							consumerId,
							data: {
								referenceId,
								referenceType,
								activeSlotKey,
								streampaySubscriptionId: null,
								plan: plan.name,
								planVersion: plan.version ?? null,
								productId: plan.productId,
								group: plan.group ?? null,
								seats,
								streampayConsumerId: consumerId,
								streampayPaymentLinkId: null,
								status: "incomplete",
								providerStatus: null,
								billingStatus: "current",
								amountInSmallestUnit: quotedTotal,
								originalAmountInSmallestUnit: quotedTotal,
								currency: plan.currency ?? "SAR",
								billingInterval: plan.billingInterval,
								billingIntervalCount: plan.billingIntervalCount ?? 1,
								periodStart: null,
								periodEnd: null,
								currentCycleNumber: null,
								trialStart: null,
								trialEnd: null,
								cancelAtPeriodEnd: false,
								cancelAt: null,
								cancelScheduledAt: null,
								canceledAt: null,
								pendingPlan: null,
								pendingProductId: null,
								pendingPlanEffectiveAt: null,
								pendingSeats: null,
								pendingSeatsEffectiveAt: null,
								endedAt: null,
								frozenAt: null,
								freezeEndAt: null,
								providerUpdatedAt: null,
								syncedAt: null,
								createdAt: new Date(),
								updatedAt: new Date(),
							} satisfies Omit<Subscription, "id">,
						};
					},
				});
				if (reservation.kind === "recovered") {
					return ctx.json({
						subscriptionId: reservation.row.id,
						url: reservation.url,
						redirect: true,
						reused: true,
						status: reservation.row.status,
						plan: reservation.row.plan,
						seats: reservation.row.seats ?? 1,
					});
				}
				const { row, consumerId } = reservation;

				const linkInput: CreatePaymentLinkDto = {
					name: `Subscription — ${plan.name}`,
					currency: plan.currency ?? "SAR",
					items: [buildSeatCheckoutItem(plan, seats)],
					max_number_of_payments: 1,
					organization_consumer_id: consumerId,
					custom_metadata: {
						[PLAN_NAME_METADATA_KEY]: plan.name,
						[REFERENCE_ID_METADATA_KEY]: referenceId,
						[REFERENCE_TYPE_METADATA_KEY]: referenceType,
						[SUBSCRIPTION_ROW_ID_METADATA_KEY]: row.id,
					},
				};
				if (ctx.body.successUrl) linkInput.success_redirect_url = ctx.body.successUrl;
				if (ctx.body.failureUrl) linkInput.failure_redirect_url = ctx.body.failureUrl;
				if (plan.trialPeriodDays !== undefined && trialEligible) {
					linkInput.trial_period_days = plan.trialPeriodDays;
				}

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
					await deleteReservedSubscription(
						adapter,
						row.id,
						getLogger(ctx),
						"createPaymentLink cleanup",
					);
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
					try {
						await adapter.update({
							model: SUBSCRIPTION_MODEL,
							update: {
								streampayPaymentLinkId: paymentLinkId,
								status: "incomplete_expired",
								activeSlotKey: null,
								updatedAt: new Date(),
							},
							where: [{ field: "id", value: row.id }],
						});
					} catch (persistenceError) {
						const message =
							persistenceError instanceof Error
								? persistenceError.message
								: String(persistenceError);
						getLogger(ctx).error(
							`failed to mark unusable payment link=${paymentLinkId} expired for row=${row.id}: ${message}`,
						);
						await deleteReservedSubscription(
							adapter,
							row.id,
							getLogger(ctx),
							"unusable payment link cleanup",
						);
					}
					throw new APIError("INTERNAL_SERVER_ERROR", {
						message: "Payment link was created but no URL was returned.",
					});
				}

				let updatedRow: Subscription | null = null;
				try {
					updatedRow = await adapter.update<Subscription>({
						model: SUBSCRIPTION_MODEL,
						update: {
							streampayPaymentLinkId: paymentLinkId,
							updatedAt: new Date(),
						},
						where: [{ field: "id", value: row.id }],
					});
				} catch (persistenceError) {
					const message =
						persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
					getLogger(ctx).error(
						`failed to persist payment link=${paymentLinkId} for row=${row.id}: ${message}. Protected checkout metadata will reconcile the row from the webhook.`,
					);
				}

				return ctx.json({
					subscriptionId: updatedRow?.id ?? row.id,
					url,
					redirect: true,
					reused: false,
					status: "incomplete",
					plan: plan.name,
					seats,
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
						code: $ERROR_CODES.SUBSCRIPTION_NOT_FOUND.code,
						message: "Subscription not found.",
					});
				}
				await authorizeReference(
					ctx,
					user,
					row.referenceId,
					row.referenceType ?? "user",
					"read",
					subsOptions,
				);

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
					let page = 1;
					let match: SubscriptionDetailed | undefined;
					do {
						const list = await client.listSubscriptions({
							page,
							size: 100,
							organization_consumer_id: row.streampayConsumerId,
						});
						match = list.data?.find((sub) =>
							isCheckoutSubscriptionCandidate(sub, row, plan.productId),
						);
						if (match || !list.pagination?.has_next_page) break;
						page += 1;
					} while (page <= 1000);
					if (!match?.id) {
						return ctx.json({ subscription: row, synced: false });
					}
					const updated = await adapter.update<Subscription>({
						model: SUBSCRIPTION_MODEL,
						update: {
							...projectSubscriptionFields(match),
							...projectPlanFields(match, plans),
							planVersion: plan.version ?? null,
							productId: plan.productId,
							billingStatus: "current",
							activeSlotKey:
								row.activeSlotKey ??
								subscriptionSlotKey(row.referenceType ?? "user", row.referenceId, row.group),
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
				const { adapter, row } = await requireConfirmedOwnedSubscription(
					ctx,
					ctx.body.subscriptionId,
					subsOptions,
					"cancel",
				);

				const payload: SubscriptionCancel = {
					cancel_related_invoices: ctx.body.cancelRelatedInvoices ?? false,
				};
				try {
					const stream = await client.getSubscription(row.streampaySubscriptionId);
					if (stream.status === "CANCELED") {
						await adapter.update({
							model: SUBSCRIPTION_MODEL,
							update: projectSubscriptionAgainstExisting(row, stream),
							where: [{ field: "id", value: row.id }],
						});
						return ctx.json(stream);
					}
					if (ctx.body.cancelAtPeriodEnd === false && stream.status === "ACTIVE") {
						throw new APIError("BAD_REQUEST", {
							code: $ERROR_CODES.SUBSCRIPTION_IMMEDIATE_CANCEL_UNSUPPORTED.code,
							message:
								"StreamPay cancels active subscriptions at period end. Immediate cancellation is only available for inactive or trial subscriptions.",
						});
					}
					if (stream.cancel_at_period_end && !ctx.body.cancelRelatedInvoices) {
						await adapter.update({
							model: SUBSCRIPTION_MODEL,
							update: projectSubscriptionAgainstExisting(row, stream),
							where: [{ field: "id", value: row.id }],
						});
						return ctx.json(stream);
					}
					if (ctx.body.cancelAtPeriodEnd === true && stream.status !== "ACTIVE") {
						throw new APIError("BAD_REQUEST", {
							code: $ERROR_CODES.SUBSCRIPTION_PERIOD_END_CANCEL_UNSUPPORTED.code,
							message:
								"StreamPay only schedules period-end cancellation for active subscriptions. This subscription would be canceled immediately.",
						});
					}
					const result = await client.cancelSubscription(row.streampaySubscriptionId, payload);
					await syncSubscriptionFromUpstream(
						client,
						adapter,
						row.streampaySubscriptionId,
						getLogger(ctx),
						"cancelSubscription",
						result,
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
				const { adapter, row } = await requireConfirmedOwnedSubscription(
					ctx,
					ctx.body.subscriptionId,
					subsOptions,
					"change-plan",
				);
				const plans = await plansRef();
				const nextPlan = plans.byName.get(ctx.body.plan);
				if (!nextPlan) {
					throw new APIError("NOT_FOUND", {
						code: $ERROR_CODES.SUBSCRIPTION_PLAN_NOT_FOUND.code,
						message: `Plan "${ctx.body.plan}" is not configured.`,
					});
				}
				try {
					const stream = await client.getSubscription(row.streampaySubscriptionId);
					const currentPlan =
						configuredPlanForSubscription(stream, plans) ?? plans.byName.get(row.plan);
					if (!currentPlan) {
						throw new APIError("BAD_REQUEST", {
							code: $ERROR_CODES.SUBSCRIPTION_INVALID_STATE.code,
							message: "The current StreamPay product is not a configured subscription plan.",
						});
					}
					const currentGroup = currentPlan.group ?? row.group;
					if (currentGroup !== (nextPlan.group ?? null)) {
						throw new APIError("BAD_REQUEST", {
							code: $ERROR_CODES.SUBSCRIPTION_PLAN_GROUP_MISMATCH.code,
							message:
								"A subscription can only change to another plan in the same configured group.",
						});
					}
					if (stream.cancel_at_period_end) {
						throw new APIError("CONFLICT", {
							code: $ERROR_CODES.SUBSCRIPTION_ALREADY_SCHEDULED_CANCEL.code,
							message:
								"The subscription is scheduled to cancel. Uncancel it before scheduling a plan change.",
						});
					}
					const currentItem = stream.items?.find(
						(item) => subscriptionItemProductId(item) === currentPlan.productId,
					);
					const currentSeats = currentItem
						? (subscriptionItemQuantity(currentItem) ?? 1)
						: row.seats;
					const nextSeats = resolveSeatCount(nextPlan, ctx.body.seats ?? currentSeats ?? 1);
					const currentProductIsRequestedPlan = currentPlan.productId === nextPlan.productId;
					if (
						currentProductIsRequestedPlan &&
						currentSeats === nextSeats &&
						!stream.pending_change
					) {
						throw new APIError("BAD_REQUEST", {
							code: $ERROR_CODES.SUBSCRIPTION_ALREADY_ON_PLAN.code,
							message: `Already on plan "${nextPlan.name}" with ${nextSeats} seats.`,
						});
					}
					const pendingTargets = stream.pending_change?.target_items ?? [];
					const pendingTarget = pendingTargets.find(
						(item) => subscriptionItemProductId(item) === nextPlan.productId,
					);
					const pendingTargetMatches =
						Boolean(pendingTarget) && (subscriptionItemQuantity(pendingTarget) ?? 1) === nextSeats;
					if (pendingTargetMatches) {
						const effectiveAt = stream.pending_change?.effective_at ?? null;
						await adapter.update({
							model: SUBSCRIPTION_MODEL,
							update: {
								...projectSubscriptionAgainstExisting(row, stream),
								...projectPlanFields(stream, plans),
								pendingPlan: currentPlan.productId === nextPlan.productId ? null : nextPlan.name,
								pendingProductId:
									currentPlan.productId === nextPlan.productId ? null : nextPlan.productId,
								pendingPlanEffectiveAt:
									currentPlan.productId !== nextPlan.productId && effectiveAt
										? parseDate(effectiveAt)
										: null,
								pendingSeats: nextSeats,
								pendingSeatsEffectiveAt: parseDate(effectiveAt),
							},
							where: [{ field: "id", value: row.id }],
						});
						return ctx.json({
							mode: "at_period_end",
							subscriptionId: row.id,
							plan: nextPlan.name,
							seats: nextSeats,
							effectiveAt,
							pendingChange: stream.pending_change,
							reused: true,
						});
					}
					if (stream.pending_change) {
						throw new APIError("CONFLICT", {
							code: $ERROR_CODES.SUBSCRIPTION_PLAN_CHANGE_ALREADY_SCHEDULED.code,
							message:
								"A different plan change is already scheduled. Cancel it before scheduling another.",
						});
					}
					const patch: SubscriptionUpdate = {
						items: subscriptionItemsForUpdate(
							stream,
							currentPlan.productId,
							nextPlan.productId,
							nextSeats,
						),
						coupons: subscriptionCouponIds(stream),
						recurring_interval: nextPlan.billingInterval,
						recurring_interval_count: nextPlan.billingIntervalCount ?? 1,
					};
					const result = await client.updateSubscription(row.streampaySubscriptionId, patch);
					const pending = Boolean(result.pending_change);
					const effectiveAt = result.pending_change?.effective_at ?? null;
					const planProjection = projectPlanFields(result, plans);
					await adapter.update({
						model: SUBSCRIPTION_MODEL,
						update: {
							...projectSubscriptionAgainstExisting(row, result),
							...planProjection,
							updatedAt: new Date(),
						},
						where: [{ field: "id", value: row.id }],
					});
					const providerPlan = pending
						? (planProjection.pendingPlan ?? planProjection.plan ?? row.plan)
						: (planProjection.plan ?? row.plan);
					const providerSeats = pending
						? (planProjection.pendingSeats ?? nextSeats)
						: (planProjection.seats ?? row.seats ?? nextSeats);
					return ctx.json({
						mode: pending ? "at_period_end" : "immediate",
						subscriptionId: row.id,
						plan: providerPlan,
						seats: providerSeats,
						effectiveAt,
						pendingChange: result.pending_change ?? null,
						subscription: result,
						reused: false,
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

		updateSubscriptionSeats: createAuthEndpoint(
			"/subscription/update-seats",
			{
				method: "POST",
				body: UpdateSeatsBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const { adapter, row } = await requireConfirmedOwnedSubscription(
					ctx,
					ctx.body.subscriptionId,
					subsOptions,
					"update-seats",
				);
				const plans = await plansRef();
				try {
					const stream = await client.getSubscription(row.streampaySubscriptionId);
					const plan = configuredPlanForSubscription(stream, plans) ?? plans.byName.get(row.plan);
					if (!plan) {
						throw new APIError("BAD_REQUEST", {
							code: $ERROR_CODES.SUBSCRIPTION_INVALID_STATE.code,
							message: "The current StreamPay product is not a configured subscription plan.",
						});
					}
					if (stream.cancel_at_period_end) {
						throw new APIError("CONFLICT", {
							code: $ERROR_CODES.SUBSCRIPTION_ALREADY_SCHEDULED_CANCEL.code,
							message: "Uncancel the subscription before scheduling a seat change.",
						});
					}
					const seats = resolveSeatCount(plan, ctx.body.seats);
					const currentItem = stream.items?.find(
						(item) => subscriptionItemProductId(item) === plan.productId,
					);
					const currentSeats = currentItem
						? (subscriptionItemQuantity(currentItem) ?? 1)
						: row.seats;
					const pendingTarget = stream.pending_change?.target_items?.find(
						(item) => subscriptionItemProductId(item) === plan.productId,
					);
					if (stream.pending_change) {
						if (pendingTarget && (subscriptionItemQuantity(pendingTarget) ?? 1) === seats) {
							const effectiveAt = stream.pending_change.effective_at ?? null;
							await adapter.update({
								model: SUBSCRIPTION_MODEL,
								update: {
									...projectSubscriptionAgainstExisting(row, stream),
									...projectPlanFields(stream, plans),
								},
								where: [{ field: "id", value: row.id }],
							});
							return ctx.json({
								mode: "at_period_end",
								subscriptionId: row.id,
								seats,
								effectiveAt,
								pendingChange: stream.pending_change,
								reused: true,
							});
						}
						throw new APIError("CONFLICT", {
							code: $ERROR_CODES.SUBSCRIPTION_SEAT_CHANGE_ALREADY_SCHEDULED.code,
							message:
								"A different subscription change is pending. Cancel it before scheduling this seat count.",
						});
					}
					if (currentSeats === seats) {
						await adapter.update({
							model: SUBSCRIPTION_MODEL,
							update: {
								...projectSubscriptionAgainstExisting(row, stream),
								...projectPlanFields(stream, plans),
							},
							where: [{ field: "id", value: row.id }],
						});
						return ctx.json({
							mode: "current",
							subscriptionId: row.id,
							seats,
							effectiveAt: null,
							pendingChange: null,
							reused: true,
						});
					}
					const patch: SubscriptionUpdate = {
						items: subscriptionItemsForUpdate(stream, plan.productId, plan.productId, seats),
						coupons: subscriptionCouponIds(stream),
					};
					const result = await client.updateSubscription(row.streampaySubscriptionId, patch);
					const pending = Boolean(result.pending_change);
					const effectiveAt = result.pending_change?.effective_at ?? null;
					const planProjection = projectPlanFields(result, plans);
					await adapter.update({
						model: SUBSCRIPTION_MODEL,
						update: {
							...projectSubscriptionAgainstExisting(row, result),
							...planProjection,
							updatedAt: new Date(),
						},
						where: [{ field: "id", value: row.id }],
					});
					const providerSeats = pending
						? (planProjection.pendingSeats ?? seats)
						: (planProjection.seats ?? row.seats ?? seats);
					return ctx.json({
						mode: pending ? "at_period_end" : "immediate",
						subscriptionId: row.id,
						seats: providerSeats,
						effectiveAt,
						pendingChange: result.pending_change ?? null,
						subscription: result,
						reused: false,
					});
				} catch (err) {
					toAPIError(
						{
							logPrefix: `update-seats failed for row=${row.id}:`,
							userMessage: "Seat change scheduling failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),

		cancelSubscriptionPlanChange: cancelPendingChangeEndpoint("/subscription/change-plan/cancel"),
		cancelSubscriptionPendingChange: cancelPendingChangeEndpoint(
			"/subscription/pending-change/cancel",
		),

		uncancelSubscription: createAuthEndpoint(
			"/subscription/uncancel",
			{
				method: "POST",
				body: UnfreezeBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const { adapter, row } = await requireConfirmedOwnedSubscription(
					ctx,
					ctx.body.subscriptionId,
					subsOptions,
					"uncancel",
				);

				try {
					await client.uncancelSubscription(row.streampaySubscriptionId);
					const stream = await client.getSubscription(row.streampaySubscriptionId);
					await adapter.update({
						model: SUBSCRIPTION_MODEL,
						update: projectSubscriptionAgainstExisting(row, stream),
						where: [{ field: "id", value: row.id }],
					});
					return ctx.json({ uncanceled: true, subscription: stream });
				} catch (err) {
					toAPIError(
						{
							logPrefix: `uncancel subscription failed for row=${row.id}:`,
							userMessage: "Restoring subscription renewal failed.",
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
				const { adapter, row } = await requireConfirmedOwnedSubscription(
					ctx,
					ctx.body.subscriptionId,
					subsOptions,
					"freeze",
				);

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
				const { adapter, row } = await requireConfirmedOwnedSubscription(
					ctx,
					ctx.body.subscriptionId,
					subsOptions,
					"unfreeze",
				);

				const nowMs = Date.now();
				try {
					const freezes = await client.listSubscriptionFreezes(row.streampaySubscriptionId);
					const active = freezes.data?.find((freeze) => {
						if (!freeze.id || !freeze.freeze_start_datetime) return false;
						const start = parseDate(freeze.freeze_start_datetime)?.getTime();
						const end = freeze.freeze_end_datetime
							? parseDate(freeze.freeze_end_datetime)?.getTime()
							: Number.POSITIVE_INFINITY;
						return start !== undefined && end !== undefined && start <= nowMs && nowMs <= end;
					});
					if (!active?.id || !active.freeze_start_datetime) {
						throw new APIError("BAD_REQUEST", {
							code: $ERROR_CODES.SUBSCRIPTION_FREEZE_NOT_ACTIVE.code,
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

		cancelSubscriptionFreeze: createAuthEndpoint(
			"/subscription/freeze/cancel",
			{
				method: "POST",
				body: CancelFreezeBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const { adapter, row } = await requireConfirmedOwnedSubscription(
					ctx,
					ctx.body.subscriptionId,
					subsOptions,
					"cancel-freeze",
				);

				try {
					const freezes = await client.listSubscriptionFreezes(row.streampaySubscriptionId);
					if (!freezes.data?.some((freeze) => freeze.id === ctx.body.freezeId)) {
						return ctx.json({ canceled: true, freezeId: ctx.body.freezeId, reused: true });
					}
					await client.deleteSubscriptionFreeze(row.streampaySubscriptionId, ctx.body.freezeId);
					await syncSubscriptionFromUpstream(
						client,
						adapter,
						row.streampaySubscriptionId,
						getLogger(ctx),
						"cancelSubscriptionFreeze",
					);
					return ctx.json({ canceled: true, freezeId: ctx.body.freezeId, reused: false });
				} catch (err) {
					if (isAlreadyCanceledFreezeError(err)) {
						getLogger(ctx).info(
							`cancel subscription freeze reused provider tombstone for row=${row.id} freeze=${ctx.body.freezeId}.`,
						);
						return ctx.json({ canceled: true, freezeId: ctx.body.freezeId, reused: true });
					}
					toAPIError(
						{
							logPrefix: `cancel subscription freeze failed for row=${row.id}:`,
							userMessage: "Canceling the subscription freeze failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),
	};
}
