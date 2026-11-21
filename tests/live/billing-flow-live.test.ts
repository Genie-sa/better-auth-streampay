/**
 * End-to-end against a StreamPay sandbox: a real Better Auth instance, the real SDK client, and
 * locally signed webhooks (sandbox keys cannot register webhook endpoints). Sandbox organizations
 * only accept the owner's email for consumers, so the flow adopts the owner's existing consumer
 * and restores its `external_id` afterwards. Links are deactivated and the subscription canceled.
 */
import { createHmac } from "node:crypto";
import StreamSDK from "@streamsdk/typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { admin, subscriptions, webhooks } from "../../src";
import type { StreamPayClient } from "../../src/types";
import { findConsumerByIdentifiers } from "../../src/utils/consumer";
import { callAuthEndpoint, createStreamPayTestInstance } from "../utils/auth-instance";
import type { MockedStreamPayClient } from "../utils/mocks";

const live = process.env.STREAMPAY_LIVE === "1" && process.env.STREAMPAY_LIVE_WRITE === "1";
const productId = process.env.STREAMPAY_TEST_PRODUCT_ID;
const liveDescribe = live && productId ? describe : describe.skip;
const WEBHOOK_SECRET = "live-flow-local-signing-secret";
const STALE_RESERVATION_AGE_MS = 16 * 60 * 1000;

type Row = Record<string, unknown>;
type Instance = Awaited<ReturnType<typeof createStreamPayTestInstance>>;

liveDescribe("live billing flow against the StreamPay sandbox", { timeout: 60_000 }, () => {
	const client = StreamSDK.init(process.env.STREAMPAY_API_KEY ?? "", {
		baseUrl: process.env.STREAMPAY_BASE_URL ?? "https://stream-app-service.streampay.sa",
	}) as StreamPayClient;
	const onPayload = vi.fn();
	const createdLinks = new Set<string>();
	let instance: Instance;
	let headers: Headers;
	let userId: string;
	let consumerId: string | null = null;
	let adoptedConsumer: { id: string; externalId: string | null; name: string | null } | null = null;
	let subscriptionId: string | null = null;
	let plan: {
		name: string;
		productId: string;
		priceInSmallestUnit: number;
		currency: "SAR";
		billingInterval: "MONTH";
		seatBilling: { minimum: number; maximum: number };
	};

	async function rows(model: string): Promise<Row[]> {
		const adapter = (await instance.auth.$context).adapter as unknown as {
			findMany: (input: { model: string }) => Promise<Row[]>;
		};
		return adapter.findMany({ model });
	}

	async function setRow(model: string, id: string, update: Row): Promise<void> {
		await (await instance.auth.$context).adapter.update({
			model,
			update,
			where: [{ field: "id", value: id }],
		});
	}

	function upgrade(seats: number) {
		return callAuthEndpoint(instance.auth, "/subscription/upgrade", {
			method: "POST",
			body: { plan: plan.name, seats },
			headers,
		});
	}

	function deliver(event: Row) {
		const body = JSON.stringify({ entity_url: "", status: "OK", data: {}, ...event });
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = createHmac("sha256", WEBHOOK_SECRET)
			.update(`${timestamp}.${body}`)
			.digest("hex");
		return instance.auth.handler(
			new Request("http://localhost:3000/api/auth/streampay/webhooks", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-webhook-signature": `t=${timestamp},v1=${signature}`,
				},
				body,
			}),
		);
	}

	async function linkStatus(id: string): Promise<string | undefined> {
		return (await client.getPaymentLink(id)).status;
	}

	beforeAll(async () => {
		const me = await (client as unknown as ReturnType<typeof StreamSDK.init>).getMe();
		if (me.organization?.sandbox !== true) throw new Error("A sandbox organization is required.");
		const ownerEmail = me.user?.email;
		if (!ownerEmail) throw new Error("The sandbox owner has no email.");
		const existing = await findConsumerByIdentifiers(client, { email: ownerEmail });
		if (existing?.id) {
			adoptedConsumer = {
				id: existing.id,
				externalId: existing.external_id ?? null,
				name: existing.name ?? null,
			};
		}
		const product = await client.getProduct(productId ?? "");
		plan = {
			name: "live-starter",
			productId: product.id ?? "",
			priceInSmallestUnit: Math.round(Number(product.price) * 100),
			currency: "SAR",
			billingInterval: "MONTH",
			seatBilling: { minimum: 1, maximum: 3 },
		};
		instance = await createStreamPayTestInstance({
			client: client as unknown as MockedStreamPayClient,
			streamPayOptions: { claimExistingConsumerBy: ["email"] },
			use: [
				subscriptions({ plans: [plan] }),
				webhooks({ secret: WEBHOOK_SECRET, deduplicate: true, onPayload }),
				admin({ isAdmin: () => true }),
			],
		});
		const email = ownerEmail;
		const account = await instance.client.signUp.email(
			{ name: "Live Flow", email, password: "password123" },
			{ throw: true },
		);
		userId = account.user.id;
		headers = new Headers();
		await instance.client.signIn.email(
			{ email, password: "password123" },
			{ throw: true, onSuccess: instance.sessionSetter(headers) },
		);
	});

	afterAll(async () => {
		for (const id of createdLinks) {
			await client.updatePaymentLinkStatus?.(id, { status: "INACTIVE" }).catch(() => {});
		}
		if (subscriptionId) {
			const remote = await client.getSubscription(subscriptionId).catch(() => null);
			if (remote && remote.status !== "CANCELED") {
				await client
					.cancelSubscription(subscriptionId, { cancel_related_invoices: true })
					.catch(() => {});
			}
		}
		if (adoptedConsumer && adoptedConsumer.id === consumerId) {
			await client.updateConsumer(adoptedConsumer.id, {
				external_id: adoptedConsumer.externalId,
				...(adoptedConsumer.name ? { name: adoptedConsumer.name } : {}),
			});
			expect((await client.getConsumer(adoptedConsumer.id)).external_id).toBe(
				adoptedConsumer.externalId,
			);
		} else if (consumerId) {
			await client.deleteConsumer(consumerId).catch(() => {});
		}
	});

	it("provisions the consumer lazily and reserves the slot behind a real checkout link", async () => {
		const response = await upgrade(1);
		const body = (await response.json()) as Row;
		if (response.status !== 200) console.info(`upgrade failed: ${JSON.stringify(body)}`);

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ reused: false, status: "incomplete", seats: 1 });
		expect(String(body.url)).toMatch(/^https:\/\//);
		const [user] = (await rows("user")).filter((row) => row.id === userId);
		consumerId = String(user?.streampayConsumerId);
		expect((await client.getConsumer(consumerId)).external_id).toBe(userId);
		const [reservation] = await rows("subscription");
		createdLinks.add(String(reservation?.streampayPaymentLinkId));
		expect(reservation).toMatchObject({ status: "incomplete", streampayConsumerId: consumerId });
		expect(reservation?.activeSlotKey).toBeTruthy();
	});

	it("reuses the open checkout for the same plan and seats", async () => {
		const [reservation] = await rows("subscription");

		const body = (await (await upgrade(1)).json()) as Row;

		expect(body).toMatchObject({ reused: true, subscriptionId: reservation?.id });
		expect(await rows("subscription")).toHaveLength(1);
	});

	it("refuses a different seat count while the first checkout is still fresh", async () => {
		const response = await upgrade(2);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "SUBSCRIPTION_CHECKOUT_IN_PROGRESS" });
	});

	it("makes an abandoned checkout link unpayable before replacing its reservation", async () => {
		const [abandoned] = await rows("subscription");
		const abandonedLink = String(abandoned?.streampayPaymentLinkId);
		await setRow("subscription", String(abandoned?.id), {
			createdAt: new Date(Date.now() - STALE_RESERVATION_AGE_MS),
		});

		const response = await upgrade(2);

		expect(response.status).toBe(200);
		expect(await linkStatus(abandonedLink)).toBe("INACTIVE");
		const all = await rows("subscription");
		const replacement = all.find((row) => row.id !== abandoned?.id);
		createdLinks.add(String(replacement?.streampayPaymentLinkId));
		expect(all.find((row) => row.id === abandoned?.id)).toMatchObject({
			status: "incomplete_expired",
			activeSlotKey: null,
		});
		expect(replacement).toMatchObject({ status: "incomplete", seats: 2 });
		expect(await linkStatus(String(replacement?.streampayPaymentLinkId))).toBe("ACTIVE");
	});

	it("projects a real StreamPay subscription from a signed webhook into the reserved slot", async () => {
		const created = await client.createSubscription({
			organization_consumer_id: consumerId ?? "",
			items: [{ product_id: plan.productId, quantity: 1 }],
			period_start: new Date(Date.now() + 3 * 86_400_000).toISOString(),
			trial: true,
			until_cycle_number: 1,
			notify_consumer: false,
			description: "better-auth-streampay live flow",
			currency: "SAR",
			exclude_coupons_if_installments: false,
		});
		subscriptionId = created.id ?? null;
		const event = {
			event_type: "SUBSCRIPTION_CREATED",
			entity_type: "SUBSCRIPTION",
			entity_id: subscriptionId,
			timestamp: new Date().toISOString(),
			data: {
				metadata: {
					streampay_plugin_plan_name: plan.name,
					streampay_plugin_reference_id: userId,
					streampay_plugin_reference_type: "user",
				},
			},
		};

		expect((await deliver(event)).status).toBe(200);
		expect((await deliver(event)).status).toBe(200);

		const live = (await rows("subscription")).find(
			(row) => row.streampaySubscriptionId === subscriptionId,
		);
		expect(live).toMatchObject({
			plan: plan.name,
			catalogMapped: true,
			productId: plan.productId,
			seats: 1,
			streampayConsumerId: consumerId,
		});
		expect(live?.activeSlotKey).toBeTruthy();
		const inbox = await rows("streampayWebhookEvent");
		expect(inbox.filter((row) => !String(row.eventId).startsWith("handlers:"))).toMatchObject([
			{ status: "completed", attemptCount: 1 },
		]);
		const current = await callAuthEndpoint(instance.auth, "/subscription/current", { headers });
		expect(await current.json()).toMatchObject({ streampaySubscriptionId: subscriptionId });
	});

	it("retries a failed generic handler through admin replay and the due queue", async () => {
		const event = {
			event_type: "PAYMENT_SUCCEEDED",
			entity_type: "PAYMENT",
			entity_id: `pay_live_${Date.now()}`,
			timestamp: new Date().toISOString(),
		};
		const eventId = `handlers:${event.event_type}:${event.entity_id}:${event.timestamp}`;
		onPayload
			.mockRejectedValueOnce(new Error("handler down"))
			.mockRejectedValueOnce(new Error("still down"));

		expect((await deliver(event)).status).toBe(500);
		const replay = await callAuthEndpoint(
			instance.auth,
			`/admin/streampay/webhook-events/${encodeURIComponent(eventId)}/replay`,
			{ method: "POST", headers },
		);
		expect(replay.status).toBe(500);
		const failed = (await rows("streampayWebhookEvent")).find((row) => row.eventId === eventId);
		expect(failed).toMatchObject({ status: "pending", attemptCount: 2 });
		await setRow("streampayWebhookEvent", String(failed?.id), {
			nextAttemptAt: new Date(Date.now() - 1000),
		});

		const processDue = instance.auth.api.processDueStreampayWebhookEvents as (input: {
			body: { limit: number };
		}) => Promise<{ succeeded: string[]; failed: unknown[] }>;
		expect(await processDue({ body: { limit: 10 } })).toMatchObject({ succeeded: [eventId] });
		expect(
			(await rows("streampayWebhookEvent")).find((row) => row.eventId === eventId),
		).toMatchObject({ status: "completed", attemptCount: 3 });
		const deliveries = onPayload.mock.calls.filter(
			([payload]) => (payload as Row).entity_id === event.entity_id,
		);
		expect(deliveries).toHaveLength(3);
	});

	it("refreshes plan fields when an admin changes the subscription at StreamPay", async () => {
		const response = await callAuthEndpoint(
			instance.auth,
			`/admin/streampay/subscriptions/${subscriptionId}`,
			{
				method: "PATCH",
				body: { items: [{ product_id: plan.productId, quantity: 1 }], coupons: [] },
				headers,
			},
		);

		expect(response.status).toBe(200);
		const live = (await rows("subscription")).find(
			(row) => row.streampaySubscriptionId === subscriptionId,
		);
		expect(live).toMatchObject({ catalogMapped: true, plan: plan.name });
	});

	it("cancels through the customer endpoint without losing the plan mapping", async () => {
		const live = (await rows("subscription")).find(
			(row) => row.streampaySubscriptionId === subscriptionId,
		);

		const response = await callAuthEndpoint(instance.auth, "/subscription/cancel", {
			method: "POST",
			body: { subscriptionId: live?.id },
			headers,
		});
		const providerResponse = (await response.json()) as Row;

		expect(response.status).toBe(200);
		console.info(
			`live cancel response carries items: ${Array.isArray(providerResponse.items)} (status ${String(providerResponse.status)}); adopted consumer restore target is a ${adoptedConsumer?.externalId?.length ?? 0}-char id, test user id ${userId.slice(0, 6)}`,
		);
		const canceled = (await rows("subscription")).find((row) => row.id === live?.id);
		expect(canceled).toMatchObject({ catalogMapped: true, plan: plan.name });
		expect(["canceled", "trial_pending", "trialing"]).toContain(canceled?.status);
		if (canceled?.status === "canceled") expect(canceled.activeSlotKey).toBeNull();
	});

	it("discards a dead event through the admin endpoint", async () => {
		const [event] = (await rows("streampayWebhookEvent")).filter(
			(row) => !String(row.eventId).startsWith("handlers:"),
		);
		const eventId = String(event?.eventId);

		const response = await callAuthEndpoint(
			instance.auth,
			`/admin/streampay/webhook-events/${encodeURIComponent(eventId)}`,
			{ method: "DELETE", headers },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ discarded: true, eventId });
	});
});
