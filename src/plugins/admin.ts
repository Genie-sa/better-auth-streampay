import type {
	ConsumerUpdate,
	CouponCreate,
	CouponUpdate,
	FreezeSubscriptionCreateRequest,
	FreezeSubscriptionUpdateRequest,
	PaymentRefundRequest,
	ProductCreate,
	ProductUpdate,
	SubscriptionCancel,
	SubscriptionCreate,
	SubscriptionDetailed,
	SubscriptionUpdate,
} from "@streamsdk/typescript";
import type { GenericEndpointContext, User } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { $ERROR_CODES } from "../error-codes";
import type { StreamPayClient, StreamPayOptions } from "../types";
import { unlinkConsumer } from "../utils/consumer-link";
import { isNotFoundError } from "../utils/ensure-consumer";
import { toAPIError } from "../utils/errors";
import { summarizeStreamPayError } from "../utils/format-error";
import { getLogger } from "../utils/logger";
import { parseStreamPayError } from "../utils/parse-error";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";
import {
	createWebhookInbox,
	WEBHOOK_EVENT_MODEL,
	type WebhookEventRow,
	type WebhookInbox,
} from "../webhooks/inbox";
import {
	getRefundIntent,
	refundIntentKey,
	refundIntentTable,
	runRefundIntent,
} from "./refund-intents";
import type { StreamPayPluginRegistry } from "./subscriptions";
import { type PluginAdapter, toSyncContext } from "./subscriptions/adapter";

interface UserWithRole {
	role?: string | null;
}

type SessionUserInput = User | UserWithRole | null | undefined;

const DEFAULT_ADMIN_ROLES = ["admin"] as const;

export interface AdminOptions {
	/** Store refund intents and require a request key. Apply the refund table migration first. */
	durableRefunds?: boolean;
	adminRoles?: readonly string[];

	isAdmin?: (user: StreamPaySessionUser, ctx: GenericEndpointContext) => boolean | Promise<boolean>;

	onRefund?: (ctx: {
		user: StreamPaySessionUser;
		paymentId: string;
		request: RefundRequest;
	}) => void | Promise<void>;

	onPlanChange?: (ctx: {
		user: StreamPaySessionUser;
		subscriptionId: string;
		current: SubscriptionDetailed;
		patch: SubscriptionUpdate;
	}) => void | Promise<void>;
}

async function requireAdmin(
	ctx: GenericEndpointContext,
	options: AdminOptions,
): Promise<StreamPaySessionUser> {
	const rawUser: SessionUserInput = ctx.context.session?.user;
	const user = asSessionUser(rawUser);
	if (!user) {
		throw new APIError("UNAUTHORIZED", {
			message: "Admin access requires a session.",
		});
	}
	const adminRoles = options.adminRoles ?? DEFAULT_ADMIN_ROLES;
	if (hasAdminRole(rawUser, adminRoles)) return user;
	if (options.isAdmin && (await options.isAdmin(user, ctx))) return user;
	throw new APIError("FORBIDDEN", {
		code: $ERROR_CODES.FORBIDDEN.code,
		message: "Admin access required.",
	});
}

function hasAdminRole(user: SessionUserInput, adminRoles: readonly string[]): boolean {
	if (!user || typeof user !== "object") return false;
	const role = (user as UserWithRole).role;
	if (typeof role !== "string" || role.length === 0) return false;
	for (const entry of role.split(",")) {
		if (adminRoles.includes(entry.trim())) return true;
	}
	return false;
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

function forwardedBody<T extends object>() {
	return z.custom<T>(
		(value) => value !== null && typeof value === "object" && !Array.isArray(value),
		"Expected an object body.",
	);
}

const PaymentsListQuery = z
	.object({
		page: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
		size: z.coerce.number().int().positive().max(100).optional(),
		invoice_id: z.string().uuid().optional(),
	})
	.passthrough();

const PaginationOnlyQuery = z
	.object({
		page: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
		size: z.coerce.number().int().positive().max(100).optional(),
	})
	.passthrough();

const ConsumersListQuery = z
	.object({
		page: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
		size: z.coerce.number().int().positive().max(100).optional(),
		search_term: z.string().optional(),
	})
	.passthrough();

const RefundBody = z
	.object({
		idempotencyKey: refundIntentKey.optional(),
		refund_reason: z.enum(["REQUESTED_BY_CUSTOMER", "DUPLICATE", "FRAUDULENT", "OTHER"]),
		refund_note: z.string().max(512).nullable().optional(),
		amount: z
			.union([
				z.number().finite().positive(),
				z
					.string()
					.regex(/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/)
					.refine((amount) => /[1-9]/.test(amount)),
			])
			.nullable()
			.optional(),
		allow_refund_multiple_related_payments: z.boolean().optional(),
		payment_is_part_of_related_set: z.boolean().optional(),
	})
	.strict();

type RefundRequest = PaymentRefundRequest & Omit<z.output<typeof RefundBody>, "idempotencyKey">;

function refundConflict(code: "PAYMENT_REFUND_REVIEW_REQUIRED" | "PAYMENT_REFUND_IN_PROGRESS") {
	return new APIError("CONFLICT", $ERROR_CODES[code]);
}

async function recoverRefund(
	client: StreamPayClient,
	paymentId: string,
	request: RefundRequest,
	error: unknown,
) {
	const { code, status } = parseStreamPayError(error);
	const busy = code === "PAYMENT_REFUND_BUSY";
	const already = code === "PAYMENT_REFUNDED_ALREADY";
	const uncertain = status === undefined || status === 408 || status >= 500;
	if (!busy && !already && !uncertain) throw error;

	const payment = await client.getPayment(paymentId).catch(() => undefined);
	const state = z
		.object({
			current_status: z.string().optional(),
			refunds: z.array(z.object({ status: z.string() })).nullish(),
		})
		.safeParse(payment);
	const statusAfter = state.success ? state.data.current_status : undefined;
	const pending =
		state.success && state.data.refunds?.some((refund) => refund.status === "PENDING");
	const wholePayment =
		request.amount == null &&
		!request.payment_is_part_of_related_set &&
		!request.allow_refund_multiple_related_payments;

	// A read of one payment can confirm its full refund. It cannot identify a particular partial
	// refund or confirm a refund distributed across related payments.
	if (wholePayment && statusAfter === "REFUNDED" && !already && payment) return payment;
	if (pending || (busy && statusAfter !== "REFUNDED")) {
		throw refundConflict("PAYMENT_REFUND_IN_PROGRESS");
	}
	if (uncertain || busy || statusAfter === "PARTIALLY_REFUNDED") {
		throw refundConflict("PAYMENT_REFUND_REVIEW_REQUIRED");
	}
	throw error;
}

function buildPaymentsEndpoints(client: StreamPayClient, adminOptions: AdminOptions) {
	return {
		adminRefundPayment: createAuthEndpoint(
			"/admin/streampay/payments/:id/refund",
			{
				method: "POST",
				body: RefundBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = await requireAdmin(ctx, adminOptions);
				const paymentId = ctx.params.id;
				const request: RefundRequest = {
					refund_reason: ctx.body.refund_reason,
					...(ctx.body.refund_note === undefined ? {} : { refund_note: ctx.body.refund_note }),
					...(ctx.body.amount === undefined ? {} : { amount: ctx.body.amount }),
					...(ctx.body.payment_is_part_of_related_set === undefined
						? {}
						: {
								payment_is_part_of_related_set: ctx.body.payment_is_part_of_related_set,
							}),
					allow_refund_multiple_related_payments:
						ctx.body.allow_refund_multiple_related_payments ?? false,
				};

				if (!adminOptions.durableRefunds) {
					await adminOptions.onRefund?.({ user, paymentId, request });
				}
				try {
					if (adminOptions.durableRefunds) {
						if (!ctx.body.idempotencyKey) {
							throw new APIError("BAD_REQUEST", $ERROR_CODES.VALIDATION_ERROR);
						}
						return ctx.json(
							await runRefundIntent(
								getAdapter(ctx),
								client,
								paymentId,
								ctx.body.idempotencyKey,
								request,
								async () => adminOptions.onRefund?.({ user, paymentId, request }),
							),
						);
					}
					const payment = await client
						.refundPayment(paymentId, request)
						.catch((err: unknown) => recoverRefund(client, paymentId, request, err));
					return ctx.json(payment);
				} catch (err) {
					toAPIError(
						{
							logPrefix: `StreamPay refundPayment failed for payment=${paymentId}:`,
							userMessage: "StreamPay refund failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminGetRefundIntent: createAuthEndpoint(
			"/admin/streampay/payments/:id/refund-intent",
			{
				method: "GET",
				query: z.object({ idempotencyKey: refundIntentKey }),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				if (!adminOptions.durableRefunds) throw new APIError("NOT_FOUND", $ERROR_CODES.NOT_FOUND);
				return ctx.json(
					await getRefundIntent(getAdapter(ctx), client, ctx.params.id, ctx.query.idempotencyKey),
				);
			},
		),

		adminListPayments: createAuthEndpoint(
			"/admin/streampay/payments",
			{
				method: "GET",
				query: PaymentsListQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const params: { page?: number; limit?: number; invoice_id?: string } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.limit = ctx.query.size;
				if (ctx.query.invoice_id !== undefined) params.invoice_id = ctx.query.invoice_id;
				try {
					const response = await client.listPayments(params);
					return ctx.json(response);
				} catch (err) {
					toAPIError("StreamPay listPayments failed.", err, getLogger(ctx));
				}
			},
		),

		adminGetPayment: createAuthEndpoint(
			"/admin/streampay/payments/:id",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					const payment = await client.getPayment(ctx.params.id);
					return ctx.json(payment);
				} catch (err) {
					toAPIError(
						`StreamPay getPayment failed for payment=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),
	};
}

function buildSubscriptionsEndpoints(
	client: StreamPayClient,
	adminOptions: AdminOptions,
	registry: StreamPayPluginRegistry | undefined,
) {
	return {
		adminCreateSubscription: createAuthEndpoint(
			"/admin/streampay/subscriptions",
			{
				method: "POST",
				body: forwardedBody<SubscriptionCreate>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const input = ctx.body;
				try {
					const subscription = await client.createSubscription(input);
					return ctx.json(subscription);
				} catch (err) {
					toAPIError("StreamPay createSubscription failed.", err, getLogger(ctx));
				}
			},
		),

		adminUpdateSubscription: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id",
			{
				method: "PATCH",
				body: forwardedBody<SubscriptionUpdate>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = await requireAdmin(ctx, adminOptions);
				const subscriptionId = ctx.params.id;
				const patch = ctx.body;

				if (adminOptions.onPlanChange) {
					let current: SubscriptionDetailed;
					try {
						current = await client.getSubscription(subscriptionId);
					} catch (err) {
						toAPIError(
							`StreamPay getSubscription failed for subscription=${subscriptionId}:`,
							err,
							getLogger(ctx),
						);
					}
					await adminOptions.onPlanChange({ user, subscriptionId, current, patch });
				}

				try {
					const subscription = await client.updateSubscription(subscriptionId, patch);
					await registry?.refreshSubscriptionProjection?.(
						ctx,
						{ snapshot: subscription },
						"adminUpdateSubscription",
					);
					return ctx.json(subscription);
				} catch (err) {
					toAPIError(
						`StreamPay updateSubscription failed for subscription=${subscriptionId}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminListSubscriptions: createAuthEndpoint(
			"/admin/streampay/subscriptions",
			{
				method: "GET",
				query: PaginationOnlyQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const params: { page?: number; limit?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.limit = ctx.query.size;
				try {
					const response = await client.listSubscriptions(params);
					return ctx.json(response);
				} catch (err) {
					toAPIError("StreamPay listSubscriptions failed.", err, getLogger(ctx));
				}
			},
		),

		adminGetSubscription: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					const subscription = await client.getSubscription(ctx.params.id);
					return ctx.json(subscription);
				} catch (err) {
					toAPIError(
						`StreamPay getSubscription failed for subscription=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminCancelSubscription: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id/cancel",
			{
				method: "POST",
				body: forwardedBody<SubscriptionCancel>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const subscriptionId = ctx.params.id;
				const input = ctx.body;
				try {
					const result = await client.cancelSubscription(subscriptionId, input);
					await registry?.refreshSubscriptionProjection?.(
						ctx,
						{ snapshot: result },
						"adminCancelSubscription",
					);
					return ctx.json(result);
				} catch (err) {
					toAPIError(
						{
							logPrefix: `StreamPay adminCancelSubscription failed for subscription=${subscriptionId}:`,
							userMessage: "StreamPay subscription cancellation failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminFreezeSubscription: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id/freeze",
			{
				method: "POST",
				body: forwardedBody<FreezeSubscriptionCreateRequest>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const subscriptionId = ctx.params.id;
				const input = ctx.body;
				try {
					const freeze = await client.freezeSubscription(subscriptionId, input);
					await registry?.refreshSubscriptionProjection?.(
						ctx,
						{ streampaySubscriptionId: subscriptionId },
						"adminFreezeSubscription",
					);
					return ctx.json(freeze);
				} catch (err) {
					toAPIError(
						{
							logPrefix: `StreamPay adminFreezeSubscription failed for subscription=${subscriptionId}:`,
							userMessage: "StreamPay subscription freeze failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminListSubscriptionFreezes: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id/freeze",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					const freezes = await client.listSubscriptionFreezes(ctx.params.id);
					return ctx.json(freezes);
				} catch (err) {
					toAPIError(
						`StreamPay listSubscriptionFreezes failed for subscription=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminUpdateSubscriptionFreeze: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id/freeze/:freezeId",
			{
				method: "PUT",
				body: forwardedBody<FreezeSubscriptionUpdateRequest>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const { id: subscriptionId, freezeId } = ctx.params;
				const input = ctx.body;
				try {
					const freeze = await client.updateSubscriptionFreeze(subscriptionId, freezeId, input);
					await registry?.refreshSubscriptionProjection?.(
						ctx,
						{ streampaySubscriptionId: subscriptionId },
						"adminUpdateSubscriptionFreeze",
					);
					return ctx.json(freeze);
				} catch (err) {
					toAPIError(
						{
							logPrefix: `StreamPay adminUpdateSubscriptionFreeze failed for subscription=${subscriptionId} freeze=${freezeId}:`,
							userMessage: "StreamPay freeze update failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminDeleteSubscriptionFreeze: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id/freeze/:freezeId",
			{
				method: "DELETE",
				disableBody: true,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const { id: subscriptionId, freezeId } = ctx.params;
				try {
					await client.deleteSubscriptionFreeze(subscriptionId, freezeId);
					await registry?.refreshSubscriptionProjection?.(
						ctx,
						{ streampaySubscriptionId: subscriptionId },
						"adminDeleteSubscriptionFreeze",
					);
					return ctx.json({ deleted: true });
				} catch (err) {
					toAPIError(
						{
							logPrefix: `StreamPay adminDeleteSubscriptionFreeze failed for subscription=${subscriptionId} freeze=${freezeId}:`,
							userMessage: "StreamPay freeze delete failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),
	};
}

function buildConsumersEndpoints(client: StreamPayClient, adminOptions: AdminOptions) {
	return {
		adminListConsumers: createAuthEndpoint(
			"/admin/streampay/consumers",
			{
				method: "GET",
				query: ConsumersListQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const params: { page?: number; limit?: number; search_term?: string } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.limit = ctx.query.size;
				if (ctx.query.search_term !== undefined) params.search_term = ctx.query.search_term;
				try {
					const response = await client.listConsumers(params);
					return ctx.json(response);
				} catch (err) {
					toAPIError("StreamPay listConsumers failed.", err, getLogger(ctx));
				}
			},
		),

		adminGetConsumer: createAuthEndpoint(
			"/admin/streampay/consumers/:id",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					const consumer = await client.getConsumer(ctx.params.id);
					return ctx.json(consumer);
				} catch (err) {
					toAPIError(
						`StreamPay getConsumer failed for consumer=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminUpdateConsumer: createAuthEndpoint(
			"/admin/streampay/consumers/:id",
			{
				method: "PATCH",
				body: forwardedBody<ConsumerUpdate>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const consumerId = ctx.params.id;
				const patch = ctx.body;
				try {
					const consumer = await client.updateConsumer(consumerId, patch);
					return ctx.json(consumer);
				} catch (err) {
					toAPIError(
						`StreamPay updateConsumer failed for consumer=${consumerId}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminDeleteConsumer: createAuthEndpoint(
			"/admin/streampay/consumers/:id",
			{
				method: "DELETE",
				disableBody: true,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const consumerId = ctx.params.id;

				try {
					await client.deleteConsumer(consumerId);
				} catch (err) {
					if (!isNotFoundError(err)) {
						toAPIError(
							`StreamPay deleteConsumer failed for consumer=${consumerId}:`,
							err,
							getLogger(ctx),
						);
					}
				}

				try {
					await unlinkConsumer(getAdapter(ctx), consumerId);
				} catch (err: unknown) {
					getLogger(ctx).error(
						`StreamPay admin delete: link clear failed for consumer=${consumerId}: ${summarizeStreamPayError(err)}`,
					);
				}

				return ctx.json({ deleted: true });
			},
		),
	};
}

function buildInvoicesEndpoints(client: StreamPayClient, adminOptions: AdminOptions) {
	return {
		adminListInvoices: createAuthEndpoint(
			"/admin/streampay/invoices",
			{
				method: "GET",
				query: PaginationOnlyQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const params: { page?: number; limit?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.limit = ctx.query.size;
				try {
					const response = await client.listInvoices(params);
					return ctx.json(response);
				} catch (err) {
					toAPIError("StreamPay listInvoices failed.", err, getLogger(ctx));
				}
			},
		),

		adminGetInvoice: createAuthEndpoint(
			"/admin/streampay/invoices/:id",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					const invoice = await client.getInvoice(ctx.params.id);
					return ctx.json(invoice);
				} catch (err) {
					toAPIError(
						`StreamPay getInvoice failed for invoice=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),
	};
}

function buildProductsEndpoints(client: StreamPayClient, adminOptions: AdminOptions) {
	return {
		adminCreateProduct: createAuthEndpoint(
			"/admin/streampay/products",
			{
				method: "POST",
				body: forwardedBody<ProductCreate>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const input = ctx.body;
				try {
					const product = await client.createProduct(input);
					return ctx.json(product);
				} catch (err) {
					toAPIError("StreamPay createProduct failed.", err, getLogger(ctx));
				}
			},
		),

		adminListProducts: createAuthEndpoint(
			"/admin/streampay/products",
			{
				method: "GET",
				query: PaginationOnlyQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const params: { page?: number; limit?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.limit = ctx.query.size;
				try {
					const response = await client.listProducts(params);
					return ctx.json(response);
				} catch (err) {
					toAPIError("StreamPay listProducts failed.", err, getLogger(ctx));
				}
			},
		),

		adminGetProduct: createAuthEndpoint(
			"/admin/streampay/products/:id",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					const product = await client.getProduct(ctx.params.id);
					return ctx.json(product);
				} catch (err) {
					toAPIError(
						`StreamPay getProduct failed for product=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminUpdateProduct: createAuthEndpoint(
			"/admin/streampay/products/:id",
			{
				method: "PUT",
				body: forwardedBody<ProductUpdate>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const productId = ctx.params.id;
				const patch = ctx.body;
				try {
					const product = await client.updateProduct(productId, patch);
					return ctx.json(product);
				} catch (err) {
					toAPIError(
						`StreamPay updateProduct failed for product=${productId}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminDeleteProduct: createAuthEndpoint(
			"/admin/streampay/products/:id",
			{
				method: "DELETE",
				disableBody: true,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					await client.deleteProduct(ctx.params.id);
					return ctx.json({ deleted: true });
				} catch (err) {
					toAPIError(
						`StreamPay deleteProduct failed for product=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),
	};
}

function buildCouponsEndpoints(client: StreamPayClient, adminOptions: AdminOptions) {
	return {
		adminCreateCoupon: createAuthEndpoint(
			"/admin/streampay/coupons",
			{
				method: "POST",
				body: forwardedBody<CouponCreate>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const input = ctx.body;
				try {
					const coupon = await client.createCoupon(input);
					return ctx.json(coupon);
				} catch (err) {
					toAPIError("StreamPay createCoupon failed.", err, getLogger(ctx));
				}
			},
		),

		adminListCoupons: createAuthEndpoint(
			"/admin/streampay/coupons",
			{
				method: "GET",
				query: PaginationOnlyQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const params: { page?: number; limit?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.limit = ctx.query.size;
				try {
					const response = await client.listCoupons(params);
					return ctx.json(response);
				} catch (err) {
					toAPIError("StreamPay listCoupons failed.", err, getLogger(ctx));
				}
			},
		),

		adminGetCoupon: createAuthEndpoint(
			"/admin/streampay/coupons/:id",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					const coupon = await client.getCoupon(ctx.params.id);
					return ctx.json(coupon);
				} catch (err) {
					toAPIError(
						`StreamPay getCoupon failed for coupon=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminUpdateCoupon: createAuthEndpoint(
			"/admin/streampay/coupons/:id",
			{
				method: "PUT",
				body: forwardedBody<CouponUpdate>(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const couponId = ctx.params.id;
				const patch = ctx.body;
				try {
					const coupon = await client.updateCoupon(couponId, patch);
					return ctx.json(coupon);
				} catch (err) {
					toAPIError(`StreamPay updateCoupon failed for coupon=${couponId}:`, err, getLogger(ctx));
				}
			},
		),

		adminDeleteCoupon: createAuthEndpoint(
			"/admin/streampay/coupons/:id",
			{
				method: "DELETE",
				disableBody: true,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					await client.deleteCoupon(ctx.params.id);
					return ctx.json({ deleted: true });
				} catch (err) {
					toAPIError(
						`StreamPay deleteCoupon failed for coupon=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),
	};
}

function buildPaymentLinksEndpoints(client: StreamPayClient, adminOptions: AdminOptions) {
	return {
		adminListPaymentLinks: createAuthEndpoint(
			"/admin/streampay/payment-links",
			{
				method: "GET",
				query: PaginationOnlyQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const params: { page?: number; limit?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.limit = ctx.query.size;
				try {
					const response = await client.listPaymentLinks(params);
					return ctx.json(response);
				} catch (err) {
					toAPIError("StreamPay listPaymentLinks failed.", err, getLogger(ctx));
				}
			},
		),

		adminGetPaymentLink: createAuthEndpoint(
			"/admin/streampay/payment-links/:id",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				try {
					const link = await client.getPaymentLink(ctx.params.id);
					return ctx.json(link);
				} catch (err) {
					toAPIError(
						`StreamPay getPaymentLink failed for payment_link=${ctx.params.id}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),
	};
}

const WebhookEventsListQuery = z
	.object({
		status: z.enum(["pending", "completed", "dead_letter"]).optional(),
		eventType: z.string().optional(),
		page: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
		size: z.coerce.number().int().positive().max(100).optional(),
	})
	.passthrough();

function decodeWebhookEventId(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new APIError("BAD_REQUEST", { message: "Invalid webhook event identifier." });
	}
}

function requireWebhookInbox(registry: StreamPayPluginRegistry | undefined): WebhookInbox {
	const inbox = registry?.webhookInbox;
	if (!inbox?.isEnabled()) {
		throw new APIError("BAD_REQUEST", {
			message:
				"Webhook inbox unavailable — enable the subscriptions webhook inbox or webhooks({ deduplicate: true }).",
		});
	}
	return inbox;
}

const LinkSubscriptionBody = z
	.object({
		referenceType: z.enum(["user", "organization", "custom"]),
		referenceId: z.string().min(1),
		plan: z.string().min(1).optional(),
	})
	.strict();

function buildSubscriptionLinkEndpoints(
	adminOptions: AdminOptions,
	registry: StreamPayPluginRegistry | undefined,
) {
	return {
		adminLinkSubscription: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id/link",
			{
				method: "POST",
				body: LinkSubscriptionBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const actor = await requireAdmin(ctx, adminOptions);
				if (!registry?.linkSubscription) {
					throw new APIError("BAD_REQUEST", {
						message: "Linking requires the subscriptions plugin.",
					});
				}
				const subscriptionId = ctx.params.id;
				try {
					const { row, reused } = await registry.linkSubscription(ctx, {
						streampaySubscriptionId: subscriptionId,
						referenceType: ctx.body.referenceType,
						referenceId: ctx.body.referenceId,
						...(ctx.body.plan ? { plan: ctx.body.plan } : {}),
					});
					getLogger(ctx).warn(
						`admin user=${actor.id} linked StreamPay sub=${subscriptionId} to ${ctx.body.referenceType}:${ctx.body.referenceId} (row=${row.id}, reused=${reused}).`,
					);
					return ctx.json({ linked: true, reused, subscription: row });
				} catch (err) {
					if (err instanceof APIError) throw err;
					toAPIError(
						{
							logPrefix: `StreamPay adminLinkSubscription failed for subscription=${subscriptionId}:`,
							userMessage: "Linking the StreamPay subscription failed.",
						},
						err,
						getLogger(ctx),
					);
				}
			},
		),
	};
}

function buildWebhookEventsEndpoints(
	adminOptions: AdminOptions,
	registry: StreamPayPluginRegistry | undefined,
) {
	return {
		adminListWebhookEvents: createAuthEndpoint(
			"/admin/streampay/webhook-events",
			{
				method: "GET",
				query: WebhookEventsListQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const adapter = getAdapter(ctx);
				const where: Array<{ field: string; value: unknown }> = [];
				if (ctx.query.status) where.push({ field: "status", value: ctx.query.status });
				if (ctx.query.eventType) where.push({ field: "eventType", value: ctx.query.eventType });
				const page = ctx.query.page ?? 1;
				const size = ctx.query.size ?? 50;
				const [items, total] = await Promise.all([
					adapter.findMany<WebhookEventRow>({
						model: WEBHOOK_EVENT_MODEL,
						...(where.length > 0 ? { where } : {}),
						limit: size,
						offset: (page - 1) * size,
						sortBy: { field: "receivedAt", direction: "desc" },
					}),
					adapter.count({
						model: WEBHOOK_EVENT_MODEL,
						...(where.length > 0 ? { where } : {}),
					}),
				]);
				return ctx.json({ items, total, page, size });
			},
		),

		adminGetWebhookEvent: createAuthEndpoint(
			"/admin/streampay/webhook-events/:eventId",
			{
				method: "GET",
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const adapter = getAdapter(ctx);
				const row = await adapter.findOne({
					model: WEBHOOK_EVENT_MODEL,
					where: [{ field: "eventId", value: decodeWebhookEventId(ctx.params.eventId) }],
				});
				if (!row) {
					throw new APIError("NOT_FOUND", {
						code: $ERROR_CODES.NOT_FOUND.code,
						message: `Webhook event ${ctx.params.eventId} not found.`,
					});
				}
				return ctx.json(row);
			},
		),

		adminReplayWebhookEvent: createAuthEndpoint(
			"/admin/streampay/webhook-events/:eventId/replay",
			{
				method: "POST",
				disableBody: true,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const inbox = requireWebhookInbox(registry);
				try {
					const result = await inbox.replay(
						toSyncContext(ctx),
						decodeWebhookEventId(ctx.params.eventId),
					);
					return ctx.json(result);
				} catch (err) {
					if (err instanceof APIError) throw err;
					toAPIError(
						`StreamPay replayWebhookEvent failed for event=${ctx.params.eventId}:`,
						err,
						getLogger(ctx),
					);
				}
			},
		),

		adminDiscardWebhookEvent: createAuthEndpoint(
			"/admin/streampay/webhook-events/:eventId",
			{
				method: "DELETE",
				disableBody: true,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				// Without a registered scope the row is still completed through the lease-aware CAS.
				const inbox = registry?.webhookInbox ?? createWebhookInbox();
				return ctx.json(
					await inbox.discard(toSyncContext(ctx), decodeWebhookEventId(ctx.params.eventId)),
				);
			},
		),
	};
}

export const admin =
	(adminOptions: AdminOptions = {}) =>
	(options: StreamPayOptions, registry?: StreamPayPluginRegistry) => {
		const client = options.client;
		return {
			schema: adminOptions.durableRefunds ? refundIntentTable : {},
			endpoints: {
				...buildPaymentsEndpoints(client, adminOptions),
				...buildSubscriptionsEndpoints(client, adminOptions, registry),
				...buildConsumersEndpoints(client, adminOptions),
				...buildInvoicesEndpoints(client, adminOptions),
				...buildProductsEndpoints(client, adminOptions),
				...buildCouponsEndpoints(client, adminOptions),
				...buildPaymentLinksEndpoints(client, adminOptions),
				...buildWebhookEventsEndpoints(adminOptions, registry),
				...buildSubscriptionLinkEndpoints(adminOptions, registry),
			},
		};
	};
