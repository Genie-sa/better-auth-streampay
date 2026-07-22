import type { CreatePaymentLinkDto } from "@streamsdk/typescript";
import type { GenericEndpointContext, User } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { z } from "zod";
import type { StreamPayOptions, StreamPayProduct } from "../types";
import { type EnsureConsumerContext, ensureConsumerForUser } from "../utils/ensure-consumer";
import { toAPIError } from "../utils/errors";
import { formatStreamPayError } from "../utils/format-error";
import { getLogger, type ScopedLogger } from "../utils/logger";
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

type CheckoutUser = User & StreamPaySessionUser & Record<string, unknown>;

export interface CheckoutResolutionContext {
	/** Resolved Better Auth user, including app-defined user fields. */
	user: CheckoutUser | null;
	/** Validated but untrusted client input. */
	body: CheckoutParams;
}

export interface CheckoutOverrides {
	products?: Array<{ productId: string; quantity?: number }>;
	name?: string;
	description?: string;
	successUrl?: string;
	failureUrl?: string;
	maxNumberOfPayments?: number;
	validUntil?: string;
	couponIds?: string[];
	metadata?: Record<string, string | number | boolean>;
	referenceId?: string;
}

export interface CheckoutCreatedContext {
	user: CheckoutUser | null;
	referenceId?: string;
	paymentLinkId: string;
	url: string;
	/** The exact payload sent to StreamPay. */
	payload: CreatePaymentLinkDto;
}

export interface CheckoutOptions {
	products?: StreamPayProduct[] | (() => Promise<StreamPayProduct[]>);
	successUrl?: string;
	failureUrl?: string;
	authenticatedUsersOnly?: boolean;
	contactInformationType?: "EMAIL" | "PHONE";
	currency?: CreatePaymentLinkDto["currency"];
	customFields?: StreamPayCustomFieldsSchema;
	/**
	 * Derive checkout fields on the server for each request. When configured, the
	 * client may only send `referenceId` and `redirect`; all payment fields must be
	 * returned here.
	 */
	resolveCheckout?: (
		data: CheckoutResolutionContext,
		ctx: GenericEndpointContext,
	) => Promise<CheckoutOverrides> | CheckoutOverrides;
	/**
	 * Persist app state after link creation and before the response is returned.
	 * A thrown error aborts checkout and triggers best-effort link deactivation.
	 */
	onCheckoutCreated?: (
		data: CheckoutCreatedContext,
		ctx: GenericEndpointContext,
	) => Promise<void> | void;
}

const RelativeOrAbsoluteUrl = z.string().refine((val) => val.startsWith("/") || URL.canParse(val), {
	message: "Must be a valid URL or a relative path starting with /",
});

const CheckoutRequestBody = z.object({
	products: z
		.union([
			z
				.array(
					z.object({
						productId: z.string().uuid(),
						quantity: z.number().int().positive().optional(),
					}),
				)
				.min(1, "`products` must contain at least one item."),
			z.array(z.string().uuid()).min(1, "`products` must contain at least one item."),
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
});

export const CheckoutBody = CheckoutRequestBody.refine(
	(data) => data.slug !== undefined || data.products !== undefined,
	{
		message: "Either `slug` or `products` is required.",
		path: ["products"],
	},
);

export type CheckoutParams = z.infer<typeof CheckoutBody>;

type PaymentLinkItem = CreatePaymentLinkDto["items"][number];

const SERVER_ONLY_CHECKOUT_FIELDS = [
	"products",
	"slug",
	"name",
	"description",
	"metadata",
	"successUrl",
	"failureUrl",
	"maxNumberOfPayments",
	"validUntil",
	"couponIds",
] as const satisfies readonly (keyof CheckoutParams)[];

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

function rejectUntrustedClientFields(body: CheckoutParams): void {
	const supplied = SERVER_ONLY_CHECKOUT_FIELDS.filter(
		(field) => Object.hasOwn(body, field) && body[field] !== undefined,
	);
	if (supplied.length === 0) return;

	throw new APIError("BAD_REQUEST", {
		code: "CHECKOUT_CLIENT_FIELDS_FORBIDDEN",
		message: "Checkout product and payment fields must be resolved by the server.",
	});
}

function mergeCheckoutOverrides(
	body: CheckoutParams,
	overrides: CheckoutOverrides,
): CheckoutParams {
	const effective: CheckoutParams = { ...body };

	if (overrides.products !== undefined) {
		effective.products = overrides.products;
		delete effective.slug;
	}
	if (overrides.name !== undefined) effective.name = overrides.name;
	if (overrides.description !== undefined) effective.description = overrides.description;
	if (overrides.successUrl !== undefined) effective.successUrl = overrides.successUrl;
	if (overrides.failureUrl !== undefined) effective.failureUrl = overrides.failureUrl;
	if (overrides.maxNumberOfPayments !== undefined) {
		effective.maxNumberOfPayments = overrides.maxNumberOfPayments;
	}
	if (overrides.validUntil !== undefined) effective.validUntil = overrides.validUntil;
	if (overrides.couponIds !== undefined) effective.couponIds = overrides.couponIds;
	if (overrides.referenceId !== undefined) effective.referenceId = overrides.referenceId;
	if (overrides.metadata !== undefined) {
		effective.metadata = { ...(body.metadata ?? {}), ...overrides.metadata };
	}

	return effective;
}

function validateEffectiveCheckout(body: CheckoutParams): CheckoutParams {
	const parsed = CheckoutBody.safeParse(body);
	if (parsed.success) return parsed.data;

	throw new APIError("BAD_REQUEST", {
		code: "VALIDATION_ERROR",
		message: parsed.error.issues[0]?.message ?? "Checkout parameters are invalid.",
	});
}

function checkoutUser(rawUser: unknown, user: StreamPaySessionUser | null): CheckoutUser | null {
	if (!user || rawUser === null || typeof rawUser !== "object") return null;
	return { ...rawUser, ...user } as CheckoutUser;
}

async function deactivatePaymentLinkBestEffort(
	client: StreamPayOptions["client"],
	paymentLinkId: string,
	logger: ScopedLogger,
): Promise<void> {
	if (!client.updatePaymentLinkStatus) {
		logger.error(
			`checkout compensation unavailable for payment_link=${paymentLinkId}: client does not implement updatePaymentLinkStatus`,
		);
		return;
	}
	try {
		await client.updatePaymentLinkStatus(paymentLinkId, { status: "INACTIVE" });
	} catch (err: unknown) {
		logger.error(
			`checkout compensation failed for payment_link=${paymentLinkId}: ${formatStreamPayError(err)}`,
		);
	}
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

export const checkout = (checkoutOptions: CheckoutOptions = {}) => {
	return (options: StreamPayOptions) => {
		const client = options.client;
		return {
			endpoints: {
				checkout: createAuthEndpoint(
					"/checkout",
					{
						method: "POST",
						body: checkoutOptions.resolveCheckout ? CheckoutRequestBody : CheckoutBody,
					},
					async (ctx) => {
						const session = await getSessionFromCtx(ctx);
						const sessionUser = asSessionUser(session?.user);
						const user = checkoutUser(session?.user, sessionUser);

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

						if (checkoutOptions.resolveCheckout) {
							rejectUntrustedClientFields(ctx.body);
						}

						let effective = ctx.body;
						if (checkoutOptions.resolveCheckout) {
							let overrides: CheckoutOverrides;
							try {
								overrides = await checkoutOptions.resolveCheckout({ user, body: ctx.body }, ctx);
							} catch (err: unknown) {
								if (err instanceof APIError) throw err;
								getLogger(ctx).error(`resolveCheckout failed: ${formatStreamPayError(err)}`);
								throw new APIError("INTERNAL_SERVER_ERROR", {
									message: "Checkout resolution failed.",
								});
							}
							effective = mergeCheckoutOverrides(ctx.body, overrides);
						}
						effective = validateEffectiveCheckout(effective);

						const items = await resolveProducts(effective, checkoutOptions);
						const consumerId = await resolveConsumerId(options, ctx, sessionUser);

						const successUrl = resolveRedirectUrl(
							effective.successUrl ?? checkoutOptions.successUrl,
							ctx.request,
							ctx.context.baseURL,
						);
						const failureUrl = resolveRedirectUrl(
							effective.failureUrl ?? checkoutOptions.failureUrl,
							ctx.request,
							ctx.context.baseURL,
						);

						const customMetadata: CreatePaymentLinkDto["custom_metadata"] = (() => {
							const merged = { ...(effective.metadata ?? {}) };
							if (effective.referenceId !== undefined) {
								merged.referenceId = effective.referenceId;
							}
							return Object.keys(merged).length > 0 ? merged : null;
						})();

						const payload: CreatePaymentLinkDto = {
							name: effective.name ?? `Checkout ${new Date().toISOString()}`,
							description: effective.description ?? null,
							currency: checkoutOptions.currency ?? "SAR",
							items,
						};
						if (consumerId !== null) payload.organization_consumer_id = consumerId;
						if (successUrl) payload.success_redirect_url = successUrl;
						if (failureUrl) payload.failure_redirect_url = failureUrl;
						if (effective.maxNumberOfPayments !== undefined) {
							payload.max_number_of_payments = effective.maxNumberOfPayments;
						}
						if (effective.validUntil !== undefined) {
							payload.valid_until = effective.validUntil;
						}
						if (effective.couponIds && effective.couponIds.length > 0) {
							payload.coupons = effective.couponIds;
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
							const paymentLinkId =
								typeof link.id === "string" && link.id.length > 0 ? link.id : null;
							let url: string;
							try {
								const resolvedUrl = client.getPaymentUrl(link);
								if (!resolvedUrl) {
									throw new APIError("INTERNAL_SERVER_ERROR", {
										message: "StreamPay payment link created but no URL was returned.",
									});
								}
								url = resolvedUrl;

								if (checkoutOptions.onCheckoutCreated) {
									if (!paymentLinkId) {
										throw new APIError("INTERNAL_SERVER_ERROR", {
											message: "StreamPay payment link created but no id was returned.",
										});
									}
									try {
										const callbackData: CheckoutCreatedContext = {
											user,
											paymentLinkId,
											url,
											payload,
										};
										if (effective.referenceId !== undefined) {
											callbackData.referenceId = effective.referenceId;
										}
										await checkoutOptions.onCheckoutCreated(callbackData, ctx);
									} catch (err: unknown) {
										if (err instanceof APIError) throw err;
										getLogger(ctx).error(`onCheckoutCreated failed: ${formatStreamPayError(err)}`);
										throw new APIError("INTERNAL_SERVER_ERROR", {
											message: "Checkout persistence failed.",
										});
									}
								}
							} catch (err: unknown) {
								if (paymentLinkId) {
									await deactivatePaymentLinkBestEffort(client, paymentLinkId, getLogger(ctx));
								}
								throw err;
							}
							return ctx.json({
								url,
								id: paymentLinkId,
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
};
