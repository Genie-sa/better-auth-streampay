import type { CreatePaymentLinkDto } from "@streamsdk/typescript";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { z } from "zod";
import type { StreamPayOptions, StreamPayProduct } from "../types";
import { type EnsureConsumerContext, ensureConsumerForUser } from "../utils/ensure-consumer";
import { toAPIError } from "../utils/errors";
import { getLogger } from "../utils/logger";
import { asSessionUser, type StreamPaySessionUser } from "../utils/session";

export interface StreamPayCustomFieldDefinition {
	type: "string";
	title?: string;
	description?: string;
}

export interface StreamPayCustomFieldsSchema {
	type: "object";
	properties: Record<string, StreamPayCustomFieldDefinition>;
	required?: string[];
}

export interface CheckoutOptions {
	products?: StreamPayProduct[] | (() => Promise<StreamPayProduct[]>);
	successUrl?: string;
	failureUrl?: string;
	authenticatedUsersOnly?: boolean;
	contactInformationType?: "EMAIL" | "PHONE";
	currency?: CreatePaymentLinkDto["currency"];
	customFields?: StreamPayCustomFieldsSchema;
}

const RelativeOrAbsoluteUrl = z.string().refine((val) => val.startsWith("/") || URL.canParse(val), {
	message: "Must be a valid URL or a relative path starting with /",
});

export const CheckoutBody = z
	.object({
		products: z
			.union([
				z
					.array(
						z.object({
							productId: z.string().uuid(),
							quantity: z.number().int().positive().optional(),
						}),
					)
					.nonempty("`products` must contain at least one item."),
				z.array(z.string().uuid()).nonempty("`products` must contain at least one item."),
				z.string().uuid(),
			])
			.optional(),
		slug: z.string().optional(),
		referenceId: z.string().optional(),
		name: z.string().min(1).optional(),
		description: z.string().optional(),
		metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
		successUrl: RelativeOrAbsoluteUrl.optional(),
		failureUrl: RelativeOrAbsoluteUrl.optional(),
		maxNumberOfPayments: z.number().int().positive().optional(),
		validUntil: z.string().datetime().optional(),
		couponIds: z.array(z.string().uuid()).optional(),
		redirect: z.coerce.boolean().optional(),
	})
	.refine((data) => data.slug !== undefined || data.products !== undefined, {
		message: "Either `slug` or `products` is required.",
		path: ["products"],
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

	const products = body.products as NonNullable<CheckoutParams["products"]>;
	if (typeof products === "string") return [buildItem(products, 1)];

	return products.map((entry) =>
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

async function resolveConsumerId(
	options: StreamPayOptions,
	ctx: EnsureConsumerContext,
	user: StreamPaySessionUser | null,
): Promise<string | null> {
	if (!user || user.isAnonymous) return null;
	const { consumerId } = await ensureConsumerForUser(options, ctx, user);
	return consumerId;
}

export const checkout =
	(checkoutOptions: CheckoutOptions = {}) =>
	(options: StreamPayOptions) => {
		const client = options.client;
		return {
			endpoints: {
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
						const consumerId = await resolveConsumerId(options, ctx, sessionUser);

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
							currency: checkoutOptions.currency ?? "SAR",
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
							// SDK 1.1.3 generates this JSON Schema field as Record<string, never>.
							payload.custom_fields = checkoutOptions.customFields as unknown as NonNullable<
								CreatePaymentLinkDto["custom_fields"]
							>;
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
						} catch (err) {
							toAPIError(
								{
									logPrefix: "checkout creation failed:",
									userMessage: "StreamPay checkout creation failed.",
								},
								err,
								getLogger(ctx),
							);
						}
					},
				),
			},
		};
	};
