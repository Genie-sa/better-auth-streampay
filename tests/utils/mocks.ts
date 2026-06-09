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
	InvoiceListItem,
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
import type { User } from "better-auth";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { StreamPayClient } from "../../src/types";

export type MockedStreamPayClient = {
	[K in keyof StreamPayClient]: ReturnType<typeof vi.fn<StreamPayClient[K]>>;
};

export const createMockStreamPayClient = (): MockedStreamPayClient => ({
	createConsumer: vi.fn<(input: ConsumerCreate) => Promise<ConsumerResponse>>(),
	listConsumers: vi.fn<(params?: PaginationParams) => Promise<ConsumerListResponse>>(),
	getConsumer: vi.fn<(consumerId: string) => Promise<ConsumerResponse>>(),
	updateConsumer: vi.fn<(consumerId: string, input: ConsumerUpdate) => Promise<ConsumerResponse>>(),
	deleteConsumer: vi.fn<(consumerId: string) => Promise<void>>(),
	createPaymentLink: vi.fn<(input: CreatePaymentLinkDto) => Promise<PaymentLinkDetailed>>(),
	listPaymentLinks: vi.fn<(params?: PaginationParams) => Promise<PaymentLinkListResponse>>(),
	getPaymentLink: vi.fn<(paymentLinkId: string) => Promise<PaymentLinkDetailed>>(),
	getPaymentUrl: vi.fn<(link: PaymentLinkDetailed) => string | null>(),
	createProduct: vi.fn<(input: ProductCreate) => Promise<ProductDto>>(),
	listProducts: vi.fn<(params?: PaginationParams) => Promise<ProductListResponse>>(),
	getProduct: vi.fn<(productId: string) => Promise<ProductDto>>(),
	updateProduct: vi.fn<(productId: string, input: ProductUpdate) => Promise<ProductDto>>(),
	deleteProduct: vi.fn<(productId: string) => Promise<void>>(),
	createCoupon: vi.fn<(input: CouponCreate) => Promise<CouponDetailed>>(),
	listCoupons: vi.fn<(params?: PaginationParams) => Promise<CouponListResponse>>(),
	getCoupon: vi.fn<(couponId: string) => Promise<CouponDetailed>>(),
	updateCoupon: vi.fn<(couponId: string, input: CouponUpdate) => Promise<CouponDetailed>>(),
	deleteCoupon: vi.fn<(couponId: string) => Promise<void>>(),
	createSubscription: vi.fn<(input: SubscriptionCreate) => Promise<SubscriptionDetailed>>(),
	listSubscriptions: vi.fn<(params?: PaginationParams) => Promise<SubscriptionListResponse>>(),
	getSubscription: vi.fn<(subscriptionId: string) => Promise<SubscriptionDetailed>>(),
	updateSubscription:
		vi.fn<(subscriptionId: string, input: SubscriptionUpdate) => Promise<SubscriptionDetailed>>(),
	cancelSubscription:
		vi.fn<(subscriptionId: string, input?: SubscriptionCancel) => Promise<SubscriptionDetailed>>(),
	freezeSubscription:
		vi.fn<
			(
				subscriptionId: string,
				input: FreezeSubscriptionCreateRequest,
			) => Promise<FreezeSubscriptionBase>
		>(),
	listSubscriptionFreezes: vi.fn<(subscriptionId: string) => Promise<FreezeListResponse>>(),
	updateSubscriptionFreeze:
		vi.fn<
			(
				subscriptionId: string,
				freezeId: string,
				input: FreezeSubscriptionUpdateRequest,
			) => Promise<FreezeSubscriptionBase>
		>(),
	deleteSubscriptionFreeze: vi.fn<(subscriptionId: string, freezeId: string) => Promise<void>>(),
	listInvoices: vi.fn<(params?: PaginationParams) => Promise<InvoiceListResponse>>(),
	getInvoice: vi.fn<(invoiceId: string) => Promise<InvoiceDetailed>>(),
	listPayments:
		vi.fn<
			(params?: {
				page?: number;
				size?: number;
				invoice_id?: string;
			}) => Promise<PaymentListResponse>
		>(),
	getPayment: vi.fn<(paymentId: string) => Promise<PaymentResponse>>(),
	refundPayment:
		vi.fn<(paymentId: string, input: PaymentRefundRequest) => Promise<PaymentResponse>>(),
});

export type MockUser = User & {
	streampayConsumerId: string | null;
	isAnonymous?: boolean;
};

export const createMockUser = (overrides: Partial<MockUser> = {}): MockUser => ({
	id: "user-123",
	email: "test@example.com",
	name: "Test User",
	image: null,
	emailVerified: true,
	createdAt: new Date(),
	updatedAt: new Date(),
	streampayConsumerId: "cons_mocked",
	...overrides,
});

export interface MockCtxOptions {
	user?: MockUser | undefined;
	body?: Record<string, unknown>;
	query?: Record<string, unknown>;
	request?: Request;
}

export interface MockCtx {
	context: {
		baseURL: string;
		session: { user: MockUser | undefined };
		logger: {
			error: Mock<(message: string) => void>;
			warn: Mock<(message: string) => void>;
			info: Mock<(message: string) => void>;
			debug: Mock<(message: string) => void>;
		};
		internalAdapter: {
			updateUser: Mock<(...args: unknown[]) => Promise<void>>;
			findUserById?: Mock<(userId: string) => Promise<unknown>>;
		};
		adapter?: unknown;
	};
	request: Request;
	headers: Headers;
	body: Record<string, unknown>;
	query: Record<string, unknown>;
	params: Record<string, string>;
	json: Mock<(value: unknown) => unknown>;
}

export const createMockContext = (options: MockCtxOptions = {}): MockCtx => {
	const user = "user" in options ? options.user : createMockUser();
	return {
		context: {
			baseURL: "http://localhost:3000",
			session: { user },
			logger: {
				error: vi.fn<(message: string) => void>(),
				warn: vi.fn<(message: string) => void>(),
				info: vi.fn<(message: string) => void>(),
				debug: vi.fn<(message: string) => void>(),
			},
			internalAdapter: {
				updateUser: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
			},
			adapter: {
				findOne: vi.fn().mockResolvedValue(null),
				findMany: vi.fn().mockResolvedValue([]),
				create: vi.fn().mockResolvedValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
		},
		request: options.request ?? new Request("http://localhost:3000/test"),
		headers: new Headers(),
		body: options.body ?? {},
		query: options.query ?? {},
		params: {},
		json: vi.fn<(value: unknown) => unknown>((value: unknown) => value),
	};
};

export const createMockConsumer = (overrides: ConsumerResponse = {}): ConsumerResponse => ({
	id: "cons_mocked",
	name: "Test Consumer",
	email: "test@example.com",
	phone_number: null,
	external_id: "user-123",
	is_deleted: false,
	created_at: new Date().toISOString(),
	...overrides,
});

export const createMockPaymentLink = (
	overrides: PaymentLinkDetailed = {},
): PaymentLinkDetailed => ({
	id: "pl_mocked",
	name: "Test Checkout",
	url: "https://pay.streampay.sa/pl_mocked",
	amount: "10.00",
	currency: "SAR",
	organization_consumer_id: "cons_mocked",
	created_at: new Date().toISOString(),
	...overrides,
});

export const createMockSubscription = (
	overrides: SubscriptionDetailed = {},
): SubscriptionDetailed => ({
	id: "sub_mocked",
	organization_consumer_id: "cons_mocked",
	status: "ACTIVE",
	amount: "10.00",
	currency: "SAR",
	current_period_start: new Date().toISOString(),
	current_period_end: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
	created_at: new Date().toISOString(),
	...overrides,
});

export const createMockInvoice = (overrides: InvoiceListItem = {}): InvoiceListItem => ({
	id: "inv_mocked",
	organization_consumer_id: "cons_mocked",
	status: "COMPLETED",
	total_amount: "10.00",
	currency: "SAR",
	created_at: new Date().toISOString(),
	...overrides,
});

export const createMockProduct = (overrides: Partial<ProductDto> = {}): ProductDto => ({
	id: "prod_mocked",
	name: "Test Product",
	price: "10.00",
	currency: "SAR",
	is_used_in_finalized_invoice: false,
	created_at: new Date().toISOString(),
	...overrides,
});

export const createMockCoupon = (overrides: CouponDetailed = {}): CouponDetailed => ({
	id: "coupon_mocked",
	name: "TEST10",
	discount_value: "10",
	is_percentage: true,
	is_active: true,
	created_at: new Date().toISOString(),
	...overrides,
});

export const createMockInvoiceDetailed = (overrides: InvoiceDetailed = {}): InvoiceDetailed => ({
	id: "inv_mocked",
	organization_consumer_id: "cons_mocked",
	status: "COMPLETED",
	total_amount: "10.00",
	original_amount: "10.00",
	currency: "SAR",
	created_at: new Date().toISOString(),
	...overrides,
});

export const createMockConsumerList = (items: ConsumerResponse[] = []): ConsumerListResponse => ({
	data: items,
	pagination: {
		total_count: items.length,
		current_page: 1,
		limit: 100,
		max_page: Math.max(1, items.length),
		has_next_page: false,
		has_previous_page: false,
	},
});

export const createMockSubscriptionList = (
	items: SubscriptionDetailed[] = [],
): SubscriptionListResponse => ({
	data: items,
	pagination: {
		total_count: items.length,
		current_page: 1,
		limit: 100,
		max_page: Math.max(1, items.length),
		has_next_page: false,
		has_previous_page: false,
	},
});

export const createMockInvoiceList = (items: InvoiceListItem[] = []): InvoiceListResponse => ({
	data: items,
	pagination: {
		total_count: items.length,
		current_page: 1,
		limit: 100,
		max_page: Math.max(1, items.length),
		has_next_page: false,
		has_previous_page: false,
	},
});
