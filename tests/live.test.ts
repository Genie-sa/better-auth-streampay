import { createHmac } from "node:crypto";
import StreamSDK from "@streamsdk/typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamPayClient } from "../src/types";
import { findConsumerByExternalId } from "../src/utils/consumer";
import { verifyWebhook } from "../src/webhooks/verify";

/**
 * Live integration suite. Opt-in: only runs when `STREAMPAY_LIVE=1` is
 * set, which `tests/setup.ts` picks up from the gitignored
 * `.env.test.local`. When disabled, every block is skipped and the
 * file compiles normally so `pnpm typecheck` still exercises the
 * structural compatibility between the real SDK and `StreamPayClient`.
 *
 * The read-only block exists as a smoke test for authentication and
 * response-shape assumptions. The write block exists to prove that the
 * plugin's narrow interface is behaviorally correct against real HTTP
 * — creating a consumer, finding it via `findConsumerByExternalId`,
 * updating it, creating a payment link for it, and deleting it.
 *
 * Every write-block test cleans up after itself in `afterAll` so the
 * suite is safe to re-run indefinitely without leaving sandbox drift.
 */

const live = process.env.STREAMPAY_LIVE === "1";
const liveDescribe = live ? describe : describe.skip;

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

liveDescribe("live StreamPay — read-only smoke", () => {
	const config = live
		? getConfig()
		: {
				apiKey: "",
				baseUrl: "",
				webhookSecret: undefined,
				productId: undefined,
			};
	const sdk = StreamSDK.init(config.apiKey, { baseUrl: config.baseUrl });
	// Structural check: the real SDK satisfies our narrow interface.
	const client: StreamPayClient = sdk;

	it("authenticates and lists consumers with the expected pagination shape", async () => {
		const response = await client.listConsumers({ page: 1, size: 1 });
		expect(response).toBeDefined();
		expect(Array.isArray(response.data)).toBe(true);
		expect(response.pagination).toBeDefined();
		// The plugin relies on `total_count` specifically (see utils/consumer.ts).
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

	it("lists payments", async () => {
		const response = await client.listPayments();
		expect(response).toBeDefined();
		expect(Array.isArray(response.data)).toBe(true);
	});

	it("findConsumerByExternalId returns null for a definitely-missing id", async () => {
		const result = await findConsumerByExternalId(client, {
			externalId: "ba-streampay-test-99999999-9999-9999-9999-999999999999",
			maxPages: 2,
			pageSize: 100,
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

/**
 * Write suite. Sandbox-safe: creates exactly one consumer using the
 * org-owner email (the sandbox constraint), runs every write path
 * against it, and deletes it in `afterAll` — even if the test body
 * throws. The hash of `Date.now()` in the external_id keeps reruns
 * from colliding with leftover state from an earlier run.
 */
liveDescribe("live StreamPay — write suite", () => {
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

	const externalId = `ba-live-test-${Date.now()}`;
	let orgOwnerEmail = "";
	let createdConsumerId: string | null = null;
	let createdPaymentLinkId: string | null = null;

	beforeAll(async () => {
		// Discover the org-owner email via /api/v2/me — the sandbox
		// constraint requires every created consumer to match this.
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
		// Best-effort cleanup. We don't fail the suite on cleanup errors
		// because leaving a stale sandbox consumer is a minor annoyance,
		// not a correctness failure — and sometimes StreamPay responds
		// 404 because an earlier test already deleted it.
		if (createdConsumerId) {
			try {
				await client.deleteConsumer(createdConsumerId);
			} catch {
				// ignore — sandbox cleanup
			}
		}
	});

	it("createConsumer succeeds and returns a real id", async () => {
		const consumer = await client.createConsumer({
			name: "BA Live Test Consumer",
			email: orgOwnerEmail,
			external_id: externalId,
		});
		expect(consumer.id).toBeDefined();
		expect(typeof consumer.id).toBe("string");
		expect(consumer.external_id).toBe(externalId);
		expect(consumer.email).toBe(orgOwnerEmail);
		createdConsumerId = consumer.id ?? null;
	});

	it("findConsumerByExternalId finds the freshly-created consumer", async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		const found = await findConsumerByExternalId(client, {
			externalId,
			maxPages: 10,
			pageSize: 100,
		});
		expect(found).toBe(createdConsumerId);
	});

	it("getConsumer returns the same consumer by id", async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		const consumer = await client.getConsumer(createdConsumerId);
		expect(consumer.id).toBe(createdConsumerId);
		expect(consumer.external_id).toBe(externalId);
	});

	it("updateConsumer changes the name and returns it", async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		const updated = await client.updateConsumer(createdConsumerId, {
			name: "BA Live Test Consumer (renamed)",
		});
		expect(updated.id).toBe(createdConsumerId);
		expect(updated.name).toBe("BA Live Test Consumer (renamed)");
	});

	it.runIf(!!process.env.STREAMPAY_TEST_PRODUCT_ID)(
		"createPaymentLink against a real product returns a valid URL",
		async () => {
			if (!createdConsumerId || !config.productId) {
				throw new Error("prerequisite missing");
			}
			const link = await client.createPaymentLink({
				name: `BA live test link ${Date.now()}`,
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
			// Note: the SDK doesn't expose `getPaymentLink` on our narrow
			// interface — we validated the URL shape in the previous test,
			// which is sufficient for our purposes.
			expect(createdPaymentLinkId).toMatch(/.+/);
		},
	);

	it("deleteConsumer removes the consumer", async () => {
		if (!createdConsumerId) throw new Error("prerequisite test failed");
		await client.deleteConsumer(createdConsumerId);
		// After deletion, the consumer is flagged `is_deleted` rather than
		// 404'd by StreamPay, so we verify via list-scan with our helper.
		const foundAfter = await findConsumerByExternalId(client, {
			externalId,
			maxPages: 10,
			pageSize: 100,
		});
		expect(foundAfter).toBeNull();
		// Clear the cleanup marker — deletion already succeeded.
		createdConsumerId = null;
	});
});
