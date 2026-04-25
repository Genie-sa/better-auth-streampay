import type {
	ConsumerCreate,
	ConsumerListResponse,
	ConsumerResponse,
	ConsumerUpdate,
	CouponCreate,
	CouponDetailed,
	CouponListResponse,
	CouponUpdate,
	CreatePaymentLinkDto,
	FreezeListResponse,
	FreezeSubscriptionBase,
	FreezeSubscriptionCreateRequest,
	FreezeSubscriptionUpdateRequest,
	InvoiceDetailed,
	InvoiceListResponse,
	PaginationParams,
	PaymentLinkDetailed,
	PaymentLinkListResponse,
	PaymentListResponse,
	PaymentRefundRequest,
	PaymentResponse,
	ProductCreate,
	ProductDto,
	ProductListResponse,
	ProductUpdate,
	SubscriptionCancel,
	SubscriptionCreate,
	SubscriptionDetailed,
	SubscriptionListResponse,
	SubscriptionUpdate,
} from "@streamsdk/typescript";
import type { UnionToIntersection, User } from "better-auth";
import type { admin } from "./plugins/admin";
import type { checkout } from "./plugins/checkout";
import type { portal } from "./plugins/portal";
import type { subscriptions } from "./plugins/subscriptions";
import type { webhooks } from "./plugins/webhooks";

// The SDK's `listConsumers` is typed as PaginationParams only, but the
// `/api/v2/consumers` endpoint also accepts `search_term`. The runtime
// passes params straight through, so widening here is safe.
export type StreamPayListConsumersParams = PaginationParams & {
	search_term?: string | null;
};

// Same SDK vs OpenAPI gap as above. The underlying HTTP client
// forwards any extra query parameters unchanged, so widening here is
// safe until `@streamsdk/typescript` regenerates with the full filter
// set from the OpenAPI spec.
//
// Canonical reference for available filters:
// GET /api/v2/subscriptions
// GET /api/v2/invoices
export type StreamPayListSubscriptionsParams = PaginationParams & {
	organization_consumer_id?: string | null;
	statuses?: string[];
	latest_invoice_is_paid?: boolean;
	from_date?: string;
	to_date?: string;
	current_period_start_from_date?: string;
	current_period_start_to_date?: string;
	current_period_end_from_date?: string;
	current_period_end_to_date?: string;
	from_price?: number | string;
	to_price?: number | string;
	search_term?: string;
	product_ids?: string[];
	currencies?: string;
	sort_field?: string;
	sort_direction?: string;
};

export type StreamPayListInvoicesParams = PaginationParams & {
	organization_consumer_id?: string | null;
	subscription_id?: string | null;
	include_payments?: boolean;
	payment_link_id?: string;
	statuses?: string[];
	payment_statuses?: string[];
	search_term?: string;
	from_date?: string;
	to_date?: string;
	due_date_from?: string;
	due_date_to?: string;
	from_price?: number | string;
	to_price?: number | string;
	currencies?: string;
	payments_not_settled?: boolean;
	sort_field?: string;
	sort_direction?: string;
};

export interface StreamPayClient {
	// Consumers
	createConsumer(input: ConsumerCreate): Promise<ConsumerResponse>;
	listConsumers(params?: StreamPayListConsumersParams): Promise<ConsumerListResponse>;
	getConsumer(consumerId: string): Promise<ConsumerResponse>;
	updateConsumer(consumerId: string, input: ConsumerUpdate): Promise<ConsumerResponse>;
	deleteConsumer(consumerId: string): Promise<void>;

	// Payment links
	createPaymentLink(input: CreatePaymentLinkDto): Promise<PaymentLinkDetailed>;
	listPaymentLinks(params?: PaginationParams): Promise<PaymentLinkListResponse>;
	getPaymentLink(paymentLinkId: string): Promise<PaymentLinkDetailed>;
	getPaymentUrl(link: PaymentLinkDetailed): string | null;

	// Products
	createProduct(input: ProductCreate): Promise<ProductDto>;
	listProducts(params?: PaginationParams): Promise<ProductListResponse>;
	getProduct(productId: string): Promise<ProductDto>;
	updateProduct(productId: string, input: ProductUpdate): Promise<ProductDto>;
	deleteProduct(productId: string): Promise<void>;

	// Coupons
	createCoupon(input: CouponCreate): Promise<CouponDetailed>;
	listCoupons(params?: PaginationParams): Promise<CouponListResponse>;
	getCoupon(couponId: string): Promise<CouponDetailed>;
	updateCoupon(couponId: string, input: CouponUpdate): Promise<CouponDetailed>;
	deleteCoupon(couponId: string): Promise<void>;

	// Subscriptions
	createSubscription(input: SubscriptionCreate): Promise<SubscriptionDetailed>;
	listSubscriptions(params?: StreamPayListSubscriptionsParams): Promise<SubscriptionListResponse>;
	getSubscription(subscriptionId: string): Promise<SubscriptionDetailed>;
	updateSubscription(
		subscriptionId: string,
		input: SubscriptionUpdate,
	): Promise<SubscriptionDetailed>;
	cancelSubscription(
		subscriptionId: string,
		input?: SubscriptionCancel,
	): Promise<SubscriptionDetailed>;
	freezeSubscription(
		subscriptionId: string,
		input: FreezeSubscriptionCreateRequest,
	): Promise<FreezeSubscriptionBase>;
	listSubscriptionFreezes(subscriptionId: string): Promise<FreezeListResponse>;
	updateSubscriptionFreeze(
		subscriptionId: string,
		freezeId: string,
		input: FreezeSubscriptionUpdateRequest,
	): Promise<FreezeSubscriptionBase>;
	deleteSubscriptionFreeze(subscriptionId: string, freezeId: string): Promise<void>;

	// Invoices
	listInvoices(params?: StreamPayListInvoicesParams): Promise<InvoiceListResponse>;
	getInvoice(invoiceId: string): Promise<InvoiceDetailed>;

	// Payments
	listPayments(params?: {
		page?: number;
		size?: number;
		invoice_id?: string;
	}): Promise<PaymentListResponse>;
	getPayment(paymentId: string): Promise<PaymentResponse>;
	refundPayment(paymentId: string, input: PaymentRefundRequest): Promise<PaymentResponse>;
}

export interface StreamPayProduct {
	productId: string;
	slug: string;
}

export type StreamPayPlugin =
	| ReturnType<typeof admin>
	| ReturnType<typeof checkout>
	| ReturnType<typeof portal>
	| ReturnType<typeof subscriptions>
	| ReturnType<typeof webhooks>;

export type StreamPayPlugins = readonly StreamPayPlugin[];

export type StreamPayEndpoints = UnionToIntersection<ReturnType<StreamPayPlugin>["endpoints"]>;

export interface ConsumerCreateOverrides {
	phone_number?: string;
	alias?: string;
	comment?: string;
	preferred_language?: string;
	iban?: string;
	communication_methods?: ("WHATSAPP" | "EMAIL" | "SMS")[];
}

export type ClaimExistingConsumerIdentifier = "email" | "phone";
export type ClaimExistingConsumerBy = readonly ClaimExistingConsumerIdentifier[];

export interface StreamPayOptions {
	/** StreamPay SDK client (or any value satisfying `StreamPayClient`). */
	client: StreamPayClient;

	/**
	 * Eagerly create a StreamPay consumer on sign-up with
	 * `external_id: user.id`. Defaults to `false`; consumers are created
	 * lazily at first checkout or subscription mutation.
	 */
	createConsumerOnSignUp?: boolean;

	/**
	 * Reclaim a duplicate consumer that matches by `email`, `phone`, or
	 * both. Omit to only reuse consumers with empty `external_id`.
	 */
	claimExistingConsumerBy?: ClaimExistingConsumerBy;

	/** StreamPay-specific consumer fields supplied at creation time. */
	getConsumerCreateParams?: (
		data: { user: Partial<User> },
		request?: Request,
	) => Promise<ConsumerCreateOverrides> | ConsumerCreateOverrides;

	/** Sub-plugins composed into the main plugin. */
	use: StreamPayPlugins;
}
