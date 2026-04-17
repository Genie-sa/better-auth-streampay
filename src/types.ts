import type {
	ConsumerCreate,
	ConsumerListResponse,
	ConsumerResponse,
	ConsumerUpdate,
	CreatePaymentLinkDto,
	FreezeSubscriptionBase,
	FreezeSubscriptionCreateRequest,
	InvoiceDetailed,
	InvoiceListResponse,
	PaginationParams,
	PaymentLinkDetailed,
	PaymentListResponse,
	PaymentResponse,
	SubscriptionCancel,
	SubscriptionDetailed,
	SubscriptionListResponse,
} from "@streamsdk/typescript";
import type { UnionToIntersection, User } from "better-auth";
import type { checkout } from "./plugins/checkout";
import type { portal } from "./plugins/portal";
import type { subscriptions } from "./plugins/subscriptions";
import type { webhooks } from "./plugins/webhooks";

/**
 * The subset of the StreamPay SDK client this plugin actually touches.
 * We intentionally re-declare it as an interface (rather than importing
 * `StreamClient` from `@streamsdk/typescript`) because the SDK does not
 * currently export the class type. Declaring the contract here also lets
 * advanced users swap in a custom implementation (a mock, an HTTP client
 * they control, a future fork) without us caring where it came from.
 *
 * Every method signature below matches `@streamsdk/typescript@1.0.6`
 * exactly; we deliberately do NOT widen the parameter types, so when the
 * SDK tightens its DTOs our plugin inherits the improvement for free.
 */
export interface StreamPayClient {
	// Consumers
	createConsumer(input: ConsumerCreate): Promise<ConsumerResponse>;
	listConsumers(params?: PaginationParams): Promise<ConsumerListResponse>;
	getConsumer(consumerId: string): Promise<ConsumerResponse>;
	updateConsumer(consumerId: string, input: ConsumerUpdate): Promise<ConsumerResponse>;
	deleteConsumer(consumerId: string): Promise<void>;

	// Payment links
	createPaymentLink(input: CreatePaymentLinkDto): Promise<PaymentLinkDetailed>;
	getPaymentUrl(link: PaymentLinkDetailed): string | null;

	// Subscriptions
	listSubscriptions(params?: PaginationParams): Promise<SubscriptionListResponse>;
	getSubscription(subscriptionId: string): Promise<SubscriptionDetailed>;
	cancelSubscription(
		subscriptionId: string,
		input?: SubscriptionCancel,
	): Promise<SubscriptionDetailed>;
	freezeSubscription(
		subscriptionId: string,
		input: FreezeSubscriptionCreateRequest,
	): Promise<FreezeSubscriptionBase>;

	// Invoices
	listInvoices(params?: PaginationParams): Promise<InvoiceListResponse>;
	getInvoice(invoiceId: string): Promise<InvoiceDetailed>;

	// Payments
	listPayments(params?: { invoice_id?: string }): Promise<PaymentListResponse>;
	getPayment(paymentId: string): Promise<PaymentResponse>;
}

export interface StreamPayProduct {
	productId: string;
	slug: string;
}

export type StreamPayPlugin =
	| ReturnType<typeof checkout>
	| ReturnType<typeof portal>
	| ReturnType<typeof subscriptions>
	| ReturnType<typeof webhooks>;

/**
 * Readonly array of sub-plugins. An empty array is valid — a user who
 * wants nothing but `createConsumerOnSignUp` consumer sync can pass
 * `use: []` and skip checkout/portal/subscriptions/webhooks entirely.
 */
export type StreamPayPlugins = readonly StreamPayPlugin[];

export type StreamPayEndpoints = UnionToIntersection<ReturnType<StreamPayPlugin>>;

export interface ConsumerCreateOverrides {
	phone_number?: string;
	alias?: string;
	comment?: string;
	preferred_language?: string;
	iban?: string;
	communication_methods?: ("WHATSAPP" | "EMAIL" | "SMS")[];
}

export type ClaimExistingConsumerBy = "email" | "phone" | "both" | null;
export type ClaimExistingConsumerIdentifier = Extract<
	ClaimExistingConsumerBy,
	"email" | "phone"
>;

export interface StreamPayOptions {
	/**
	 * An initialized StreamPay SDK client (from `@streamsdk/typescript`,
	 * or any value that satisfies `StreamPayClient`). The plugin never
	 * touches credentials directly — you own the client.
	 */
	client: StreamPayClient;

	/**
	 * When `true`, a StreamPay consumer is created on sign-up with
	 * `external_id: user.id`. The resulting consumer id is written back
	 * onto the Better Auth user row as `streampayConsumerId`.
	 */
	createConsumerOnSignUp?: boolean;

	/**
	 * Reclaim a duplicate consumer when it matches an existing linked
	 * record by email, phone, or either identifier. `null` / `undefined`
	 * disables reclaim and only allows reusing stranded consumers whose
	 * `external_id` is empty.
	 */
	claimExistingConsumerBy?: ClaimExistingConsumerBy;

	/**
	 * Provide StreamPay-specific consumer fields at creation time
	 * (phone, preferred language, VAT number, etc.). Runs inside a
	 * database hook, so it must resolve quickly.
	 */
	getConsumerCreateParams?: (
		data: { user: Partial<User> },
		request?: Request,
	) => Promise<ConsumerCreateOverrides> | ConsumerCreateOverrides;

	/** Sub-plugins composed into the main `streampay()` plugin. */
	use: StreamPayPlugins;
}
