import type {
	ConsumerCreate,
	ConsumerListResponse,
	ConsumerResponse,
	ConsumerUpdate,
	CreatePaymentLinkDto,
	FreezeSubscriptionBase,
	FreezeSubscriptionCreateRequest,
	InvoiceListItem,
	InvoiceListResponse,
	PaginationParams,
	PaymentLinkDetailed,
	SubscriptionCancel,
	SubscriptionDetailed,
	SubscriptionListResponse,
} from "@streamsdk/typescript";
import type { User } from "better-auth";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { StreamPayClient } from "../../src/types";

/**
 * Exact shape of a mocked `StreamPayClient`. Each method is a `vi.fn`
 * whose generic is pinned to the real signature, so the object literal
 * below is structurally assignable to `StreamPayClient` without any
 * cast — assertions, `.mockResolvedValue`, and type errors all work as
 * they would on the real class.
 */
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
	getPaymentUrl: vi.fn<(link: PaymentLinkDetailed) => string | null>(),
	listSubscriptions: vi.fn<(params?: PaginationParams) => Promise<SubscriptionListResponse>>(),
	getSubscription: vi.fn<(subscriptionId: string) => Promise<SubscriptionDetailed>>(),
	cancelSubscription:
		vi.fn<(subscriptionId: string, input?: SubscriptionCancel) => Promise<SubscriptionDetailed>>(),
	freezeSubscription:
		vi.fn<
			(
				subscriptionId: string,
				input: FreezeSubscriptionCreateRequest,
			) => Promise<FreezeSubscriptionBase>
		>(),
	listInvoices: vi.fn<(params?: PaginationParams) => Promise<InvoiceListResponse>>(),
});

/**
 * `MockUser` extends Better Auth's real `User` type and adds the
 * `streampayConsumerId` column the plugin's schema extension injects.
 * Using Better Auth's `User` as the base means:
 *
 *   - Any new field Better Auth adds to `User` flows in automatically.
 *   - The plugin's hook signatures (`(user: User) => ...`) accept a
 *     `MockUser` without coercion.
 *   - TypeScript surfaces any real breaking change at compile time.
 */
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

/**
 * Explicit context shape used across tests. Built as a plain object so
 * each test can partially override any branch (session, request, body,
 * query) without TypeScript losing track of the remainder.
 */
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
		};
	};
	request: Request;
	headers: Headers;
	body: Record<string, unknown>;
	query: Record<string, unknown>;
	params: Record<string, string>;
	json: Mock<(value: unknown) => unknown>;
}

export const createMockContext = (options: MockCtxOptions = {}): MockCtx => {
	// Distinguish "no option passed" (use default user) from
	// "explicitly undefined" (test wants an unauthenticated ctx).
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
		},
		request: options.request ?? new Request("http://localhost:3000/test"),
		headers: new Headers(),
		body: options.body ?? {},
		query: options.query ?? {},
		params: {},
		json: vi.fn<(value: unknown) => unknown>((value: unknown) => value),
	};
};

// ----------------------------------------------------------------------
// Fixture builders — every field on the target type is optional, so a
// plain literal with sane defaults is assignable without any cast.
// ----------------------------------------------------------------------

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

// ----------------------------------------------------------------------
// List-response builders. Every field on `Pagination` is optional, so
// the object literal is assignable to the real SDK type directly.
// ----------------------------------------------------------------------

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

