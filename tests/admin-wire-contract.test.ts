import StreamSDK from "@streamsdk/typescript";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

vi.mock("better-auth/api", async () => {
	const { MockAPIError } = await import("./utils/better-auth-mock");
	return {
		APIError: MockAPIError,
		sessionMiddleware: vi.fn(),
		createAuthEndpoint: (path: string, config: unknown, handler: unknown) => ({
			path,
			config,
			handler,
		}),
	};
});

import { admin } from "../src/plugins/admin";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions } from "./utils/helpers";
import { createMockContext } from "./utils/mocks";

const endpoints = [
	["adminListPayments", "payments"],
	["adminListSubscriptions", "subscriptions"],
	["adminListConsumers", "consumers"],
	["adminListInvoices", "invoices"],
	["adminListProducts", "products"],
	["adminListCoupons", "coupons"],
	["adminListPaymentLinks", "payment_links"],
] as const;
const invoiceId = "3152a5eb-485c-48d8-aae9-14d9c0b2f934";

describe("admin API contracts through the published Stream SDK", () => {
	it.each(
		endpoints,
	)("%s forwards requested size using the documented provider limit", async (endpoint, resource) => {
		let request: URL | undefined;
		const sdk = StreamSDK.init("test-key", {
			baseUrl: "https://stream.example",
			fetchFn: async (input) => {
				request = new URL(String(input));
				const limit = Number(request.searchParams.get("limit") ?? 10);
				return Response.json({
					data: Array.from({ length: limit }, (_, index) => ({ id: `item-${index}` })),
				});
			},
		});
		const handler = unwrapHandler<{ data: unknown[] }>(
			admin({ isAdmin: () => true })(createTestStreamPayOptions({ client: sdk })).endpoints[
				endpoint
			],
		);
		const result = await handler(
			createMockContext({
				query: {
					page: 2,
					size: 1,
					invoice_id: invoiceId,
					search_term: "customer",
					statuses: "CANCELED",
				},
			}),
		);
		expect(result.data).toHaveLength(1);
		expect(request?.pathname).toBe(`/api/v2/${resource}`);
		expect(request?.searchParams.get("limit")).toBe("1");
		expect(request?.searchParams.get("page")).toBe("2");
		expect(request?.searchParams.has("size")).toBe(false);
		expect(request?.searchParams.get("invoice_id")).toBe(
			resource === "payments" ? invoiceId : null,
		);
		expect(request?.searchParams.get("search_term")).toBe(
			resource === "consumers" ? "customer" : null,
		);
		expect(request?.searchParams.has("statuses")).toBe(false);
	});

	it("rejects invalid refund amounts and options at the request boundary", () => {
		const sdk = StreamSDK.init("test-key");
		const route = admin()(createTestStreamPayOptions({ client: sdk })).endpoints
			.adminRefundPayment as unknown as { config: { body: z.ZodType } };
		const body = route.config.body;
		for (const amount of ["0.00", "-1.00", "garbage", 0, Number.POSITIVE_INFINITY]) {
			expect(body.safeParse({ refund_reason: "OTHER", amount }).success).toBe(false);
		}
		expect(
			body.safeParse({ refund_reason: "OTHER", payment_is_part_of_related_set: "true" }).success,
		).toBe(false);
		expect(body.safeParse({ refund_reason: "OTHER", amount: "5.50" }).success).toBe(true);
		expect(body.safeParse({ refund_reason: "OTHER" }).success).toBe(true);
	});

	it.each(endpoints)("%s rejects unsafe page integers at the request boundary", (endpoint) => {
		const sdk = StreamSDK.init("test-key");
		const route = admin()(createTestStreamPayOptions({ client: sdk })).endpoints[
			endpoint
		] as unknown as { config: { query: z.ZodType } };
		expect(route.config.query.safeParse({ page: "9007199254740992", size: "1" }).success).toBe(
			false,
		);
		expect(route.config.query.safeParse({ page: "2", size: "1" }).success).toBe(true);
	});
});
