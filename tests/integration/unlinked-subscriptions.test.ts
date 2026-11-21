import { describe, expect, it, vi } from "vitest";
import { admin, subscriptions, webhooks } from "../../src";
import type { SubscriptionsOptions } from "../../src/plugins/subscriptions/types";
import { subscriptionSlotKey } from "../../src/plugins/subscriptions/types";
import { callAuthEndpoint } from "../utils/auth-instance";
import {
	type Harness,
	harness,
	providerSubscription,
	SECRET,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

const EVENT_AT = "2026-04-01T00:00:01.000Z";

function pluginMetadata(h: Harness, extra: Record<string, string> = {}) {
	return {
		streampay_plugin_plan_name: TEAM.name,
		streampay_plugin_reference_id: h.userId,
		streampay_plugin_reference_type: "user",
		...extra,
	};
}

function invoiceCompleted(invoiceId: string) {
	return {
		event_type: "INVOICE_COMPLETED",
		entity_type: "INVOICE",
		entity_id: invoiceId,
		timestamp: EVENT_AT,
		data: { invoice: { id: invoiceId, url: "" } },
	};
}

function subscriptionEvent(eventType: string, subscriptionId: string, metadata?: object) {
	return {
		event_type: eventType,
		entity_type: "SUBSCRIPTION",
		entity_id: subscriptionId,
		timestamp: EVENT_AT,
		data: metadata ? { metadata } : {},
	};
}

async function setup(options: Partial<SubscriptionsOptions> = {}) {
	const callbacks = {
		onSubscriptionRenewed: vi.fn(),
		onSubscriptionCreated: vi.fn(),
		onSubscriptionActivated: vi.fn(),
	};
	const h = await harness([
		subscriptions({ plans: [TEAM], ...callbacks, ...options }),
		webhooks({ secret: SECRET }),
		admin({ isAdmin: (user) => user.email?.startsWith("state-") === true }),
	]);
	await h.setRow("user", h.userId, { streampayConsumerId: "cons_1" });
	return { h, ...callbacks };
}

/** A paid checkout whose local reservation is gone, renewed to cycle 3. */
function renewedCheckout(h: Harness, metadata: Record<string, string> | null, consumer = "cons_1") {
	h.stream.getSubscription.mockResolvedValue(
		providerSubscription("sub_lost", "ACTIVE", {
			organization_consumer_id: consumer,
			current_cycle_number: 3,
			latest_invoice: { id: "inv_3", status: "COMPLETED", payment_link_id: "pl_lost" },
		}),
	);
	h.stream.getInvoice.mockResolvedValue({ id: "inv_3", subscription_id: "sub_lost" } as never);
	if (metadata) {
		h.stream.getPaymentLink.mockResolvedValue({
			id: "pl_lost",
			custom_metadata: metadata,
		} as never);
	} else {
		h.stream.getPaymentLink.mockRejectedValue(
			Object.assign(new Error("not found"), { status: 404, body: {} }),
		);
	}
}

/** A subscription created in the StreamPay dashboard: no checkout link, no plugin metadata. */
function dashboardSubscription(h: Harness, extra: Record<string, unknown> = {}) {
	h.stream.getSubscription.mockResolvedValue(
		providerSubscription("sub_dash", "ACTIVE", { current_cycle_number: 1, ...extra }),
	);
}

function linkRequest(h: Harness, subscriptionId: string, body: Record<string, unknown>) {
	return callAuthEndpoint(h.auth, `/admin/streampay/subscriptions/${subscriptionId}/link`, {
		method: "POST",
		body,
		headers: h.headers,
	});
}

describe(`subscriptions without a local reservation (${TEST_WITH})`, () => {
	describe("renewal evidence with plugin checkout metadata", () => {
		it("links an existing user with a matching consumer and reports the renewal once", async () => {
			const { h, onSubscriptionRenewed } = await setup();
			renewedCheckout(h, pluginMetadata(h));

			expect((await h.deliver(invoiceCompleted("inv_3"))).status).toBe(200);

			expect(await h.rows("subscription")).toMatchObject([
				{
					streampaySubscriptionId: "sub_lost",
					referenceId: h.userId,
					referenceType: "user",
					status: "active",
					activeSlotKey: subscriptionSlotKey("user", h.userId, null),
					renewedCycleNumber: 3,
				},
			]);
			expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
		});

		it("does not adopt a checkout link stamped by another app", async () => {
			const resolveUnlinkedSubscription = vi.fn();
			const { h, onSubscriptionRenewed } = await setup({
				appId: "this-app",
				resolveUnlinkedSubscription,
			});
			renewedCheckout(h, pluginMetadata(h, { streampay_plugin_app_id: "other-app" }));

			expect((await h.deliver(invoiceCompleted("inv_3"))).status).toBe(200);

			expect(await h.rows("subscription")).toEqual([]);
			expect(onSubscriptionRenewed).not.toHaveBeenCalled();
			expect(resolveUnlinkedSubscription).not.toHaveBeenCalled();
		});

		it("does not adopt a reference to a user that does not exist here", async () => {
			const { h } = await setup();
			renewedCheckout(h, { ...pluginMetadata(h), streampay_plugin_reference_id: "user_elsewhere" });

			await h.deliver(invoiceCompleted("inv_3"));

			expect(await h.rows("subscription")).toEqual([]);
		});

		it("does not adopt a user whose StreamPay consumer is different", async () => {
			const { h } = await setup();
			renewedCheckout(h, pluginMetadata(h), "cons_other");

			await h.deliver(invoiceCompleted("inv_3"));

			expect(await h.rows("subscription")).toEqual([]);
		});

		it("links an organization reference only when resolveSubscriptionReference accepts it", async () => {
			const resolveSubscriptionReference = vi.fn().mockResolvedValue(true);
			const { h } = await setup({ resolveSubscriptionReference });
			const orgMetadata = {
				...pluginMetadata(h),
				streampay_plugin_reference_id: "org_1",
				streampay_plugin_reference_type: "organization",
			};
			renewedCheckout(h, orgMetadata);

			await h.deliver(invoiceCompleted("inv_3"));

			expect(resolveSubscriptionReference).toHaveBeenCalledWith(
				expect.objectContaining({ referenceType: "organization", referenceId: "org_1" }),
			);
			expect(await h.rows("subscription")).toMatchObject([
				{
					referenceType: "organization",
					referenceId: "org_1",
					streampaySubscriptionId: "sub_lost",
				},
			]);
		});

		it("skips an organization reference when no resolver can verify it", async () => {
			const { h } = await setup();
			renewedCheckout(h, {
				...pluginMetadata(h),
				streampay_plugin_reference_id: "org_1",
				streampay_plugin_reference_type: "organization",
			});

			await h.deliver(invoiceCompleted("inv_3"));

			expect(await h.rows("subscription")).toEqual([]);
		});
	});

	describe("creation webhooks with plugin metadata", () => {
		it("does not create a row for a user that does not exist here", async () => {
			const { h } = await setup();
			h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_x", "ACTIVE"));

			await h.deliver(
				subscriptionEvent("SUBSCRIPTION_ACTIVATED", "sub_x", {
					...pluginMetadata(h),
					streampay_plugin_reference_id: "user_elsewhere",
				}),
			);

			expect(await h.rows("subscription")).toEqual([]);
		});

		it("links a released reservation that owns the payment link instead of failing on it", async () => {
			const { h, onSubscriptionActivated } = await setup();
			expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
			const [reservation] = await h.rows("subscription");
			await h.setRow("subscription", String(reservation?.id), {
				status: "incomplete_expired",
				activeSlotKey: null,
			});
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_paid_late", "ACTIVE", {
					latest_invoice: { id: "inv_1", status: "COMPLETED", payment_link_id: "pl_1" },
				}),
			);

			const response = await h.deliver(
				subscriptionEvent("SUBSCRIPTION_ACTIVATED", "sub_paid_late", pluginMetadata(h)),
			);

			expect(response.status).toBe(200);
			expect(await h.rows("subscription")).toMatchObject([
				{ id: reservation?.id, streampaySubscriptionId: "sub_paid_late", status: "active" },
			]);
			expect(onSubscriptionActivated).toHaveBeenCalledTimes(1);
		});

		it("stamps the app ID on new checkout links", async () => {
			const { h } = await setup({ appId: "this-app" });

			expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);

			expect(h.stream.createPaymentLink.mock.calls[0]?.[0].custom_metadata).toMatchObject({
				streampay_plugin_app_id: "this-app",
			});
		});
	});

	describe("resolveUnlinkedSubscription", () => {
		it("links a dashboard subscription the app maps, with the consumer user as a hint", async () => {
			const resolveUnlinkedSubscription = vi.fn(async ({ consumerUser }) =>
				consumerUser ? { referenceType: "user" as const, referenceId: consumerUser.id } : null,
			);
			const { h, onSubscriptionCreated } = await setup({ resolveUnlinkedSubscription });
			dashboardSubscription(h);

			expect((await h.deliver(subscriptionEvent("SUBSCRIPTION_CREATED", "sub_dash"))).status).toBe(
				200,
			);

			expect(resolveUnlinkedSubscription).toHaveBeenCalledWith(
				expect.objectContaining({
					consumerUser: expect.objectContaining({ id: h.userId }),
					inferredPlan: expect.objectContaining({ name: TEAM.name }),
					linkMetadata: null,
				}),
			);
			expect(await h.rows("subscription")).toMatchObject([
				{ streampaySubscriptionId: "sub_dash", referenceId: h.userId, plan: TEAM.name },
			]);
			expect(onSubscriptionCreated).toHaveBeenCalledTimes(1);
		});

		it("leaves the subscription unlinked when the resolver returns null", async () => {
			const { h } = await setup({ resolveUnlinkedSubscription: async () => null });
			dashboardSubscription(h);

			expect((await h.deliver(subscriptionEvent("SUBSCRIPTION_CREATED", "sub_dash"))).status).toBe(
				200,
			);

			expect(await h.rows("subscription")).toEqual([]);
		});

		it("retries when the resolver throws", async () => {
			const resolveUnlinkedSubscription = vi.fn();
			const { h } = await setup({ resolveUnlinkedSubscription });
			resolveUnlinkedSubscription
				.mockRejectedValueOnce(new Error("directory unavailable"))
				.mockResolvedValue({ referenceType: "user", referenceId: h.userId });
			dashboardSubscription(h);
			const event = subscriptionEvent("SUBSCRIPTION_CREATED", "sub_dash");

			expect((await h.deliver(event)).status).toBe(500);
			expect((await h.deliver(event)).status).toBe(200);

			expect(await h.rows("subscription")).toMatchObject([{ streampaySubscriptionId: "sub_dash" }]);
		});

		it("dead-letters a resolution whose plan StreamPay does not bill", async () => {
			const { h } = await setup({
				resolveUnlinkedSubscription: async () => ({
					referenceType: "user",
					referenceId: "anyone",
					plan: "enterprise",
				}),
			});
			dashboardSubscription(h);

			expect((await h.deliver(subscriptionEvent("SUBSCRIPTION_CREATED", "sub_dash"))).status).toBe(
				200,
			);

			expect(await h.rows("subscription")).toEqual([]);
			expect(await h.rows("streampayWebhookEvent")).toMatchObject([
				{ status: "dead_letter", lastErrorCode: "SubscriptionCorrelationError" },
			]);
		});

		it("links from renewal evidence and reports the renewal once", async () => {
			const { h, onSubscriptionRenewed } = await setup({
				resolveUnlinkedSubscription: async ({ consumerUser }) =>
					consumerUser ? { referenceType: "user", referenceId: consumerUser.id } : null,
			});
			dashboardSubscription(h, {
				current_cycle_number: 2,
				latest_invoice: { id: "inv_dash_2", status: "COMPLETED" },
			});
			h.stream.getInvoice.mockResolvedValue({
				id: "inv_dash_2",
				subscription_id: "sub_dash",
			} as never);

			expect((await h.deliver(invoiceCompleted("inv_dash_2"))).status).toBe(200);

			expect(await h.rows("subscription")).toMatchObject([
				{ streampaySubscriptionId: "sub_dash", renewedCycleNumber: 2 },
			]);
			expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
		});
	});

	describe("admin link endpoint", () => {
		it("links a subscription, projects its state, and fires no lifecycle callback", async () => {
			const { h, onSubscriptionCreated, onSubscriptionActivated } = await setup();
			dashboardSubscription(h);

			const response = await linkRequest(h, "sub_dash", {
				referenceType: "user",
				referenceId: h.userId,
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ linked: true, reused: false });
			expect(await h.rows("subscription")).toMatchObject([
				{
					streampaySubscriptionId: "sub_dash",
					status: "active",
					activeSlotKey: subscriptionSlotKey("user", h.userId, null),
				},
			]);
			expect(onSubscriptionCreated).not.toHaveBeenCalled();
			expect(onSubscriptionActivated).not.toHaveBeenCalled();
		});

		it("is idempotent for the same reference and refuses a different one", async () => {
			const { h } = await setup();
			dashboardSubscription(h);
			await linkRequest(h, "sub_dash", { referenceType: "user", referenceId: h.userId });

			const again = await linkRequest(h, "sub_dash", {
				referenceType: "user",
				referenceId: h.userId,
			});
			const other = await linkRequest(h, "sub_dash", {
				referenceType: "custom",
				referenceId: "team_9",
			});

			expect(again.status).toBe(200);
			expect(await again.json()).toMatchObject({ reused: true });
			expect(other.status).toBe(409);
		});

		it("refuses when another row holds the reference's billing slot", async () => {
			const { h } = await setup();
			expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
			dashboardSubscription(h);

			const response = await linkRequest(h, "sub_dash", {
				referenceType: "user",
				referenceId: h.userId,
			});

			expect(response.status).toBe(409);
			expect(await h.rows("subscription")).toMatchObject([{ status: "incomplete" }]);
		});

		it("rejects a plan that StreamPay does not bill", async () => {
			const { h } = await setup();
			dashboardSubscription(h);

			const response = await linkRequest(h, "sub_dash", {
				referenceType: "user",
				referenceId: h.userId,
				plan: "enterprise",
			});

			expect(response.status).toBe(400);
		});

		it("requires an admin", async () => {
			const h = await harness([
				subscriptions({ plans: [TEAM] }),
				webhooks({ secret: SECRET }),
				admin({ isAdmin: () => false }),
			]);
			dashboardSubscription(h);

			const response = await linkRequest(h, "sub_dash", {
				referenceType: "user",
				referenceId: h.userId,
			});

			expect(response.status).toBe(403);
		});
	});

	describe("review findings", () => {
		it("does not adopt a reservation named by another app's checkout link", async () => {
			const { h } = await setup({ appId: "this-app" });
			expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
			const [reservation] = await h.rows("subscription");
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_clone", "ACTIVE", {
					latest_invoice: { id: "inv_1", status: "COMPLETED", payment_link_id: "pl_1" },
				}),
			);

			await h.deliver(
				subscriptionEvent("SUBSCRIPTION_ACTIVATED", "sub_clone", {
					...pluginMetadata(h, { streampay_plugin_app_id: "other-app" }),
					streampay_plugin_subscription_row_id: String(reservation?.id),
				}),
			);

			expect(await h.rows("subscription")).toMatchObject([
				{ status: "incomplete", streampaySubscriptionId: null },
			]);
		});

		it("does not ask the resolver about a subscription that carries plugin metadata", async () => {
			const resolveUnlinkedSubscription = vi.fn();
			const { h } = await setup({ resolveUnlinkedSubscription });
			dashboardSubscription(h);

			await h.deliver(
				subscriptionEvent("SUBSCRIPTION_CREATED", "sub_dash", {
					streampay_plugin_app_id: "other-app",
				}),
			);

			expect(resolveUnlinkedSubscription).not.toHaveBeenCalled();
			expect(await h.rows("subscription")).toEqual([]);
		});

		it("keeps the unverified-reference exception to creation events", async () => {
			const onSubscriptionPaymentFailed = vi.fn();
			const { h } = await setup({ onSubscriptionPaymentFailed });
			h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_org", "ACTIVE"));

			await h.deliver(
				subscriptionEvent("SUBSCRIPTION_CYCLE_RENEWAL_FAILED", "sub_org", {
					...pluginMetadata(h),
					streampay_plugin_reference_id: "org_1",
					streampay_plugin_reference_type: "organization",
				}),
			);

			expect(await h.rows("subscription")).toEqual([]);
			expect(onSubscriptionPaymentFailed).not.toHaveBeenCalled();
		});

		it("dead-letters a resolver plan when StreamPay bills no configured product", async () => {
			const { h } = await setup({
				resolveUnlinkedSubscription: async () => ({
					referenceType: "user",
					referenceId: "anyone",
					plan: TEAM.name,
				}),
			});
			dashboardSubscription(h, { items: [{ product_id: "prod_other_app", quantity: 1 }] });

			await h.deliver(subscriptionEvent("SUBSCRIPTION_CREATED", "sub_dash"));

			expect(await h.rows("subscription")).toEqual([]);
			expect(await h.rows("streampayWebhookEvent")).toMatchObject([{ status: "dead_letter" }]);
		});

		it("retries a resolver error even when it carries a client error status", async () => {
			const resolveUnlinkedSubscription = vi.fn();
			const { h } = await setup({ resolveUnlinkedSubscription });
			resolveUnlinkedSubscription
				.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403, body: {} }))
				.mockResolvedValue({ referenceType: "user", referenceId: h.userId });
			dashboardSubscription(h);
			const event = subscriptionEvent("SUBSCRIPTION_CREATED", "sub_dash");

			expect((await h.deliver(event)).status).toBe(500);
			expect((await h.deliver(event)).status).toBe(200);

			expect(await h.rows("subscription")).toMatchObject([{ streampaySubscriptionId: "sub_dash" }]);
		});

		it("refuses an admin link when another admin linked the subscription meanwhile", async () => {
			const { h } = await setup();
			dashboardSubscription(h);
			const adapter = (await h.auth.$context).adapter as unknown as {
				findOne: (input: { model: string; where: Array<{ field: string }> }) => Promise<unknown>;
			};
			const findOne = adapter.findOne.bind(adapter);
			let raced = false;
			vi.spyOn(adapter, "findOne").mockImplementation(async (input) => {
				const row = await findOne(input);
				if (!raced && input.model === "subscription" && input.where[0]?.field === "activeSlotKey") {
					raced = true;
					await linkRequest(h, "sub_dash", { referenceType: "custom", referenceId: "team_9" });
				}
				return row;
			});

			const response = await linkRequest(h, "sub_dash", {
				referenceType: "user",
				referenceId: h.userId,
			});

			expect(response.status).toBe(409);
			expect(await h.rows("subscription")).toMatchObject([
				{ referenceType: "custom", referenceId: "team_9" },
			]);
		});

		it("does not release a checkout that takes the slot during an admin link", async () => {
			const { h } = await setup();
			dashboardSubscription(h);
			const adapter = (await h.auth.$context).adapter as unknown as {
				findOne: (input: { model: string; where: Array<{ field: string }> }) => Promise<unknown>;
			};
			const findOne = adapter.findOne.bind(adapter);
			let raced = false;
			vi.spyOn(adapter, "findOne").mockImplementation(async (input) => {
				const row = await findOne(input);
				if (!raced && input.model === "subscription" && input.where[0]?.field === "activeSlotKey") {
					raced = true;
					expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
				}
				return row;
			});

			const response = await linkRequest(h, "sub_dash", {
				referenceType: "user",
				referenceId: h.userId,
			});

			expect(response.status).toBe(409);
			expect(await h.rows("subscription")).toMatchObject([
				{ status: "incomplete", streampaySubscriptionId: null },
			]);
		});

		it("does not release a checkout when a webhook links the subscription during an admin link", async () => {
			const { h } = await setup();
			dashboardSubscription(h);
			const context = await h.auth.$context;
			const adapter = context.adapter as unknown as {
				findOne: (input: { model: string; where: Array<{ field: string }> }) => Promise<unknown>;
			};
			const findOne = adapter.findOne.bind(adapter);
			let raced = false;
			vi.spyOn(adapter, "findOne").mockImplementation(async (input) => {
				const row = await findOne(input);
				if (!raced && input.model === "subscription" && input.where[0]?.field === "activeSlotKey") {
					raced = true;
					await context.adapter.create({
						model: "subscription",
						data: {
							referenceId: h.userId,
							referenceType: "user",
							activeSlotKey: null,
							streampaySubscriptionId: "sub_dash",
							plan: TEAM.name,
							productId: TEAM.productId,
							group: null,
							seats: 1,
							status: "canceled",
							billingStatus: "current",
							createdAt: new Date(),
							updatedAt: new Date(),
						},
					});
					expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
				}
				return row;
			});

			const response = await linkRequest(h, "sub_dash", {
				referenceType: "user",
				referenceId: h.userId,
			});

			expect(response.status).toBe(200);
			const rows = await h.rows("subscription");
			expect(rows.find((row) => row.streampaySubscriptionId === null)).toMatchObject({
				status: "incomplete",
				activeSlotKey: subscriptionSlotKey("user", h.userId, null),
			});
		});
	});
});
