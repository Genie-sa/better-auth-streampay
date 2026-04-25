import type { User } from "better-auth";
import { getTestInstance } from "better-auth/test";
import { describe, expect, expectTypeOf, it } from "vitest";
import { streampayClient } from "../../src/client";
import { $ERROR_CODES } from "../../src/error-codes";
import { checkout } from "../../src/plugins/checkout";
import { streampay } from "../../src/streampay";
import { version } from "../../src/version";
import { createStreamPayTestInstance } from "../utils/auth-instance";
import { createMockConsumer, createMockStreamPayClient } from "../utils/mocks";

describe("streampay plugin integration", () => {
	it("exposes plugin metadata and callable Better Auth API endpoints", async () => {
		const { auth } = await createStreamPayTestInstance({
			use: [checkout()],
		});

		expect(auth.options.plugins?.some((plugin) => plugin.id === "streampay")).toBe(true);
		expect(auth.options.plugins?.find((plugin) => plugin.id === "streampay")).toMatchObject({
			version,
		});
		expect(auth.api.checkout).toBeTypeOf("function");
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
