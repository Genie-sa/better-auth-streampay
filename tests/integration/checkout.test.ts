import type { User } from "better-auth";
import { describe, expect, it } from "vitest";
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

		// Plugin propagates the upstream HTTP status (422 here) instead of
		// always collapsing to 500 — see toAPIError + statusToAPIErrorStatus.
		expect(response.status).toBe(422);
		expect(await readJson(response)).toMatchObject({
			message: "StreamPay checkout creation failed.",
			code: "VALIDATION_ERROR",
		});
	});
});
