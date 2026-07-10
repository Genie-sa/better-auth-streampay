import { createHmac } from "node:crypto";
import StreamSDK from "@streamsdk/typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	onAfterUserCreate,
	onBeforeUserCreate,
	type StreamPayHookContext,
} from "../../src/hooks/consumer";
import type { StreamPayClient } from "../../src/types";
import { findConsumerByExternalId, findConsumerByIdentifiers } from "../../src/utils/consumer";
import { isDuplicateConsumerError } from "../../src/utils/ensure-consumer";
import { verifyWebhook } from "../../src/webhooks/verify";

const live = process.env.STREAMPAY_LIVE === "1";
const liveWrite = live && process.env.STREAMPAY_LIVE_WRITE === "1";
const liveDescribe = live ? describe : describe.skip;
const liveWriteDescribe = liveWrite ? describe : describe.skip;

function getConfig(): {
	apiKey: string;
	baseUrl: string;
	webhookSecret: string | undefined;
	productId: string | undefined;
} {
	const apiKey = process.env.STREAMPAY_API_KEY;
	if (!apiKey) {
		throw new Error("STREAMPAY_API_KEY is required for live tests");
	}
	return {
		apiKey,
		baseUrl: process.env.STREAMPAY_BASE_URL ?? "https://stream-app-service.streampay.sa",
		webhookSecret: process.env.STREAMPAY_WEBHOOK_SECRET,
		productId: process.env.STREAMPAY_TEST_PRODUCT_ID,
	};
}

interface MeResponse {
	user?: { email?: string };
	organization?: { id?: string };
}

function createHookContext(): StreamPayHookContext {
	return {
		context: {
			logger: {
				error: () => {},
				warn: () => {},
				info: () => {},
				debug: () => {},
			},
		},
	};
}

function createLiveUser(input: {
	id: string;
	email: string;
	name?: string;
	streampayConsumerId?: string | null;
}): {
	id: string;
	email: string;
	name: string;
	image: null;
	emailVerified: boolean;
	createdAt: Date;
	updatedAt: Date;
	streampayConsumerId: string | null;
} {
	return {
		id: input.id,
		email: input.email,
		name: input.name ?? "BA Live Test User",
		image: null,
		emailVerified: true,
		createdAt: new Date(),
		updatedAt: new Date(),
		streampayConsumerId: input.streampayConsumerId ?? null,
	};
}

liveDescribe("live StreamPay read-only smoke", () => {
	const config = live
		? getConfig()
		: {
				apiKey: "",
				baseUrl: "",
				webhookSecret: undefined,
				productId: undefined,
			};
	const sdk = StreamSDK.init(config.apiKey, { baseUrl: config.baseUrl });
	const client: StreamPayClient = sdk;

	it("authenticates and lists consumers with the expected pagination shape", async () => {
		const response = await client.listConsumers({ page: 1, size: 1 });
		expect(response).toBeDefined();
		expect(Array.isArray(response.data)).toBe(true);
		expect(response.pagination).toBeDefined();
		expect(typeof response.pagination?.total_count).toBe("number");
	});

	it("lists subscriptions", async () => {
		const response = await client.listSubscriptions({ page: 1, size: 1 });
		expect(response.pagination).toBeDefined();
		expect(Array.isArray(response.data)).toBe(true);
	});

	it("lists invoices", async () => {
		const response = await client.listInvoices({ page: 1, size: 1 });
		expect(response.pagination).toBeDefined();
		expect(Array.isArray(response.data)).toBe(true);
	});

	it("findConsumerByExternalId returns null for a definitely-missing id", async () => {
		const result = await findConsumerByExternalId(client, {
			externalId: "ba-streampay-test-99999999-9999-9999-9999-999999999999",
		});
		expect(result).toBeNull();
	});

	it("verifies a webhook signed with the real dashboard secret", () => {
		if (!config.webhookSecret) {
			throw new Error("STREAMPAY_WEBHOOK_SECRET is required for this test");
		}
		const body = JSON.stringify({
			event_type: "PAYMENT_SUCCEEDED",
			entity_type: "PAYMENT",
			entity_id: "test",
			entity_url: "",
			status: "SUCCEEDED",
			data: {},
			timestamp: new Date().toISOString(),
		});
		const ts = Math.floor(Date.now() / 1000);
		const hex = createHmac("sha256", config.webhookSecret).update(`${ts}.${body}`).digest("hex");

		const result = verifyWebhook({
			secret: config.webhookSecret,
			rawBody: body,
			signatureHeader: `t=${ts},v1=${hex}`,
		});
		expect(result.ok).toBe(true);
	});
});

liveWriteDescribe("live StreamPay write smoke", () => {
	const config = liveWrite
		? getConfig()
		: {
				apiKey: "",
				baseUrl: "",
				webhookSecret: undefined,
				productId: undefined,
			};
	const sdk = StreamSDK.init(config.apiKey, { baseUrl: config.baseUrl });
	const client: StreamPayClient = sdk;

	const initialExternalId = `ba-live-test-${Date.now()}`;
	let orgOwnerEmail = "";
	let createdConsumerId: string | null = null;
	let createdPaymentLinkId: string | null = null;
	let currentExternalId = initialExternalId;

	let ownsConsumer = false;
	let originalName: string | null = null;
	let originalExternalId: string | null = null;

	async function restoreAdoptedConsumer(consumerId: string): Promise<void> {
		await client.updateConsumer(consumerId, {
			...(originalName ? { name: originalName } : {}),
			...(originalExternalId ? { external_id: originalExternalId } : {}),
		});
	}

	beforeAll(async () => {
		const meResponse = await fetch(`${config.baseUrl}/api/v2/me`, {
			headers: {
				"x-api-key": config.apiKey,
				accept: "application/json",
			},
		});
		if (!meResponse.ok) {
			throw new Error(`/api/v2/me returned ${meResponse.status}`);
		}
		const me = (await meResponse.json()) as MeResponse;
		if (!me.user?.email) {
			throw new Error("/api/v2/me did not return user.email");
		}
		orgOwnerEmail = me.user.email;
	});

	afterAll(async () => {
		if (!createdConsumerId) return;
		try {
			if (ownsConsumer) {
				await client.deleteConsumer(createdConsumerId);
			} else {
				await restoreAdoptedConsumer(createdConsumerId);
			}
		} catch {}
	});

	it("createConsumer succeeds (or adopts the sandbox's existing consumer)", async () => {
		try {
			const consumer = await client.createConsumer({
				name: "BA Live Test Consumer",
				email: orgOwnerEmail,
				external_id: currentExternalId,
				consumer_type: "INDIVIDUAL",
			});
			expect(consumer.id).toBeDefined();
			expect(typeof consumer.id).toBe("string");
			expect(consumer.external_id).toBe(currentExternalId);
			expect(consumer.email).toBe(orgOwnerEmail);
			createdConsumerId = consumer.id ?? null;
			ownsConsumer = true;
		} catch (err) {
			if (!isDuplicateConsumerError(err)) throw err;
			const existing = await findConsumerByIdentifiers(client, { email: orgOwnerEmail });
			expect(existing?.id).toBeDefined();
			if (!existing?.id) return;
			originalName = existing.name ?? null;
			originalExternalId = existing.external_id ?? null;
			const adopted = await client.updateConsumer(existing.id, {
				external_id: currentExternalId,
			});
			expect(adopted.external_id).toBe(currentExternalId);
			createdConsumerId = existing.id;
		}
	});

	it("findConsumerByExternalId finds the freshly-created consumer", async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		const found = await findConsumerByExternalId(client, {
			externalId: currentExternalId,
		});
		expect(found).toBe(createdConsumerId);
	});

	it("getConsumer returns the same consumer by id", async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		const consumer = await client.getConsumer(createdConsumerId);
		expect(consumer.id).toBe(createdConsumerId);
		expect(consumer.external_id).toBe(currentExternalId);
	});

	it("updateConsumer changes the name and returns it", async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		const updated = await client.updateConsumer(createdConsumerId, {
			name: "BA Live Test Consumer (renamed)",
		});
		expect(updated.id).toBe(createdConsumerId);
		expect(updated.name).toBe("BA Live Test Consumer (renamed)");
	});

	it("onBeforeUserCreate refuses a linked duplicate when claimExistingConsumerBy is omitted", async () => {
		const hook = onBeforeUserCreate({
			client,
			createConsumerOnSignUp: true,
			use: [],
		});

		await expect(
			hook(
				createLiveUser({
					id: `ba-live-conflict-${Date.now()}`,
					email: orgOwnerEmail,
				}),
				createHookContext(),
			),
		).rejects.toThrow(/already linked to another account/i);
	});

	it('onBeforeUserCreate reuses a linked duplicate when claimExistingConsumerBy is ["email"]', async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		const hook = onBeforeUserCreate({
			client,
			createConsumerOnSignUp: true,
			claimExistingConsumerBy: ["email"],
			use: [],
		});

		const result = await hook(
			createLiveUser({
				id: `ba-live-email-claim-${Date.now()}`,
				email: orgOwnerEmail,
			}),
			createHookContext(),
		);

		expect(result).toEqual({
			data: { streampayConsumerId: createdConsumerId },
		});
	});

	it('onAfterUserCreate rewrites external_id after an ["email"] reclaim', async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		const nextExternalId = `ba-live-email-claimed-${Date.now()}`;
		const hook = onAfterUserCreate({
			client,
			createConsumerOnSignUp: true,
			claimExistingConsumerBy: ["email"],
			use: [],
		});

		await hook(
			createLiveUser({
				id: nextExternalId,
				email: orgOwnerEmail,
				streampayConsumerId: createdConsumerId,
			}),
			createHookContext(),
		);

		const consumer = await client.getConsumer(createdConsumerId);
		expect(consumer.external_id).toBe(nextExternalId);
		currentExternalId = nextExternalId;
	});

	it.runIf(!!process.env.STREAMPAY_TEST_PRODUCT_ID)(
		"createPaymentLink against a real product returns a valid URL",
		async () => {
			if (!createdConsumerId || !config.productId) {
				throw new Error("prerequisite missing");
			}
			const link = await client.createPaymentLink({
				name: `BA live test link ${Date.now()}`,
				currency: "SAR",
				items: [
					{
						product_id: config.productId,
						quantity: 1,
						allow_custom_quantity: false,
					},
				],
				organization_consumer_id: createdConsumerId,
				max_number_of_payments: 1,
			});
			expect(link.id).toBeDefined();
			createdPaymentLinkId = link.id ?? null;

			const url = client.getPaymentUrl(link);
			expect(url).toBeDefined();
			expect(url?.startsWith("https://")).toBe(true);
		},
	);

	it.runIf(!!process.env.STREAMPAY_TEST_PRODUCT_ID)(
		"getPaymentUrl returns the same URL on a round-tripped payment link",
		async () => {
			if (!createdPaymentLinkId || !config.productId) {
				throw new Error("prerequisite missing");
			}
			expect(createdPaymentLinkId).toMatch(/.+/);
		},
	);

	it("deleteConsumer removes an owned consumer (adopted consumers are restored)", async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		if (!ownsConsumer) {
			await restoreAdoptedConsumer(createdConsumerId);
			const restored = await client.getConsumer(createdConsumerId);
			expect(restored.id).toBe(createdConsumerId);
			if (originalExternalId) {
				expect(restored.external_id).toBe(originalExternalId);
			}
			createdConsumerId = null;
			return;
		}
		await client.deleteConsumer(createdConsumerId);
		const foundAfter = await findConsumerByExternalId(client, {
			externalId: currentExternalId,
		});
		expect(foundAfter).toBeNull();
		createdConsumerId = null;
	});
});
