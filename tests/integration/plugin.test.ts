import type { CouponCreate, ProductCreate, SubscriptionCancel } from "@streamsdk/typescript";
import type { User } from "better-auth";
import { organization } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { describe, expect, expectTypeOf, it } from "vitest";
import { streampayClient } from "../../src/client";
import { $ERROR_CODES } from "../../src/error-codes";
import { admin as streampayAdmin } from "../../src/plugins/admin";
import { checkout } from "../../src/plugins/checkout";
import { subscriptions } from "../../src/plugins/subscriptions";
import { streampay } from "../../src/streampay";
import { callAuthEndpoint, createStreamPayTestInstance } from "../utils/auth-instance";
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

	describe("server-only billing endpoints", () => {
		it("exposes both methods on auth.api while the real router serves no route for them", async () => {
			const { auth } = await createStreamPayTestInstance({
				use: [
					subscriptions({
						plans: [
							{
								name: "pro",
								productId: "prod_pro",
								priceInSmallestUnit: 9900,
								billingInterval: "MONTH",
							},
						],
					}),
					checkout(),
				],
			});

			expect(typeof auth.api.upgradeSubscriptionForReference).toBe("function");
			expect(typeof auth.api.checkoutForReference).toBe("function");

			for (const path of [
				"/subscription/upgrade-for-reference",
				"/subscription/upgradeSubscriptionForReference",
				"/upgrade-subscription-for-reference",
				"/checkout-for-reference",
				"/checkoutForReference",
			]) {
				const response = await callAuthEndpoint(auth, path, {
					method: "POST",
					body: { plan: "pro", referenceId: "user-1" },
				});
				expect(response.status).toBe(404);
			}
		});
	});

	describe("organization billing configuration", () => {
		it("keeps the schema working with the organization plugin's default table name", async () => {
			const { auth } = await getTestInstance({
				plugins: [
					organization(),
					streampay({
						client: createMockStreamPayClient(),
						organization: { enabled: true },
						use: [],
					}),
				],
			});
			const ctx = await auth.$context;
			expect(ctx.tables.organization?.modelName).toBe("organization");
			expect(ctx.tables.organization?.fields.streampayConsumerId).toMatchObject({
				unique: true,
			});
			expect(ctx.tables.organization?.fields.name).toBeDefined();
		});

		it("keeps a custom organization table name when modelName is configured", async () => {
			const { auth } = await getTestInstance({
				plugins: [
					organization({ schema: { organization: { modelName: "orgs" } } }),
					streampay({
						client: createMockStreamPayClient(),
						organization: { enabled: true, modelName: "orgs" },
						use: [],
					}),
				],
			});
			const ctx = await auth.$context;
			expect(ctx.tables.organization?.modelName).toBe("orgs");
			expect(ctx.tables.organization?.fields.streampayConsumerId).toMatchObject({
				unique: true,
			});
		});

		it("fails fast when the organization plugin uses a custom table name the billing options do not", async () => {
			await expect(
				(async () => {
					const { auth } = await getTestInstance({
						plugins: [
							organization({ schema: { organization: { modelName: "orgs" } } }),
							streampay({
								client: createMockStreamPayClient(),
								organization: { enabled: true },
								use: [],
							}),
						],
					});
					await auth.$context;
				})(),
			).rejects.toThrow(/organization\.modelName/);
		});

		it("fails fast when organization billing is enabled without the organization plugin", async () => {
			await expect(
				(async () => {
					const { auth } = await getTestInstance({
						plugins: [
							streampay({
								client: createMockStreamPayClient(),
								organization: { enabled: true },
								use: [],
							}),
						],
					});
					await auth.$context;
				})(),
			).rejects.toThrow(/organization plugin/);
		});
	});
});
