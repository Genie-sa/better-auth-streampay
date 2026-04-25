import type {
	PaymentRefundRequest,
	PaymentResponse,
	SubscriptionDetailed,
	SubscriptionUpdate,
} from "@streamsdk/typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockAPIError } = vi.hoisted(() => {
	class MockAPIError extends Error {
		public readonly code: string;
		public readonly data: { message?: string; code?: string } | undefined;
		public readonly errorCode: string | undefined;
		constructor(code: string, data?: { message?: string; code?: string }) {
			super(data?.message ?? code);
			this.name = "APIError";
			this.code = code;
			this.data = data;
			this.errorCode = data?.code;
		}
	}
	return { MockAPIError };
});

vi.mock("better-auth/api", () => ({
	APIError: MockAPIError,
	sessionMiddleware: vi.fn(),
	getSessionFromCtx: vi.fn(),
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import { admin } from "../src/plugins/admin";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
import {
	createMockConsumer,
	createMockContext,
	createMockStreamPayClient,
	createMockUser,
	type MockCtx,
	type MockedStreamPayClient,
	type MockUser,
} from "./utils/mocks";

type AdminMockUser = MockUser & { role?: string | null };

function createAdminUser(overrides: Partial<AdminMockUser> = {}): AdminMockUser {
	return createMockUser({ role: "admin", ...overrides } as Partial<MockUser>) as AdminMockUser;
}

function createMockPayment(overrides: PaymentResponse = {}): PaymentResponse {
	return {
		id: "pay_mocked",
		amount: "10.00",
		current_status: "SUCCEEDED",
		...overrides,
	};
}

function createMockSubscriptionDetailed(
	overrides: SubscriptionDetailed = {},
): SubscriptionDetailed {
	return {
		id: "sub_mocked",
		organization_consumer_id: "cons_mocked",
		status: "ACTIVE",
		amount: "10.00",
		currency: "SAR",
		current_period_start: new Date().toISOString(),
		current_period_end: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
		created_at: new Date().toISOString(),
		...overrides,
	};
}

function adminHandler(
	mockClient: MockedStreamPayClient,
	endpoint: keyof ReturnType<ReturnType<typeof admin>>["endpoints"],
) {
	const options = createTestStreamPayOptions({ client: mockClient });
	const { endpoints } = admin()(options);
	return unwrapHandler(endpoints[endpoint]);
}

describe("admin() plugin", () => {
	let mockClient: MockedStreamPayClient;

	beforeEach(() => {
		mockClient = createMockStreamPayClient();
		vi.clearAllMocks();
	});

	describe("admin gate", () => {
		it("rejects missing and non-admin sessions before any StreamPay call", async () => {
			const handler = adminHandler(mockClient, "adminListPayments");

			await expect(handler(createMockContext({ user: undefined }))).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});

			await expect(handler(createMockContext({ user: createMockUser() }))).rejects.toMatchObject({
				code: "FORBIDDEN",
				errorCode: "FORBIDDEN",
			});
			expect(mockClient.listPayments).not.toHaveBeenCalled();
		});

		it("accepts role-based admins, comma-separated roles, and custom adminRoles", async () => {
			mockClient.listPayments.mockResolvedValue({ data: [], pagination: {} });

			await expect(
				adminHandler(
					mockClient,
					"adminListPayments",
				)(createMockContext({ user: createAdminUser({ role: "editor, admin" }) })),
			).resolves.toEqual({ data: [], pagination: {} });

			const options = createTestStreamPayOptions({ client: mockClient });
			const customRoleHandler = unwrapHandler(
				admin({ adminRoles: ["owner"] })(options).endpoints.adminListPayments,
			);
			await expect(
				customRoleHandler(createMockContext({ user: createAdminUser({ role: "owner" }) })),
			).resolves.toBeDefined();
		});

		it("uses isAdmin only when role matching does not grant access", async () => {
			const isAdmin = vi.fn().mockResolvedValue(true);
			mockClient.listPayments.mockResolvedValue({ data: [], pagination: {} });
			const options = createTestStreamPayOptions({ client: mockClient });
			const handler = unwrapHandler(admin({ isAdmin })(options).endpoints.adminListPayments);

			const callbackUser = createMockUser();
			await handler(createMockContext({ user: callbackUser }));
			expect(isAdmin).toHaveBeenCalledWith(
				expect.objectContaining({ id: callbackUser.id, email: callbackUser.email }),
				expect.anything(),
			);

			isAdmin.mockClear();
			await handler(createMockContext({ user: createAdminUser() }));
			expect(isAdmin).not.toHaveBeenCalled();
		});
	});

	describe("refund hook", () => {
		it("runs onRefund before the SDK call and can block the refund", async () => {
			const onRefund =
				vi.fn<
					(ctx: {
						user: unknown;
						paymentId: string;
						request: PaymentRefundRequest;
					}) => Promise<void>
				>();
			mockClient.refundPayment.mockResolvedValue(
				createMockPayment({ id: "pay_42", current_status: "REFUNDED" }),
			);
			const options = createTestStreamPayOptions({ client: mockClient });
			const handler = unwrapHandler(admin({ onRefund })(options).endpoints.adminRefundPayment);
			const ctx = createMockContext({ user: createAdminUser({ id: "admin-1" }) });
			ctx.params = { id: "pay_42" };
			ctx.body = { amount: "5.00", refund_reason: "REQUESTED_BY_CUSTOMER" };

			await handler(ctx);

			expect(onRefund).toHaveBeenCalledWith({
				user: expect.objectContaining({ id: "admin-1" }),
				paymentId: "pay_42",
				request: ctx.body,
			});
			expect(onRefund.mock.invocationCallOrder[0]).toBeLessThan(
				mockClient.refundPayment.mock.invocationCallOrder[0] as number,
			);

			onRefund.mockRejectedValueOnce(new Error("over-limit"));
			await expect(handler(ctx)).rejects.toThrow(/over-limit/);
		});
	});

	describe("subscription plan-change hook", () => {
		it("fetches current subscription, runs onPlanChange before update, and can block", async () => {
			const current = createMockSubscriptionDetailed({ id: "sub_42", amount: "10.00" });
			const onPlanChange =
				vi.fn<
					(ctx: {
						user: unknown;
						subscriptionId: string;
						current: SubscriptionDetailed;
						patch: SubscriptionUpdate;
					}) => Promise<void>
				>();
			mockClient.getSubscription.mockResolvedValue(current);
			mockClient.updateSubscription.mockResolvedValue({ ...current, amount: "20.00" });
			const options = createTestStreamPayOptions({ client: mockClient });
			const handler = unwrapHandler(
				admin({ onPlanChange })(options).endpoints.adminUpdateSubscription,
			);
			const ctx = createMockContext({ user: createAdminUser({ id: "admin-7" }) });
			ctx.params = { id: "sub_42" };
			ctx.body = { amount: "20.00" };

			await handler(ctx);

			expect(mockClient.getSubscription).toHaveBeenCalledWith("sub_42");
			expect(onPlanChange).toHaveBeenCalledWith({
				user: expect.objectContaining({ id: "admin-7" }),
				subscriptionId: "sub_42",
				current,
				patch: { amount: "20.00" },
			});
			expect(onPlanChange.mock.invocationCallOrder[0]).toBeLessThan(
				mockClient.updateSubscription.mock.invocationCallOrder[0] as number,
			);

			onPlanChange.mockRejectedValueOnce(new Error("downgrades not allowed"));
			await expect(handler(ctx)).rejects.toThrow(/downgrades not allowed/);
		});

		it("forwards the caller's body verbatim — no auto-merge of items/coupons (avoids GET+PUT race)", async () => {
			mockClient.updateSubscription.mockResolvedValue(createMockSubscriptionDetailed());
			const handler = adminHandler(mockClient, "adminUpdateSubscription");
			const ctx = createMockContext({ user: createAdminUser() });
			ctx.params = { id: "sub_42" };
			ctx.body = {
				items: [{ product_id: "prod_a", quantity: 2 }],
				coupons: [],
				description: "renamed",
			};

			await handler(ctx);

			expect(mockClient.getSubscription).not.toHaveBeenCalled();
			expect(mockClient.updateSubscription).toHaveBeenCalledWith("sub_42", {
				items: [{ product_id: "prod_a", quantity: 2 }],
				coupons: [],
				description: "renamed",
			});
		});

		it("propagates StreamPay's 422 when the caller omits items/coupons (per OpenAPI contract)", async () => {
			mockClient.updateSubscription.mockRejectedValue(
				mockApiError(
					422,
					{ detail: [{ loc: ["body", "items"], msg: "Field required", type: "missing" }] },
					"PATCH",
					"/api/v2/subscriptions/sub_42",
				),
			);
			const handler = adminHandler(mockClient, "adminUpdateSubscription");
			const ctx = createMockContext({ user: createAdminUser() });
			ctx.params = { id: "sub_42" };
			ctx.body = { description: "renamed" };

			await expect(handler(ctx)).rejects.toMatchObject({
				code: "UNPROCESSABLE_ENTITY",
				errorCode: "VALIDATION_ERROR",
			});
		});
	});

	describe("consumer delete sync", () => {
		it("deletes upstream and clears the linked Better Auth user row", async () => {
			mockClient.getConsumer.mockResolvedValue(
				createMockConsumer({ id: "cons_linked", external_id: "user-42" }),
			);
			mockClient.deleteConsumer.mockResolvedValue(undefined);
			const handler = adminHandler(mockClient, "adminDeleteConsumer");
			const ctx = createMockContext({ user: createAdminUser() });
			ctx.params = { id: "cons_linked" };

			await expect(handler(ctx)).resolves.toEqual({ deleted: true });
			expect(ctx.context.internalAdapter.updateUser).toHaveBeenCalledWith("user-42", {
				streampayConsumerId: null,
			});
		});

		it("does not clear a user row when upstream delete fails with non-404", async () => {
			mockClient.getConsumer.mockResolvedValue(
				createMockConsumer({ id: "cons_x", external_id: "user-1" }),
			);
			mockClient.deleteConsumer.mockRejectedValue(
				mockApiError(500, { error: { code: "STREAM_ERROR", message: "db down" } }),
			);
			const handler = adminHandler(mockClient, "adminDeleteConsumer");
			const ctx = createMockContext({ user: createAdminUser() });
			ctx.params = { id: "cons_x" };

			await expect(handler(ctx)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
			expect(ctx.context.internalAdapter.updateUser).not.toHaveBeenCalled();
		});

		it("treats delete 404 as already-deleted and logs local link-clear failures", async () => {
			mockClient.getConsumer.mockResolvedValue(
				createMockConsumer({ id: "cons_race", external_id: "user-42" }),
			);
			mockClient.deleteConsumer.mockRejectedValue(
				mockApiError(404, { error: { code: "STREAM_ERROR", message: "not found" } }),
			);
			const handler = adminHandler(mockClient, "adminDeleteConsumer");
			const ctx = createMockContext({ user: createAdminUser() });
			ctx.context.internalAdapter.updateUser.mockRejectedValue(new Error("row not found"));
			ctx.params = { id: "cons_race" };

			await expect(handler(ctx)).resolves.toEqual({ deleted: true });
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("link clear failed"),
			);
		});
	});

	describe("SDK error translation", () => {
		const cases: Array<{
			name: string;
			method: keyof MockedStreamPayClient;
			endpoint: keyof ReturnType<ReturnType<typeof admin>>["endpoints"];
			setup: (ctx: MockCtx) => void;
			expectedErrorCode: string;
			rawCode: string;
			status: number;
		}> = [
			{
				name: "adminListPayments",
				method: "listPayments",
				endpoint: "adminListPayments",
				setup: () => {},
				expectedErrorCode: "UNKNOWN",
				rawCode: "STREAM_ERROR",
				status: 500,
			},
			{
				name: "adminGetPayment",
				method: "getPayment",
				endpoint: "adminGetPayment",
				setup: (ctx) => {
					ctx.params = { id: "pay_missing" };
				},
				expectedErrorCode: "NOT_FOUND",
				rawCode: "STREAM_ERROR",
				status: 404,
			},
			{
				name: "adminCreateSubscription",
				method: "createSubscription",
				endpoint: "adminCreateSubscription",
				setup: (ctx) => {
					ctx.body = {};
				},
				expectedErrorCode: "VALIDATION_ERROR",
				rawCode: "INVALID_PARAMETERS",
				status: 422,
			},
			{
				name: "adminListSubscriptions",
				method: "listSubscriptions",
				endpoint: "adminListSubscriptions",
				setup: () => {},
				expectedErrorCode: "UNKNOWN",
				rawCode: "STREAM_ERROR",
				status: 500,
			},
			{
				name: "adminGetSubscription",
				method: "getSubscription",
				endpoint: "adminGetSubscription",
				setup: (ctx) => {
					ctx.params = { id: "sub_missing" };
				},
				expectedErrorCode: "NOT_FOUND",
				rawCode: "STREAM_ERROR",
				status: 404,
			},
			{
				name: "adminListConsumers",
				method: "listConsumers",
				endpoint: "adminListConsumers",
				setup: () => {},
				expectedErrorCode: "UNKNOWN",
				rawCode: "STREAM_ERROR",
				status: 500,
			},
			{
				name: "adminGetConsumer",
				method: "getConsumer",
				endpoint: "adminGetConsumer",
				setup: (ctx) => {
					ctx.params = { id: "cons_missing" };
				},
				expectedErrorCode: "NOT_FOUND",
				rawCode: "STREAM_ERROR",
				status: 404,
			},
			{
				name: "adminUpdateConsumer",
				method: "updateConsumer",
				endpoint: "adminUpdateConsumer",
				setup: (ctx) => {
					ctx.params = { id: "cons_42" };
					ctx.body = { email: "x@y.com" };
				},
				expectedErrorCode: "VALIDATION_ERROR",
				rawCode: "INVALID_PARAMETERS",
				status: 422,
			},
			{
				name: "adminListInvoices",
				method: "listInvoices",
				endpoint: "adminListInvoices",
				setup: () => {},
				expectedErrorCode: "UNKNOWN",
				rawCode: "STREAM_ERROR",
				status: 500,
			},
			{
				name: "adminGetInvoice",
				method: "getInvoice",
				endpoint: "adminGetInvoice",
				setup: (ctx) => {
					ctx.params = { id: "inv_missing" };
				},
				expectedErrorCode: "NOT_FOUND",
				rawCode: "STREAM_ERROR",
				status: 404,
			},
			{
				name: "adminCreateProduct",
				method: "createProduct",
				endpoint: "adminCreateProduct",
				setup: (ctx) => {
					ctx.body = {};
				},
				expectedErrorCode: "VALIDATION_ERROR",
				rawCode: "INVALID_PARAMETERS",
				status: 422,
			},
			{
				name: "adminListProducts",
				method: "listProducts",
				endpoint: "adminListProducts",
				setup: () => {},
				expectedErrorCode: "UNKNOWN",
				rawCode: "STREAM_ERROR",
				status: 500,
			},
			{
				name: "adminGetProduct",
				method: "getProduct",
				endpoint: "adminGetProduct",
				setup: (ctx) => {
					ctx.params = { id: "prod_missing" };
				},
				expectedErrorCode: "NOT_FOUND",
				rawCode: "STREAM_ERROR",
				status: 404,
			},
			{
				name: "adminUpdateProduct",
				method: "updateProduct",
				endpoint: "adminUpdateProduct",
				setup: (ctx) => {
					ctx.params = { id: "prod_7" };
					ctx.body = {};
				},
				expectedErrorCode: "PRODUCT_LOCKED",
				rawCode: "PRODUCT_USED_IN_FINALIZED_INVOICE",
				status: 409,
			},
			{
				name: "adminDeleteProduct",
				method: "deleteProduct",
				endpoint: "adminDeleteProduct",
				setup: (ctx) => {
					ctx.params = { id: "prod_7" };
				},
				expectedErrorCode: "PRODUCT_LOCKED",
				rawCode: "PRODUCT_USED_IN_FINALIZED_INVOICE",
				status: 409,
			},
			{
				name: "adminCreateCoupon",
				method: "createCoupon",
				endpoint: "adminCreateCoupon",
				setup: (ctx) => {
					ctx.body = {};
				},
				expectedErrorCode: "VALIDATION_ERROR",
				rawCode: "INVALID_PARAMETERS",
				status: 422,
			},
			{
				name: "adminListCoupons",
				method: "listCoupons",
				endpoint: "adminListCoupons",
				setup: () => {},
				expectedErrorCode: "UNKNOWN",
				rawCode: "STREAM_ERROR",
				status: 500,
			},
			{
				name: "adminGetCoupon",
				method: "getCoupon",
				endpoint: "adminGetCoupon",
				setup: (ctx) => {
					ctx.params = { id: "coupon_missing" };
				},
				expectedErrorCode: "NOT_FOUND",
				rawCode: "STREAM_ERROR",
				status: 404,
			},
			{
				name: "adminUpdateCoupon",
				method: "updateCoupon",
				endpoint: "adminUpdateCoupon",
				setup: (ctx) => {
					ctx.params = { id: "coupon_7" };
					ctx.body = {};
				},
				expectedErrorCode: "COUPON_LOCKED",
				rawCode: "COUPON_USED_IN_FINALIZED_INVOICE",
				status: 409,
			},
			{
				name: "adminDeleteCoupon",
				method: "deleteCoupon",
				endpoint: "adminDeleteCoupon",
				setup: (ctx) => {
					ctx.params = { id: "coupon_7" };
				},
				expectedErrorCode: "COUPON_LOCKED",
				rawCode: "COUPON_USED_IN_FINALIZED_INVOICE",
				status: 409,
			},
			{
				name: "adminListPaymentLinks",
				method: "listPaymentLinks",
				endpoint: "adminListPaymentLinks",
				setup: () => {},
				expectedErrorCode: "UNKNOWN",
				rawCode: "STREAM_ERROR",
				status: 500,
			},
			{
				name: "adminGetPaymentLink",
				method: "getPaymentLink",
				endpoint: "adminGetPaymentLink",
				setup: (ctx) => {
					ctx.params = { id: "pl_missing" };
				},
				expectedErrorCode: "NOT_FOUND",
				rawCode: "STREAM_ERROR",
				status: 404,
			},
		];

		const STATUS_TO_APIERROR: Record<number, string> = {
			400: "BAD_REQUEST",
			401: "UNAUTHORIZED",
			403: "FORBIDDEN",
			404: "NOT_FOUND",
			409: "CONFLICT",
			422: "UNPROCESSABLE_ENTITY",
			429: "TOO_MANY_REQUESTS",
		};

		for (const { name, method, endpoint, setup, expectedErrorCode, rawCode, status } of cases) {
			it(`${name} maps SDK errors through toAPIError (status ${status} → ${STATUS_TO_APIERROR[status] ?? "INTERNAL_SERVER_ERROR"})`, async () => {
				const err = mockApiError(status, { error: { code: rawCode, message: "boom" } });
				Object.defineProperty(err, "requestId", {
					value: `req_${name}`,
					enumerable: true,
				});
				(
					mockClient[method] as unknown as { mockRejectedValue: (value: unknown) => void }
				).mockRejectedValue(err);
				const handler = adminHandler(mockClient, endpoint);
				const ctx = createMockContext({ user: createAdminUser() });
				setup(ctx);

				await expect(handler(ctx)).rejects.toMatchObject({
					code: STATUS_TO_APIERROR[status] ?? "INTERNAL_SERVER_ERROR",
					errorCode: expectedErrorCode,
				});
				expect(ctx.context.logger.error.mock.calls[0]?.[0] ?? "").toContain(
					`request_id=req_${name}`,
				);
			});
		}
	});
});
