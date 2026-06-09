import StreamSDK from "@streamsdk/typescript";
import { describe, expect, it } from "vitest";
import {
	classifyWebhookFailure,
	subscriptionItemProductId,
} from "../../src/plugins/subscriptions/sync";
import type { StreamPayClient } from "../../src/types";
import { findConsumerByIdentifiers } from "../../src/utils/consumer";

const live = process.env.STREAMPAY_LIVE === "1";
const liveDescribe = live ? describe : describe.skip;

const apiKey = process.env.STREAMPAY_API_KEY ?? "";
const baseUrl = process.env.STREAMPAY_BASE_URL ?? "https://stream-app-service.streampay.sa";

liveDescribe("live proof: behavioral fixes", () => {
	const sdk = StreamSDK.init(apiKey, { baseUrl });
	const client: StreamPayClient = sdk;

	it("classifies a real 404 from getSubscription as TRANSIENT (retryable, not dropped)", async () => {
		let thrown: unknown;
		try {
			await client.getSubscription("00000000-0000-0000-0000-000000000000");
		} catch (err) {
			thrown = err;
		}
		expect(thrown, "getSubscription on a missing id should throw").toBeDefined();
		const status =
			(thrown as { status?: number })?.status ??
			(thrown as { response?: { status?: number } })?.response?.status;
		expect(status).toBe(404);

		expect(classifyWebhookFailure(thrown)).toBe("TRANSIENT");
	});

	it("extracts a product id from a live subscription's real items shape", async () => {
		const subs = await client.listSubscriptions({ page: 1, size: 10 });
		const withItems = (subs.data ?? []).find((s) => Array.isArray(s.items) && s.items.length > 0);
		if (!withItems) {
			console.warn("no live subscription with items — extractor shape not exercised");
			return;
		}
		const productId = subscriptionItemProductId(withItems.items?.[0]);
		expect(typeof productId).toBe("string");
		expect((productId ?? "").length).toBeGreaterThan(0);
	});

	it("matches a live consumer case-insensitively by email", async () => {
		const me = (await (
			await fetch(`${baseUrl}/api/v2/me`, { headers: { "x-api-key": apiKey } })
		).json()) as { user?: { email?: string } };
		const email = me.user?.email;
		expect(email, "/me must return an email").toBeTruthy();
		if (!email) return;

		const exact = await findConsumerByIdentifiers(client, { email });
		const upper = await findConsumerByIdentifiers(client, { email: email.toUpperCase() });

		expect(exact?.id).toBeDefined();
		expect(upper?.id).toBe(exact?.id);
	});
});
