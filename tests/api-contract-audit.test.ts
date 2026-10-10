import { createAuthClient } from "better-auth/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("better-auth/api", async () => {
	const { MockAPIError } = await import("./utils/better-auth-mock");
	return {
		APIError: MockAPIError,
		getSessionFromCtx: vi.fn().mockResolvedValue(null),
		createAuthEndpoint: (path: string, config: unknown, handler: unknown) => ({
			path,
			config,
			handler,
		}),
	};
});

import { streampayClient } from "../src/client";
import { onBeforeUserCreate } from "../src/hooks/consumer";
import { CheckoutBody } from "../src/plugins/checkout";
import { ensureConsumerForUser } from "../src/utils/ensure-consumer";
import { createTestStreamPayOptions } from "./utils/helpers";
import {
	createMockConsumer,
	createMockConsumerList,
	createMockContext,
	createMockStreamPayClient,
	createMockUser,
} from "./utils/mocks";

// resolveCheckout can derive the complete cart from the session without any client fields.
describe("server-resolved checkout client contract", () => {
	it("uses POST when checkout is called without client-supplied payment fields", async () => {
		const requests: Request[] = [];
		const client = createAuthClient({
			baseURL: "https://merchant.example",
			plugins: [streampayClient()],
			fetchOptions: {
				customFetchImpl: async (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					return Response.json(
						request.method === "POST"
							? { id: "checkout", url: "https://pay.streampay.sa/test", redirect: false }
							: { message: "Method not allowed" },
						{ status: request.method === "POST" ? 200 : 405 },
					);
				},
			},
		});

		const result = await client.checkout();

		expect(requests[0]?.url).toBe("https://merchant.example/api/auth/checkout");
		expect(requests[0]?.method).toBe("POST");
		expect(result.error).toBeNull();
		expect(result.data).toMatchObject({ id: "checkout" });
	});
});

describe("consumer identity fields remain authoritative", () => {
	it.each([
		"signup",
		"lazy",
	] as const)("ignores reserved callback overrides during %s provisioning", async (flow) => {
		const sdk = createMockStreamPayClient();
		sdk.listConsumers.mockResolvedValue(createMockConsumerList());
		sdk.createConsumer.mockResolvedValue(createMockConsumer({ id: "new-consumer" }));
		const user = createMockUser({
			id: "owned-user",
			name: "Owner",
			email: "owner@example.com",
			streampayConsumerId: null,
		});
		const ctx = createMockContext({ user });
		// Wider callback return types and JavaScript callers can include reserved fields.
		const extras = {
			name: "Someone else",
			email: "other@example.com",
			external_id: "other-user",
			phone_number: "+966501234567",
		};
		const options = createTestStreamPayOptions({
			client: sdk,
			createConsumerOnSignUp: true,
			getConsumerCreateParams: () => extras,
		});

		if (flow === "signup") await onBeforeUserCreate(options)(user, ctx);
		else await ensureConsumerForUser(options, ctx, user);

		expect(sdk.createConsumer).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Owner",
				email: "owner@example.com",
				phone_number: "+966501234567",
			}),
		);
		const payload = sdk.createConsumer.mock.calls[0]?.[0];
		if (flow === "lazy") expect(payload?.external_id).toBe("owned-user");
		else expect(payload).not.toHaveProperty("external_id");
	});
});

describe("Stream documented datetime input", () => {
	it("accepts timezone-offset checkout expiry dates", () => {
		const parsed = CheckoutBody.safeParse({
			products: "11111111-1111-4111-8111-111111111111",
			validUntil: "2030-01-02T03:04:05+03:00",
		});

		expect(parsed.success).toBe(true);
	});
});

describe("checkout integer precision", () => {
	it.each([
		"quantity",
		"maxNumberOfPayments",
	] as const)("rejects unsafe %s integers on every supported Zod version", (field) => {
		const product = "11111111-1111-4111-8111-111111111111";
		const body =
			field === "quantity"
				? { products: [{ productId: product, quantity: Number.MAX_SAFE_INTEGER + 1 }] }
				: { products: product, maxNumberOfPayments: Number.MAX_SAFE_INTEGER + 1 };

		expect(CheckoutBody.safeParse(body).success).toBe(false);
	});
});

describe("checkout metadata JSON fidelity", () => {
	it.each([
		Infinity,
		-Infinity,
	])("rejects metadata number %s instead of serializing it as null", (value) => {
		expect(
			CheckoutBody.safeParse({
				products: "11111111-1111-4111-8111-111111111111",
				metadata: { value },
			}).success,
		).toBe(false);
	});
});
