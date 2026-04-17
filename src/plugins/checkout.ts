import type { CreatePaymentLinkDto } from "@streamsdk/typescript";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { z } from "zod";
import type { StreamPayOptions, StreamPayProduct } from "../types";
import { type EnsureConsumerContext, ensureConsumerForUser } from "../utils/ensure-consumer";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";

export interface CheckoutOptions {
	/**
	 * Optional slug → productId mapping so callers can request
	 * `{ slug: "pro" }` instead of hard-coding StreamPay UUIDs.
	 */
	products?: StreamPayProduct[] | (() => Promise<StreamPayProduct[]>);

	/** Absolute or site-relative URL StreamPay redirects to on success. */
	successUrl?: string;

	/** Absolute or site-relative URL StreamPay redirects to on failure. */
	failureUrl?: string;

	/** Reject unauthenticated callers and anonymous sessions. */
	authenticatedUsersOnly?: boolean;

	/**
	 * Optional static contact-information collection type passed through to
	 * StreamPay. Accepts any string StreamPay supports (the API evolves this
	 * enum, so we intentionally don't narrow it).
	 */
	contactInformationType?: "EMAIL" | "PHONE";

	/** Custom fields forwarded on every created payment link. */
	customFields?: Record<string, unknown>;
}

const RelativeOrAbsoluteUrl = z.string().refine((val) => val.startsWith("/") || URL.canParse(val), {
	message: "Must be a valid URL or a relative path starting with /",
});

export const CheckoutBody = z.object({
	products: z
		.union([
			z.array(
				z.object({
					productId: z.string().uuid(),
					quantity: z.number().int().positive().optional(),
				}),
			),
			z.array(z.string().uuid()),
			z.string().uuid(),
		])
		.optional(),
	slug: z.string().optional(),
	referenceId: z.string().optional(),
	consumerId: z.string().uuid().optional(),
	name: z.string().min(1).optional(),
	description: z.string().optional(),
	metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
	successUrl: RelativeOrAbsoluteUrl.optional(),
	failureUrl: RelativeOrAbsoluteUrl.optional(),
	maxNumberOfPayments: z.number().int().positive().optional(),
	validUntil: z.string().datetime().optional(),
	/**
	 * Coupon UUIDs to apply at the payment-link level. Maps directly to
	 * StreamPay's `CreatePaymentLinkDto.coupons`. Per-item coupons are
	 * not yet exposed — add them when an integrator needs them.
	 */
	couponIds: z.array(z.string().uuid()).optional(),
	redirect: z.coerce.boolean().optional(),
});

export type CheckoutParams = z.infer<typeof CheckoutBody>;

type PaymentLinkItem = CreatePaymentLinkDto["items"][number];

function buildItem(productId: string, quantity: number): PaymentLinkItem {
	return {
		product_id: productId,
		quantity,
		allow_custom_quantity: false,
	};
}

async function resolveProducts(
	body: CheckoutParams,
	options: CheckoutOptions,
): Promise<PaymentLinkItem[]> {
	if (body.slug) {
		const pool =
			typeof options.products === "function" ? await options.products() : options.products;
		const hit = pool?.find((p) => p.slug === body.slug);
		if (!hit) {
			throw new APIError("BAD_REQUEST", {
				message: `Unknown product slug: ${body.slug}`,
			});
		}
		return [buildItem(hit.productId, 1)];
	}

	if (body.products === undefined) {
		throw new APIError("BAD_REQUEST", {
			message: "Either `slug` or `products` is required.",
		});
	}

	if (typeof body.products === "string") {
		return [buildItem(body.products, 1)];
	}

	if (body.products.length === 0) {
		throw new APIError("BAD_REQUEST", {
			message: "`products` must contain at least one item.",
		});
	}

	return body.products.map((entry) =>
		typeof entry === "string"
			? buildItem(entry, 1)
			: buildItem(entry.productId, entry.quantity ?? 1),
	);
}

function resolveRedirectUrl(
	urlOrPath: string | undefined,
	request: Request | undefined,
	baseURL: string,
): string | undefined {
	if (!urlOrPath) return undefined;
	return new URL(urlOrPath, request?.url ?? baseURL).toString();
}

/**
 * Pick the consumer for this checkout. An explicit `body.consumerId`
 * always wins. For authenticated non-anonymous users we lazily ensure
 * a consumer exists and link it to the user row. Anonymous sessions
 * and unauthenticated callers get `null` — the StreamPay SDK's
 * `createPaymentLink` accepts that for guest-style checkout and will
 * smart-match the consumer by inline email/phone if the caller
 * provided them (not exposed from this endpoint today).
 */
async function resolveConsumerId(
	options: StreamPayOptions,
	ctx: EnsureConsumerContext,
	body: CheckoutParams,
	user: StreamPaySessionUser | null,
): Promise<string | null> {
	if (body.consumerId) return body.consumerId;
	if (!user) return null;
	if (user.isAnonymous) return null;
	const { consumerId } = await ensureConsumerForUser(options, ctx, user);
	return consumerId;
}

export const checkout =
	(checkoutOptions: CheckoutOptions = {}) =>
	(options: StreamPayOptions) => {
		const client = options.client;
		return {
			checkout: createAuthEndpoint(
				"/checkout",
				{
					method: "POST",
					body: CheckoutBody,
				},
				async (ctx) => {
					const session = await getSessionFromCtx(ctx);

					const sessionUser = asSessionUser(session?.user);

					if (checkoutOptions.authenticatedUsersOnly) {
						if (!sessionUser) {
							throw new APIError("UNAUTHORIZED", {
								message: "You must be logged in to checkout.",
							});
						}
						if (sessionUser.isAnonymous) {
							throw new APIError("UNAUTHORIZED", {
								message: "Anonymous users cannot checkout.",
							});
						}
					}

					const items = await resolveProducts(ctx.body, checkoutOptions);
					const consumerId = await resolveConsumerId(options, ctx, ctx.body, sessionUser);

					const successUrl = resolveRedirectUrl(
						ctx.body.successUrl ?? checkoutOptions.successUrl,
						ctx.request,
						ctx.context.baseURL,
					);
					const failureUrl = resolveRedirectUrl(
						ctx.body.failureUrl ?? checkoutOptions.failureUrl,
						ctx.request,
						ctx.context.baseURL,
					);

					const customMetadata: CreatePaymentLinkDto["custom_metadata"] = (() => {
						const base = ctx.body.metadata ?? {};
						const merged = ctx.body.referenceId
							? { referenceId: ctx.body.referenceId, ...base }
							: base;
						return Object.keys(merged).length > 0 ? merged : null;
					})();

					const payload: CreatePaymentLinkDto = {
						name: ctx.body.name ?? `Checkout ${new Date().toISOString()}`,
						description: ctx.body.description ?? null,
						items,
					};
					if (consumerId !== null) payload.organization_consumer_id = consumerId;
					if (successUrl) payload.success_redirect_url = successUrl;
					if (failureUrl) payload.failure_redirect_url = failureUrl;
					if (ctx.body.maxNumberOfPayments !== undefined) {
						payload.max_number_of_payments = ctx.body.maxNumberOfPayments;
					}
					if (ctx.body.validUntil !== undefined) {
						payload.valid_until = ctx.body.validUntil;
					}
					if (ctx.body.couponIds && ctx.body.couponIds.length > 0) {
						payload.coupons = ctx.body.couponIds;
					}
					if (customMetadata !== null) payload.custom_metadata = customMetadata;
					if (checkoutOptions.customFields) {
						payload.custom_fields = checkoutOptions.customFields;
					}
					if (checkoutOptions.contactInformationType) {
						payload.contact_information_type = checkoutOptions.contactInformationType;
					}

					try {
						const link = await client.createPaymentLink(payload);

						const url = client.getPaymentUrl(link);
						if (!url) {
							throw new APIError("INTERNAL_SERVER_ERROR", {
								message: "StreamPay payment link created but no URL was returned.",
							});
						}

						return ctx.json({
							url,
							id: link.id ?? null,
							redirect: ctx.body.redirect ?? true,
						});
					} catch (err: unknown) {
						if (err instanceof APIError) throw err;
						const message = err instanceof Error ? err.message : String(err);
						ctx.context.logger.error(`StreamPay checkout creation failed: ${message}`);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "StreamPay checkout creation failed.",
						});
					}
				},
			),
		};
	};
