import type { CouponCreate, ProductCreate, SubscriptionCancel } from "@streamsdk/typescript";
import type { User } from "better-auth";
import { getTestInstance } from "better-auth/test";
import { describe, expect, expectTypeOf, it } from "vitest";
import { streampayClient } from "../../src/client";
import { $ERROR_CODES } from "../../src/error-codes";
import { admin as streampayAdmin } from "../../src/plugins/admin";
import { streampay } from "../../src/streampay";
import { createStreamPayTestInstance } from "../utils/auth-instance";
import { createMockConsumer, createMockStreamPayClient } from "../utils/mocks";

describe("streampay plugin integration", () => {
	it("preserves SDK request body types through Better Auth inference", async () => {
		const { auth } = await getTestInstance({
			plugins: [
				streampay({
					client: createMockStreamPayClient(),
					use: [streampayAdmin({ isAdmin: () => true })],
				}),
			],
		});

		type ProductBody = NonNullable<Parameters<typeof auth.api.adminCreateProduct>[0]>["body"];
		type CouponBody = NonNullable<Parameters<typeof auth.api.adminCreateCoupon>[0]>["body"];
		type CancelBody = NonNullable<Parameters<typeof auth.api.adminCancelSubscription>[0]>["body"];
		expectTypeOf<ProductBody>().toEqualTypeOf<ProductCreate>();
		expectTypeOf<CouponBody>().toEqualTypeOf<CouponCreate>();
		expectTypeOf<CancelBody>().toEqualTypeOf<SubscriptionCancel>();
	});

	it("infers the user schema field added by the plugin", async () => {
		const { auth } = await getTestInstance({
			plugins: [
				streampay({
					client: createMockStreamPayClient(),
					use: [],
				}),
			],
		});

		expectTypeOf<(typeof auth)["$Infer"]["Session"]["user"]["streampayConsumerId"]>().toEqualTypeOf<
			string | null | undefined
		>();
		expectTypeOf<User & { streampayConsumerId?: string | null }>().toMatchTypeOf<
			(typeof auth)["$Infer"]["Session"]["user"]
		>();
	});

	it("declares StreamPay consumer ids unique at the schema boundary", () => {
		const plugin = streampay({ client: createMockStreamPayClient(), use: [] });

		expect(plugin.schema.user.fields.streampayConsumerId).toMatchObject({
			type: "string",
			unique: true,
		});
	});

	it("creates a StreamPay consumer on signup when eager mode is enabled", async () => {
		const { auth, client, streamPayClient } = await createStreamPayTestInstance({
			streamPayOptions: { createConsumerOnSignUp: true },
		});
		streamPayClient.listConsumers.mockResolvedValue({ data: [], pagination: {} });
		streamPayClient.createConsumer.mockResolvedValue(createMockConsumer({ id: "cons_signup" }));

		const user = await client.signUp.email(
			{
				email: "signup-hook@example.com",
				password: "password123",
				name: "Signup Hook",
			},
			{ throw: true },
		);

		expect(streamPayClient.createConsumer).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "signup-hook@example.com",
				name: "Signup Hook",
			}),
		);

		const ctx = await auth.$context;
		const storedUser = await ctx.adapter.findOne<User & { streampayConsumerId?: string | null }>({
			model: "user",
			where: [{ field: "id", value: user.user.id }],
		});
		expect(storedUser?.streampayConsumerId).toBe("cons_signup");
	});

	it("does not create a StreamPay consumer on signup by default", async () => {
		const { client, streamPayClient } = await createStreamPayTestInstance();

		await client.signUp.email(
			{
				email: "default-signup@example.com",
				password: "password123",
				name: "Default Signup",
			},
			{ throw: true },
		);

		expect(streamPayClient.createConsumer).not.toHaveBeenCalled();
	});

	it("keeps the client error-code surface available without server imports", async () => {
		await createStreamPayTestInstance();
		const clientPlugin = streampayClient();

		expect(clientPlugin).toBeDefined();
		expect($ERROR_CODES.CONSUMER_DUPLICATE.code).toBe("CONSUMER_DUPLICATE");
		expect(clientPlugin.$ERROR_CODES.CONSUMER_DUPLICATE.code).toBe("CONSUMER_DUPLICATE");
	});
});
