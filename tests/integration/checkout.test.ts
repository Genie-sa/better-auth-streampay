import type { User } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";
import { checkout } from "../../src/plugins/checkout";
import type { StreamPayProduct } from "../../src/types";
import { callAuthEndpoint, createStreamPayTestInstance } from "../utils/auth-instance";
import { mockApiError } from "../utils/helpers";
import { createMockConsumer, createMockPaymentLink } from "../utils/mocks";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_PRODUCT_ID = "22222222-2222-4222-8222-222222222222";

async function readJson(response: Response): Promise<unknown> {
	return response.json();
}

describe("checkout integration", () => {
	it("creates a guest checkout through the real Better Auth route", async () => {
		const { auth, streamPayClient } = await createStreamPayTestInstance({
			use: [checkout()],
		});
		streamPayClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		streamPayClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_mocked");

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			body: {
				products: PRODUCT_ID,
				referenceId: "org_42",
				metadata: { tier: "gold" },
				couponIds: ["33333333-3333-4333-8333-333333333333"],
				successUrl: "/success",
				failureUrl: "/failed",
				redirect: false,
			},
		});

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({
			url: "https://pay.streampay.sa/pl_mocked",
			id: "pl_mocked",
			redirect: false,
		});
		expect(streamPayClient.createPaymentLink).toHaveBeenCalledWith(
			expect.objectContaining({
				items: [{ product_id: PRODUCT_ID, quantity: 1, allow_custom_quantity: false }],
				custom_metadata: { referenceId: "org_42", tier: "gold" },
				coupons: ["33333333-3333-4333-8333-333333333333"],
				success_redirect_url: "http://localhost:3000/success",
				failure_redirect_url: "http://localhost:3000/failed",
			}),
		);
	});

	it("runs server-resolved checkout and persistence through the real Better Auth route", async () => {
		const onCheckoutCreated = vi.fn();
		const { auth, streamPayClient } = await createStreamPayTestInstance({
			use: [
				checkout({
					resolveCheckout: () => ({
						products: [{ productId: SECOND_PRODUCT_ID, quantity: 2 }],
						name: "Resolved order",
						maxNumberOfPayments: 1,
						metadata: { flow: "store" },
					}),
					onCheckoutCreated,
				}),
			],
		});
		streamPayClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		streamPayClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_mocked");

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			body: { referenceId: "order-42", redirect: false },
		});

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({
			url: "https://pay.streampay.sa/pl_mocked",
			id: "pl_mocked",
			redirect: false,
		});
		expect(streamPayClient.createPaymentLink).toHaveBeenCalledWith({
			name: "Resolved order",
			description: null,
			currency: "SAR",
			items: [
				{
					product_id: SECOND_PRODUCT_ID,
					quantity: 2,
					allow_custom_quantity: false,
				},
			],
			max_number_of_payments: 1,
			custom_metadata: { flow: "store", referenceId: "order-42" },
		});
		expect(onCheckoutCreated).toHaveBeenCalledWith(
			expect.objectContaining({
				referenceId: "order-42",
				paymentLinkId: "pl_mocked",
			}),
			expect.anything(),
		);
	});

	it("returns 500 without calling StreamPay when resolved checkout fields are invalid", async () => {
		const { auth, streamPayClient } = await createStreamPayTestInstance({
			use: [
				checkout({
					resolveCheckout: () => ({
						products: [{ productId: "not-a-uuid" }],
					}),
				}),
			],
		});

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			body: { referenceId: "order-invalid", redirect: false },
		});

		expect(response.status).toBe(500);
		const responseBody = await readJson(response);
		expect(responseBody).toMatchObject({
			message: "Checkout resolution produced invalid parameters.",
		});
		expect(JSON.stringify(responseBody)).not.toContain("not-a-uuid");
		expect(streamPayClient.createPaymentLink).not.toHaveBeenCalled();
	});

	it("deactivates checkout and preserves callback API errors through the real route", async () => {
		const { auth, streamPayClient } = await createStreamPayTestInstance({
			use: [
				checkout({
					onCheckoutCreated: () => {
						throw new APIError("CONFLICT", {
							code: "ORDER_WRITE_CONFLICT",
							message: "Order already exists.",
						});
					},
				}),
			],
		});
		streamPayClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		streamPayClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_mocked");

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			body: { products: PRODUCT_ID },
		});

		expect(response.status).toBe(409);
		expect(await readJson(response)).toMatchObject({
			code: "ORDER_WRITE_CONFLICT",
			message: "Order already exists.",
		});
		expect(streamPayClient.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_mocked", {
			status: "INACTIVE",
		});
	});

	it("resolves the authenticated user for bearer-token checkout", async () => {
		const resolveCheckout = vi.fn(({ user }: { user: { id: string } | null }) => {
			if (!user) throw new Error("expected an authenticated user");
			return { products: [{ productId: PRODUCT_ID }] };
		});
		const { auth, client, streamPayClient } = await createStreamPayTestInstance({
			additionalPlugins: [bearer()],
			use: [
				checkout({
					authenticatedUsersOnly: true,
					resolveCheckout,
				}),
			],
		});
		streamPayClient.listConsumers.mockResolvedValue({ data: [], pagination: {} });
		streamPayClient.createConsumer.mockResolvedValue(createMockConsumer({ id: "cons_bearer" }));
		streamPayClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		streamPayClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_mocked");

		const credentials = {
			email: "checkout-bearer@example.com",
			password: "password123",
			name: "Bearer User",
		};
		const signUp = await client.signUp.email(credentials, { throw: true });
		let bearerToken: string | null = null;
		await client.signIn.email(credentials, {
			throw: true,
			onSuccess: ({ response }) => {
				bearerToken = response.headers.get("set-auth-token");
			},
		});
		if (!bearerToken) throw new Error("bearer plugin did not expose a session token");

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			headers: { authorization: `Bearer ${bearerToken}` },
			body: { referenceId: "bearer-order", redirect: false },
		});

		expect(response.status).toBe(200);
		expect(resolveCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ id: signUp.user.id, email: credentials.email }),
			}),
			expect.anything(),
		);
	});

	it("lazy-creates and persists a StreamPay consumer for authenticated checkout", async () => {
		const { auth, client, sessionSetter, streamPayClient } = await createStreamPayTestInstance({
			use: [checkout()],
		});
		streamPayClient.listConsumers.mockResolvedValue({ data: [], pagination: {} });
		streamPayClient.createConsumer.mockResolvedValue(createMockConsumer({ id: "cons_lazy" }));
		streamPayClient.getConsumer.mockResolvedValue(createMockConsumer({ id: "cons_lazy" }));
		streamPayClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		streamPayClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_mocked");

		const userInput = {
			email: "checkout-auth@example.com",
			password: "password123",
			name: "Checkout User",
		};
		const signUp = await client.signUp.email(userInput, { throw: true });
		const headers = new Headers();
		await client.signIn.email(userInput, {
			throw: true,
			onSuccess: sessionSetter(headers),
		});

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			headers,
			body: { products: PRODUCT_ID },
		});

		expect(response.status).toBe(200);
		expect(streamPayClient.createConsumer).toHaveBeenCalledWith(
			expect.objectContaining({
				email: userInput.email,
				name: userInput.name,
				external_id: signUp.user.id,
			}),
		);
		expect(streamPayClient.createPaymentLink).toHaveBeenCalledWith(
			expect.objectContaining({ organization_consumer_id: "cons_lazy" }),
		);

		const ctx = await auth.$context;
		const storedUser = await ctx.adapter.findOne<User & { streampayConsumerId?: string | null }>({
			model: "user",
			where: [{ field: "id", value: signUp.user.id }],
		});
		expect(storedUser?.streampayConsumerId).toBe("cons_lazy");
	});

	it("reuses an existing linked consumer without creating another one", async () => {
		const { auth, client, sessionSetter, streamPayClient } = await createStreamPayTestInstance({
			use: [checkout()],
			streamPayOptions: { createConsumerOnSignUp: true },
		});
		streamPayClient.listConsumers.mockResolvedValue({ data: [], pagination: {} });
		streamPayClient.createConsumer.mockResolvedValue(createMockConsumer({ id: "cons_existing" }));
		streamPayClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		streamPayClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_mocked");

		const userInput = {
			email: "checkout-existing@example.com",
			password: "password123",
			name: "Existing Consumer",
		};
		await client.signUp.email(userInput, { throw: true });
		streamPayClient.createConsumer.mockClear();

		const headers = new Headers();
		await client.signIn.email(userInput, {
			throw: true,
			onSuccess: sessionSetter(headers),
		});

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			headers,
			body: { products: PRODUCT_ID },
		});

		expect(response.status).toBe(200);
		expect(streamPayClient.createConsumer).not.toHaveBeenCalled();
		expect(streamPayClient.createPaymentLink).toHaveBeenCalledWith(
			expect.objectContaining({ organization_consumer_id: "cons_existing" }),
		);
	});

	it("rejects a recovered consumer owned by another local user", async () => {
		const { auth, client, sessionSetter, streamPayClient } = await createStreamPayTestInstance({
			use: [checkout()],
		});
		const owner = await client.signUp.email(
			{
				email: "checkout-owner@example.com",
				password: "password123",
				name: "Checkout Owner",
			},
			{ throw: true },
		);
		const callerCredentials = {
			email: "checkout-caller@example.com",
			password: "password123",
			name: "Checkout Caller",
		};
		const caller = await client.signUp.email(callerCredentials, { throw: true });
		const ctx = await auth.$context;
		await ctx.adapter.update({
			model: "user",
			where: [{ field: "id", value: owner.user.id }],
			update: { streampayConsumerId: "cons_shared" },
		});
		streamPayClient.listConsumers.mockResolvedValue({
			data: [
				createMockConsumer({
					id: "cons_shared",
					external_id: caller.user.id,
					email: callerCredentials.email,
				}),
			],
			pagination: {},
		});
		const headers = new Headers();
		await client.signIn.email(callerCredentials, {
			throw: true,
			onSuccess: sessionSetter(headers),
		});

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			headers,
			body: { products: PRODUCT_ID },
		});

		expect(response.status).toBe(409);
		expect(await readJson(response)).toMatchObject({
			code: "STREAMPAY_CONSUMER_LINK_CONFLICT",
		});
		expect(streamPayClient.createPaymentLink).not.toHaveBeenCalled();
	});

	it("enforces authenticatedUsersOnly before calling StreamPay", async () => {
		const { auth, streamPayClient } = await createStreamPayTestInstance({
			use: [checkout({ authenticatedUsersOnly: true })],
		});

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			body: { products: PRODUCT_ID },
		});

		expect(response.status).toBe(401);
		expect(streamPayClient.createPaymentLink).not.toHaveBeenCalled();
		expect(await readJson(response)).toMatchObject({
			message: "You must be logged in to checkout.",
		});
	});

	it("resolves product slugs and rejects unknown slugs", async () => {
		const products: StreamPayProduct[] = [
			{ productId: PRODUCT_ID, slug: "pro" },
			{ productId: SECOND_PRODUCT_ID, slug: "team" },
		];
		const { auth, streamPayClient } = await createStreamPayTestInstance({
			use: [checkout({ products })],
		});
		streamPayClient.createPaymentLink.mockResolvedValue(createMockPaymentLink());
		streamPayClient.getPaymentUrl.mockReturnValue("https://pay.streampay.sa/pl_mocked");

		const success = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			body: { slug: "team" },
		});
		expect(success.status).toBe(200);
		expect(streamPayClient.createPaymentLink).toHaveBeenCalledWith(
			expect.objectContaining({
				items: [{ product_id: SECOND_PRODUCT_ID, quantity: 1, allow_custom_quantity: false }],
			}),
		);

		const failure = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			body: { slug: "ghost" },
		});
		expect(failure.status).toBe(400);
		expect(await readJson(failure)).toMatchObject({
			message: "Unknown product slug: ghost",
		});
	});

	it("maps StreamPay checkout failures to the documented API error", async () => {
		const { auth, streamPayClient } = await createStreamPayTestInstance({
			use: [checkout()],
		});
		streamPayClient.createPaymentLink.mockRejectedValue(
			mockApiError(422, {
				error: {
					code: "VALIDATION_ERROR",
					message: "Invalid product",
					additional_info: "Product is not sellable",
				},
			}),
		);

		const response = await callAuthEndpoint(auth, "/checkout", {
			method: "POST",
			body: { products: PRODUCT_ID },
		});

		expect(response.status).toBe(422);
		expect(await readJson(response)).toMatchObject({
			message: "StreamPay checkout creation failed.",
			code: "VALIDATION_ERROR",
		});
	});
});
