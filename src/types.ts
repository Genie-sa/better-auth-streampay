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
	UpdatePaymentLinkStatusDto,
} from "@streamsdk/typescript";
import type { GenericEndpointContext, UnionToIntersection, User } from "better-auth";
import type { admin } from "./plugins/admin";
import type { checkout } from "./plugins/checkout";
import type { portal } from "./plugins/portal";
import type { subscriptions } from "./plugins/subscriptions";
import type { webhooks } from "./plugins/webhooks";

export type StreamPayListConsumersParams = PaginationParams & {
	search_term?: string | null;
};

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
	createConsumer(input: ConsumerCreate): Promise<ConsumerResponse>;
	listConsumers(params?: StreamPayListConsumersParams): Promise<ConsumerListResponse>;
	getConsumer(consumerId: string): Promise<ConsumerResponse>;
	updateConsumer(consumerId: string, input: ConsumerUpdate): Promise<ConsumerResponse>;
	deleteConsumer(consumerId: string): Promise<void>;

	createPaymentLink(input: CreatePaymentLinkDto): Promise<PaymentLinkDetailed>;
	listPaymentLinks(params?: PaginationParams): Promise<PaymentLinkListResponse>;
	getPaymentLink(paymentLinkId: string): Promise<PaymentLinkDetailed>;
	updatePaymentLinkStatus?(
		paymentLinkId: string,
		input: UpdatePaymentLinkStatusDto,
	): Promise<PaymentLinkDetailed>;
	getPaymentUrl(link: PaymentLinkDetailed): string | null;

	createProduct(input: ProductCreate): Promise<ProductDto>;
	listProducts(params?: PaginationParams): Promise<ProductListResponse>;
	getProduct(productId: string): Promise<ProductDto>;
	updateProduct(productId: string, input: ProductUpdate): Promise<ProductDto>;
	deleteProduct(productId: string): Promise<void>;

	createCoupon(input: CouponCreate): Promise<CouponDetailed>;
	listCoupons(params?: PaginationParams): Promise<CouponListResponse>;
	getCoupon(couponId: string): Promise<CouponDetailed>;
	updateCoupon(couponId: string, input: CouponUpdate): Promise<CouponDetailed>;
	deleteCoupon(couponId: string): Promise<void>;

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
	deletePendingSubscriptionChange(subscriptionId: string): Promise<void>;
	uncancelSubscription(subscriptionId: string): Promise<void>;

	listInvoices(params?: StreamPayListInvoicesParams): Promise<InvoiceListResponse>;
	getInvoice(invoiceId: string): Promise<InvoiceDetailed>;

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

export type ConsumerCreateOverrides = Partial<
	Omit<ConsumerCreate, "name" | "email" | "external_id">
>;

/**
 * Overrides for organization consumers. Unlike user consumers, organizations
 * have no plugin-owned email, so a billing email may be supplied here; `name`
 * and `external_id` stay plugin-owned.
 */
export type OrganizationConsumerOverrides = Partial<Omit<ConsumerCreate, "name" | "external_id">>;

export type ClaimExistingConsumerIdentifier = "email" | "phone";
export type ClaimExistingConsumerBy = readonly ClaimExistingConsumerIdentifier[];

/** Raw organization row as stored by the Better Auth organization plugin. */
export interface BillingOrganization {
	id: string;
	name: string;
	streampayConsumerId?: string | null;
	[field: string]: unknown;
}

export interface OrganizationBillingOptions {
	enabled: boolean;

	/**
	 * Physical table name of the organization model. Set this to the same value
	 * as the Better Auth organization plugin's `schema.organization.modelName`
	 * when that plugin uses a custom table name — plugin schema contributions
	 * each restate the model name, so omitting it here would reset a custom
	 * name back to `organization`.
	 */
	modelName?: string;

	/** Contact and tax fields for org consumers; `name` and `external_id` are plugin-owned. */
	getBillingDetails?: (
		data: { organization: BillingOrganization },
		ctx: GenericEndpointContext,
	) => Promise<OrganizationConsumerOverrides> | OrganizationConsumerOverrides;
}

export interface StreamPayOptions {
	client: StreamPayClient;

	createConsumerOnSignUp?: boolean;

	claimExistingConsumerBy?: ClaimExistingConsumerBy;

	getConsumerCreateParams?: (
		data: { user: Partial<User> },
		request?: Request,
	) => Promise<ConsumerCreateOverrides> | ConsumerCreateOverrides;

	/** Enables billing organization references to the org's own StreamPay consumer. */
	organization?: OrganizationBillingOptions;

	use: StreamPayPlugins;
}
