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
import { isNotFoundError } from "../utils/ensure-consumer";
import { toAPIError } from "../utils/errors";
import { formatStreamPayError } from "../utils/format-error";
import { getLogger } from "../utils/logger";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";
import type { StreamPayPluginRegistry } from "./subscriptions";
import {
	applySubscriptionProjection,
	markWebhookEventCompleted,
	type PluginAdapter,
	syncSubscriptionFromUpstream,
	WEBHOOK_EVENT_MODEL,
	type WebhookEventRow,
} from "./subscriptions/sync";

// Declared structurally (not imported from `better-auth/plugins/admin`)
// so the admin plugin stays an optional dependency.
interface UserWithRole {
	role?: string | null;
}

type SessionUserInput = User | UserWithRole | null | undefined;

const DEFAULT_ADMIN_ROLES = ["admin"] as const;

/**
 * Back-office CRUD for StreamPay. Gated by a dual check: matches an
 * `adminRoles` entry on `user.role`, OR the optional `isAdmin` callback
 * returns true. Both absent ⇒ endpoint unreachable. `onRefund` and
 * `onPlanChange` hooks run BEFORE the SDK call — throw from them to
 * block an action.
 */
export interface AdminOptions {
	/** Role values that grant admin access. Comma-split like Better Auth. Default `["admin"]`. */
	adminRoles?: readonly string[];

	/** Secondary check, called when `role` matching fails. */
	isAdmin?: (user: StreamPaySessionUser, ctx: GenericEndpointContext) => boolean | Promise<boolean>;

	/** Pre-refund hook. Throw to block. */
	onRefund?: (ctx: {
		user: StreamPaySessionUser;
		paymentId: string;
		request: PaymentRefundRequest;
	}) => void | Promise<void>;

	/** Pre-update hook. Receives current sub + incoming patch. */
	onPlanChange?: (ctx: {
		user: StreamPaySessionUser;
		subscriptionId: string;
		current: SubscriptionDetailed;
		patch: SubscriptionUpdate;
	}) => void | Promise<void>;
}

// Reads `role` off the RAW session user because `asSessionUser` narrows
// to the plugin's own fields and doesn't know about admin-plugin fields.
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

// Admin bodies forward to the SDK verbatim. The SDK's generated types
// own validation; don't add plugin-level body validation here.
const ForwardedBody = z.object({}).passthrough();

const PaymentsListQuery = z
	.object({
		page: z.coerce.number().int().positive().optional(),
		size: z.coerce.number().int().positive().max(100).optional(),
		invoice_id: z.string().uuid().optional(),
	})
	.passthrough();

const PaginationOnlyQuery = z
	.object({
		page: z.coerce.number().int().positive().optional(),
		size: z.coerce.number().int().positive().max(100).optional(),
	})
	.passthrough();

const ConsumersListQuery = z
	.object({
		page: z.coerce.number().int().positive().optional(),
		size: z.coerce.number().int().positive().max(100).optional(),
		search_term: z.string().optional(),
	})
	.passthrough();

function buildPaymentsEndpoints(client: StreamPayClient, adminOptions: AdminOptions) {
	return {
		adminRefundPayment: createAuthEndpoint(
			"/admin/streampay/payments/:id/refund",
			{
				method: "POST",
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = await requireAdmin(ctx, adminOptions);
				const paymentId = ctx.params.id;
				const request = ctx.body as unknown as PaymentRefundRequest;

				if (adminOptions.onRefund) {
					await adminOptions.onRefund({ user, paymentId, request });
				}

				try {
					const payment = await client.refundPayment(paymentId, request);
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

		adminListPayments: createAuthEndpoint(
			"/admin/streampay/payments",
			{
				method: "GET",
				query: PaymentsListQuery,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const params: { page?: number; size?: number; invoice_id?: string } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.size = ctx.query.size;
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

function buildSubscriptionsEndpoints(client: StreamPayClient, adminOptions: AdminOptions) {
	return {
		adminCreateSubscription: createAuthEndpoint(
			"/admin/streampay/subscriptions",
			{
				method: "POST",
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const input = ctx.body as unknown as SubscriptionCreate;
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
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				const user = await requireAdmin(ctx, adminOptions);
				const subscriptionId = ctx.params.id;
				const patch = ctx.body as unknown as SubscriptionUpdate;

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
					await applySubscriptionProjection(
						getAdapter(ctx),
						subscription,
						getLogger(ctx),
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
				const params: { page?: number; size?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.size = ctx.query.size;
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

		/**
		 * Immediate cancel from admin. Unlike the consumer `/subscription/cancel`,
		 * this one bypasses the local ownership check — an admin can cancel
		 * any subscription by StreamPay id. Mirrors the SDK's
		 * `SubscriptionCancel` body shape verbatim (only
		 * `cancel_related_invoices`; no period-end flag — StreamPay doesn't
		 * expose one on this endpoint).
		 */
		adminCancelSubscription: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id/cancel",
			{
				method: "POST",
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const subscriptionId = ctx.params.id;
				const input = ctx.body as unknown as SubscriptionCancel;
				try {
					const result = await client.cancelSubscription(subscriptionId, input);
					await applySubscriptionProjection(
						getAdapter(ctx),
						result,
						getLogger(ctx),
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

		/**
		 * Admin-initiated freeze. Creates a new freeze window on a
		 * subscription. Body matches `FreezeSubscriptionCreateRequest`
		 * from the SDK. Returns the created `FreezeSubscriptionBase`.
		 */
		adminFreezeSubscription: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id/freeze",
			{
				method: "POST",
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const subscriptionId = ctx.params.id;
				const input = ctx.body as unknown as FreezeSubscriptionCreateRequest;
				try {
					const freeze = await client.freezeSubscription(subscriptionId, input);
					await syncSubscriptionFromUpstream(
						client,
						getAdapter(ctx),
						subscriptionId,
						getLogger(ctx),
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

		/**
		 * List all freeze windows attached to a subscription. Useful for
		 * UIs that show "this sub is frozen X times" or for the
		 * adminDeleteFreeze / adminUpdateFreeze flows below that need a
		 * freeze id.
		 */
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

		/**
		 * Update an existing freeze window (shift start/end, change notes).
		 * Matches SDK's `updateSubscriptionFreeze` which takes
		 * `FreezeSubscriptionUpdateRequest` — note that
		 * `freeze_start_datetime` is REQUIRED on update even if it doesn't
		 * change (per OpenAPI schema).
		 */
		adminUpdateSubscriptionFreeze: createAuthEndpoint(
			"/admin/streampay/subscriptions/:id/freeze/:freezeId",
			{
				method: "PUT",
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const { id: subscriptionId, freezeId } = ctx.params;
				const input = ctx.body as unknown as FreezeSubscriptionUpdateRequest;
				try {
					const freeze = await client.updateSubscriptionFreeze(subscriptionId, freezeId, input);
					await syncSubscriptionFromUpstream(
						client,
						getAdapter(ctx),
						subscriptionId,
						getLogger(ctx),
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

		/**
		 * Delete (unfreeze) a specific freeze window. This is how you
		 * "unfreeze" as an admin: find the active freeze id via
		 * adminListSubscriptionFreezes, then DELETE it.
		 *
		 * Returns `{ deleted: true }` on success — the SDK's
		 * `deleteSubscriptionFreeze` returns `void`, so we synthesize a
		 * response body for client feedback.
		 */
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
					await syncSubscriptionFromUpstream(
						client,
						getAdapter(ctx),
						subscriptionId,
						getLogger(ctx),
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
				const params: { page?: number; size?: number; search_term?: string } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.size = ctx.query.size;
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
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const consumerId = ctx.params.id;
				const patch = ctx.body as unknown as ConsumerUpdate;
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

		// Delete on StreamPay AND clear the `streampayConsumerId` link so
		// the next checkout lazy-creates instead of 404'ing. deleteConsumer
		// 404 is treated as success (race); a failed link-clear only logs.
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

				let externalId: string | undefined;
				try {
					const consumer = await client.getConsumer(consumerId);
					if (typeof consumer.external_id === "string" && consumer.external_id.length > 0) {
						externalId = consumer.external_id;
					}
				} catch (err) {
					toAPIError(
						`StreamPay getConsumer failed for consumer=${consumerId}:`,
						err,
						getLogger(ctx),
					);
				}

				try {
					await client.deleteConsumer(consumerId);
				} catch (err) {
					// 404 race — already gone, still sync the user row below.
					if (!isNotFoundError(err)) {
						toAPIError(
							`StreamPay deleteConsumer failed for consumer=${consumerId}:`,
							err,
							getLogger(ctx),
						);
					}
				}

				if (externalId) {
					try {
						await ctx.context.internalAdapter.updateUser(externalId, {
							streampayConsumerId: null,
						});
					} catch (err: unknown) {
						// User row gone / DB write failed. Don't surface as 500
						// — the StreamPay delete already succeeded.
						getLogger(ctx).error(
							`StreamPay admin delete: link clear failed for user=${externalId} consumer=${consumerId}: ${formatStreamPayError(err)}`,
						);
					}
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
				const params: { page?: number; size?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.size = ctx.query.size;
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
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const input = ctx.body as unknown as ProductCreate;
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
				const params: { page?: number; size?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.size = ctx.query.size;
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
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const productId = ctx.params.id;
				const patch = ctx.body as unknown as ProductUpdate;
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
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const input = ctx.body as unknown as CouponCreate;
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
				const params: { page?: number; size?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.size = ctx.query.size;
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
				body: ForwardedBody,
				use: [sessionMiddleware],
			},
			async (ctx) => {
				await requireAdmin(ctx, adminOptions);
				const couponId = ctx.params.id;
				const patch = ctx.body as unknown as CouponUpdate;
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
				const params: { page?: number; size?: number } = {};
				if (ctx.query.page !== undefined) params.page = ctx.query.page;
				if (ctx.query.size !== undefined) params.size = ctx.query.size;
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
		page: z.coerce.number().int().positive().optional(),
		size: z.coerce.number().int().positive().max(100).optional(),
	})
	.passthrough();

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
						sortBy: { field: "processedAt", direction: "desc" },
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
					where: [{ field: "eventId", value: ctx.params.eventId }],
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
				if (!registry?.replayWebhookEvent) {
					throw new APIError("BAD_REQUEST", {
						message:
							"Replay unavailable — `subscriptions()` plugin must be in `use` and `enableWebhookEventTable` left enabled.",
					});
				}
				try {
					const result = await registry.replayWebhookEvent(ctx, ctx.params.eventId);
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
				const adapter = getAdapter(ctx);
				const row = await adapter.findOne<{ id: string }>({
					model: WEBHOOK_EVENT_MODEL,
					where: [{ field: "eventId", value: ctx.params.eventId }],
				});
				if (!row) {
					throw new APIError("NOT_FOUND", {
						code: $ERROR_CODES.NOT_FOUND.code,
						message: `Webhook event ${ctx.params.eventId} not found.`,
					});
				}
				// Flip to `completed` (instead of deleting) so the dedupe gate
				// still no-ops any future StreamPay re-deliveries.
				await markWebhookEventCompleted({ context: { adapter } }, row.id);
				return ctx.json({ discarded: true, eventId: ctx.params.eventId });
			},
		),
	};
}

export const admin =
	(adminOptions: AdminOptions = {}) =>
	(options: StreamPayOptions, registry?: StreamPayPluginRegistry) => {
		const client = options.client;
		return {
			endpoints: {
				...buildPaymentsEndpoints(client, adminOptions),
				...buildSubscriptionsEndpoints(client, adminOptions),
				...buildConsumersEndpoints(client, adminOptions),
				...buildInvoicesEndpoints(client, adminOptions),
				...buildProductsEndpoints(client, adminOptions),
				...buildCouponsEndpoints(client, adminOptions),
				...buildPaymentLinksEndpoints(client, adminOptions),
				...buildWebhookEventsEndpoints(adminOptions, registry),
			},
		};
	};
