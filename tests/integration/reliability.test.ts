import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { admin, dispatchWebhook, portal, subscriptions, webhooks } from "../../src";
import { callAuthEndpoint, createStreamPayTestInstance } from "../utils/auth-instance";

const PLAN = {
	name: "pro",
	productId: "known",
	priceInSmallestUnit: 100,
	billingInterval: "MONTH" as const,
	limits: { teams: true },
};

describe("production reliability boundaries", () => {
	it("persists an unmapped product without retaining access to the previous plan", async () => {
		const { auth, client, sessionSetter, streamPayClient } = await createStreamPayTestInstance({
			use: [subscriptions({ plans: [PLAN] }), webhooks({ secret: "test-only-secret" })],
		});
		const account = await client.signUp.email(
			{ name: "Catalog", email: "catalog@example.com", password: "password123" },
			{ throw: true },
		);
		const headers = new Headers();
		await client.signIn.email(
			{ email: "catalog@example.com", password: "password123" },
			{ throw: true, onSuccess: sessionSetter(headers) },
		);
		async function deliver(productId: string, offset: number) {
			streamPayClient.getSubscription.mockResolvedValue({
				id: "catalog-sub",
				status: "ACTIVE",
				organization_consumer_id: "consumer",
				items: [{ product_id: productId, quantity: 1 }],
			});
			const body = JSON.stringify({
				event_type: "SUBSCRIPTION_PLAN_UPDATED",
				entity_type: "SUBSCRIPTION",
				entity_id: "catalog-sub",
				entity_url: "",
				status: "ACTIVE",
				timestamp: new Date(Date.now() + offset).toISOString(),
				data: {
					metadata: {
						streampay_plugin_plan_name: PLAN.name,
						streampay_plugin_reference_id: account.user.id,
						streampay_plugin_reference_type: "user",
					},
				},
			});
			const t = Math.floor(Date.now() / 1000);
			const signature = createHmac("sha256", "test-only-secret")
				.update(`${t}.${body}`)
				.digest("hex");
			return auth.handler(
				new Request("http://localhost:3000/api/auth/streampay/webhooks", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-webhook-signature": `t=${t},v1=${signature}`,
					},
					body,
				}),
			);
		}
		expect((await deliver(PLAN.productId, 0)).status).toBe(200);
		expect(
			await (
				await callAuthEndpoint(auth, "/subscription/has-feature?feature=teams", { headers })
			).json(),
		).toEqual({ hasFeature: true });
		expect((await deliver("unmapped", 1000)).status).toBe(200);
		expect(
			await (
				await callAuthEndpoint(auth, "/subscription/has-feature?feature=teams", { headers })
			).json(),
		).toEqual({ hasFeature: false });
		expect(
			await (await callAuthEndpoint(auth, "/subscription/list", { headers })).json(),
		).toMatchObject([{ plan: null, catalogMapped: false, productId: "unmapped" }]);
		const context = await auth.$context;
		expect(
			await context.adapter.findOne({
				model: "subscription",
				where: [{ field: "streampaySubscriptionId", value: "catalog-sub" }],
			}),
		).toMatchObject({ plan: PLAN.name, catalogMapped: false, productId: "unmapped" });
	});
	it.each([
		"alone",
		"before subscriptions",
		"after subscriptions",
	])("replays failed generic callbacks through the authenticated admin endpoint (%s)", async (order) => {
		const callback = vi
			.fn()
			.mockRejectedValueOnce(new Error("temporary callback failure"))
			.mockResolvedValue(undefined);
		const hookPlugin = webhooks({
			secret: "test-only-secret",
			deduplicate: true,
			onPayload: callback,
		});
		const subscriptionPlugin = subscriptions({ plans: [PLAN] });
		const plugins =
			order === "alone"
				? [hookPlugin]
				: order === "before subscriptions"
					? [hookPlugin, subscriptionPlugin]
					: [subscriptionPlugin, hookPlugin];
		const { auth, client, sessionSetter } = await createStreamPayTestInstance({
			use: [...plugins, admin({ isAdmin: () => true })],
		});
		const timestamp = new Date().toISOString();
		const body = JSON.stringify({
			event_type: "FUTURE_EVENT",
			entity_type: "FUTURE_ENTITY",
			entity_id: "test",
			entity_url: "",
			status: "OK",
			timestamp,
			data: {},
		});
		const t = Math.floor(Date.now() / 1000);
		const signature = createHmac("sha256", "test-only-secret").update(`${t}.${body}`).digest("hex");
		const response = await auth.handler(
			new Request("http://localhost:3000/api/auth/streampay/webhooks", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-webhook-signature": `t=${t},v1=${signature}`,
				},
				body,
			}),
		);
		expect(response.status).toBe(500);
		const path = `/admin/streampay/webhook-events/${encodeURIComponent(`handlers:FUTURE_EVENT:test:${timestamp}`)}/replay`;
		expect((await callAuthEndpoint(auth, path, { method: "POST" })).status).toBe(401);
		await client.signUp.email(
			{ name: "Replay", email: "replay@example.com", password: "password123" },
			{ throw: true },
		);
		const headers = new Headers();
		await client.signIn.email(
			{ email: "replay@example.com", password: "password123" },
			{ throw: true, onSuccess: sessionSetter(headers) },
		);
		const replayResponse = await callAuthEndpoint(auth, path, { method: "POST", headers });
		expect(await replayResponse.json()).toMatchObject({ replayed: true });
		expect(replayResponse.status).toBe(200);
		expect(callback).toHaveBeenCalledTimes(2);
	});
	it.each([
		"PAYMENT_PARTIALLY_REFUNDED",
		"SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
	])("dispatches %s to its typed handler", async (event) => {
		const callback = vi.fn();
		await dispatchWebhook(
			{
				event_type: event,
				entity_type: event.startsWith("PAYMENT") ? "PAYMENT" : "SUBSCRIPTION",
				entity_id: "test",
				entity_url: "",
				status: "ACTIVE",
				timestamp: new Date().toISOString(),
				data: {},
			},
			{ onPaymentPartiallyRefunded: callback, onSubscriptionCycleRenewedSuccessfully: callback },
		);
		expect(callback).toHaveBeenCalledTimes(1);
	});
	it("deduplicates generic callbacks across deliveries using the database inbox", async () => {
		let release = () => {};
		let entered = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const callback = vi.fn(async () => {
			entered();
			await gate;
		});
		const { auth } = await createStreamPayTestInstance({
			use: [webhooks({ secret: "test-only-secret", deduplicate: true, onPayload: callback })],
		});
		const body = JSON.stringify({
			event_type: "PAYMENT_SUCCEEDED",
			entity_type: "PAYMENT",
			entity_id: "payment-test",
			entity_url: "",
			status: "SUCCEEDED",
			timestamp: new Date().toISOString(),
			data: {},
		});
		const t = Math.floor(Date.now() / 1000);
		const signature = createHmac("sha256", "test-only-secret").update(`${t}.${body}`).digest("hex");
		const send = () =>
			auth.handler(
				new Request("http://localhost:3000/api/auth/streampay/webhooks", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-webhook-signature": `t=${t},v1=${signature}`,
					},
					body,
				}),
			);
		const first = send();
		await started;
		try {
			expect((await send()).status).toBe(200);
		} finally {
			release();
		}
		expect((await first).status).toBe(200);
		expect((await send()).status).toBe(200);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it.each([
		"missing consumer",
		"missing configuration",
	])("rejects portal access with %s", async (reason) => {
		const createSession = vi.fn();
		const { auth, client, sessionSetter, streamPayClient } = await createStreamPayTestInstance({
			use: [portal(reason === "missing consumer" ? { createSession } : {})],
		});
		const account = await client.signUp.email(
			{ email: "missing@example.com", password: "password123", name: "Missing" },
			{ throw: true },
		);
		if (reason === "missing configuration") {
			const context = await auth.$context;
			await context.adapter.update({
				model: "user",
				where: [{ field: "id", value: account.user.id }],
				update: { streampayConsumerId: "owned" },
			});
		}
		streamPayClient.listConsumers.mockResolvedValue({ data: [] });
		const headers = new Headers();
		await client.signIn.email(
			{ email: "missing@example.com", password: "password123" },
			{ throw: true, onSuccess: sessionSetter(headers) },
		);
		const response = await callAuthEndpoint(auth, "/consumer/portal/session", {
			method: "POST",
			headers,
		});
		expect(response.status).toBe(404);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("creates uncached portal sessions for the signed-in consumer and ignores caller ownership", async () => {
		const createSession = vi
			.fn()
			.mockResolvedValue({ url: "https://billing.streampay.sa/session/test" });
		const { auth, client, sessionSetter } = await createStreamPayTestInstance({
			use: [portal({ createSession })],
		});
		const path = "/consumer/portal/session";
		expect((await callAuthEndpoint(auth, path, { method: "POST", body: {} })).status).toBe(401);
		expect(createSession).not.toHaveBeenCalled();
		const account = await client.signUp.email(
			{ email: "portal@example.com", password: "password123", name: "Portal" },
			{ throw: true },
		);
		const context = await auth.$context;
		await context.adapter.update({
			model: "user",
			where: [{ field: "id", value: account.user.id }],
			update: { streampayConsumerId: "owned-consumer" },
		});
		const headers = new Headers();
		await client.signIn.email(
			{ email: "portal@example.com", password: "password123" },
			{ throw: true, onSuccess: sessionSetter(headers) },
		);
		const send = () =>
			callAuthEndpoint(auth, path, {
				method: "POST",
				headers,
				body: { organization_consumer_id: "someone-else" },
			});
		const response = await send();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ url: "https://billing.streampay.sa/session/test" });
		expect(createSession).toHaveBeenCalledWith({ organization_consumer_id: "owned-consumer" });
		await send();
		expect(createSession).toHaveBeenCalledTimes(2);
		createSession.mockRejectedValueOnce(new Error("provider unavailable"));
		const failed = await send();
		expect(failed.status).toBe(500);
		expect(await failed.json()).toMatchObject({ message: "StreamPay createPortalSession failed." });
		createSession.mockResolvedValueOnce({ url: "javascript:alert(1)" });
		expect((await send()).status).toBe(500);
	});

	it("lets authenticated users request later invoice pages while retaining consumer ownership", async () => {
		const { auth, client, sessionSetter, streamPayClient } = await createStreamPayTestInstance({
			use: [portal()],
		});
		const user = await client.signUp.email(
			{ email: "pagination@example.com", password: "password123", name: "Pagination" },
			{ throw: true },
		);
		const context = await auth.$context;
		await context.adapter.update({
			model: "user",
			where: [{ field: "id", value: user.user.id }],
			update: { streampayConsumerId: "owned-consumer" },
		});
		const headers = new Headers();
		await client.signIn.email(
			{ email: "pagination@example.com", password: "password123" },
			{ throw: true, onSuccess: sessionSetter(headers) },
		);
		streamPayClient.listInvoices.mockResolvedValue({
			data: [],
			pagination: { current_page: 2, limit: 10 },
		});
		const response = await callAuthEndpoint(
			auth,
			"/consumer/invoices/list?page=2&size=10&organization_consumer_id=someone-else",
			{ headers },
		);
		expect(response.status).toBe(200);
		expect(streamPayClient.listInvoices).toHaveBeenCalledWith({
			organization_consumer_id: "owned-consumer",
			page: 2,
			limit: 10,
		});
		expect(await response.json()).toMatchObject({ pagination: { current_page: 2, limit: 10 } });
		expect(
			(await callAuthEndpoint(auth, "/consumer/invoices/list?page=-1", { headers })).status,
		).toBe(400);
	});
});
