import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { subscriptions, webhooks } from "../../src";
import {
	type SyncContext,
	syncWebhookPayload,
	type WebhookEventRow,
} from "../../src/plugins/subscriptions/sync";
import { createStreamPayTestInstance } from "../utils/auth-instance";
import { createMockWebhookPayload } from "../utils/subscription-helpers";

const plan = {
	name: "pro",
	productId: "known",
	priceInSmallestUnit: 100,
	billingInterval: "MONTH" as const,
};
const plans = { list: [plan], byName: new Map([[plan.name, plan]]) };

describe("generic callback retry exhaustion", () => {
	it("dead-letters the fifth failed attempt without requiring a sixth delivery", async () => {
		const callback = vi.fn().mockRejectedValue(new Error("Callback unavailable"));
		const secret = "webhook-audit-test-secret";
		const { auth } = await createStreamPayTestInstance({
			use: [webhooks({ secret, deduplicate: true, onPayload: callback })],
		});
		const payload = createMockWebhookPayload({
			event_type: "PAYMENT_SUCCEEDED",
			entity_type: "PAYMENT",
			entity_id: "retry-exhaustion-payment",
		});
		const rawBody = JSON.stringify(payload);
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
		const send = () =>
			auth.handler(
				new Request("http://localhost:3000/api/auth/streampay/webhooks", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-webhook-signature": `t=${timestamp},v1=${signature}`,
					},
					body: rawBody,
				}),
			);
		const context = await auth.$context;
		const eventId = `handlers:${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
		for (let attempt = 1; attempt <= 5; attempt++) {
			expect((await send()).status).toBe(500);
			expect(
				await context.adapter.findOne<WebhookEventRow>({
					model: "streampayWebhookEvent",
					where: [{ field: "eventId", value: eventId }],
				}),
			).toMatchObject({
				attemptCount: attempt,
				status: attempt < 5 ? "pending" : "dead_letter",
				rawPayload: rawBody,
				lockedBy: null,
			});
		}
		expect((await send()).status).toBe(200);
		expect(callback).toHaveBeenCalledTimes(5);
	});
});

async function renewalFixture() {
	const { auth, streamPayClient } = await createStreamPayTestInstance({
		use: [subscriptions({ plans: [plan] })],
	});
	const ctx: SyncContext = { context: (await auth.$context) as SyncContext["context"] };
	await ctx.context.adapter.create({
		model: "subscription",
		data: {
			referenceId: "owner",
			plan: plan.name,
			status: "active",
			streampaySubscriptionId: "renewal-audit",
			periodEnd: new Date("2026-02-01T00:00:00Z"),
			currentCycleNumber: 1,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	streamPayClient.getSubscription.mockResolvedValue({
		id: "renewal-audit",
		status: "ACTIVE",
		organization_consumer_id: "consumer",
		items: [{ product_id: plan.productId, quantity: 1 }],
		current_period_end: "2026-03-01T00:00:00Z",
		current_cycle_number: 2,
	});
	const payload = createMockWebhookPayload({
		event_type: "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
		entity_id: "renewal-audit",
	});
	return { ctx, streamPayClient, payload };
}

describe("renewal callback recovery at the persistence boundary", () => {
	it("retries a stale provider snapshot without restoring canceled access", async () => {
		const { ctx, streamPayClient, payload } = await renewalFixture();
		await ctx.context.adapter.update({
			model: "subscription",
			where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
			update: { status: "canceled", providerUpdatedAt: new Date("2026-02-01T00:00:00Z") },
		});
		streamPayClient.getSubscription.mockResolvedValue({
			id: "renewal-audit",
			status: "ACTIVE",
			updated_at: "2026-01-01T00:00:00Z",
			organization_consumer_id: "consumer",
			items: [{ product_id: plan.productId, quantity: 1 }],
			current_period_end: "2026-03-01T00:00:00Z",
			current_cycle_number: 2,
		});
		const callback = vi.fn();
		await expect(
			syncWebhookPayload(
				ctx,
				payload,
				streamPayClient,
				plans,
				{
					onSubscriptionRenewed: callback,
				},
				{ rawBody: JSON.stringify(payload) },
			),
		).rejects.toThrow(/stale subscription state/);
		expect(callback).not.toHaveBeenCalled();
		expect(
			await ctx.context.adapter.findOne({
				model: "subscription",
				where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
			}),
		).toMatchObject({ status: "canceled", currentCycleNumber: 1 });
	});

	it("does not overwrite cancellation that commits between a renewal read and update", async () => {
		const { ctx, streamPayClient, payload } = await renewalFixture();
		let canceled = false;
		const racing: SyncContext = {
			context: {
				...ctx.context,
				adapter: {
					...ctx.context.adapter,
					update: async <T>(input: Parameters<SyncContext["context"]["adapter"]["update"]>[0]) => {
						if (input.model === "subscription" && !canceled) {
							canceled = true;
							await ctx.context.adapter.update({
								model: "subscription",
								where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
								update: { status: "canceled", providerUpdatedAt: new Date("2026-02-01T00:00:00Z") },
							});
						}
						return ctx.context.adapter.update<T, object>(input);
					},
				},
			},
		};
		const callback = vi.fn();
		const rawBody = JSON.stringify(payload);
		await expect(
			syncWebhookPayload(
				racing,
				payload,
				streamPayClient,
				plans,
				{
					onSubscriptionRenewed: callback,
				},
				{ rawBody },
			),
		).rejects.toThrow(/changed during renewal reconciliation/);
		expect(callback).not.toHaveBeenCalled();
		expect(
			await ctx.context.adapter.findOne({
				model: "subscription",
				where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
			}),
		).toMatchObject({ status: "canceled", currentCycleNumber: 1 });
		expect(
			await ctx.context.adapter.findOne<WebhookEventRow>({
				model: "streampayWebhookEvent",
				where: [
					{
						field: "eventId",
						value: `${payload.event_type}:${payload.entity_id}:${payload.timestamp}`,
					},
				],
			}),
		).toMatchObject({ status: "pending", rawPayload: rawBody });
	});

	it("keeps recovery retryable when lifecycle reconciliation wins the cycle update race", async () => {
		const { ctx, streamPayClient, payload } = await renewalFixture();
		const callback = vi.fn().mockRejectedValueOnce(new Error("Retry me"));
		const options = { rawBody: JSON.stringify(payload), signatureHeader: "verified" };
		await expect(
			syncWebhookPayload(
				ctx,
				payload,
				streamPayClient,
				plans,
				{
					onSubscriptionRenewed: callback,
				},
				options,
			),
		).rejects.toThrow("Retry me");
		let changed = false;
		const racing: SyncContext = {
			context: {
				...ctx.context,
				adapter: {
					...ctx.context.adapter,
					update: async <T>(input: Parameters<SyncContext["context"]["adapter"]["update"]>[0]) => {
						if (input.model === "subscription" && !changed) {
							changed = true;
							await ctx.context.adapter.update({
								model: "subscription",
								where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
								update: { currentCycleNumber: 3, periodEnd: new Date("2026-04-01T00:00:00Z") },
							});
						}
						return ctx.context.adapter.update<T, object>(input);
					},
				},
			},
		};
		await expect(
			syncWebhookPayload(
				racing,
				payload,
				streamPayClient,
				plans,
				{
					onSubscriptionRenewed: callback,
				},
				options,
			),
		).rejects.toThrow(/changed during callback recovery/);
		const eventId = `${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
		expect(
			await ctx.context.adapter.findOne<WebhookEventRow>({
				model: "streampayWebhookEvent",
				where: [{ field: "eventId", value: eventId }],
			}),
		).toMatchObject({ status: "pending", rawPayload: options.rawBody });
		await syncWebhookPayload(
			ctx,
			payload,
			streamPayClient,
			plans,
			{
				onSubscriptionRenewed: callback,
			},
			options,
		);
		expect(callback).toHaveBeenCalledTimes(2);
	});

	it("retains a failed cycle's owner until recovery, then delivers the next cycle separately", async () => {
		const { ctx, streamPayClient, payload } = await renewalFixture();
		const callback = vi.fn().mockRejectedValueOnce(new Error("Retry me"));
		const options = { rawBody: JSON.stringify(payload), signatureHeader: "verified" };
		await expect(
			syncWebhookPayload(
				ctx,
				payload,
				streamPayClient,
				plans,
				{
					onSubscriptionRenewed: callback,
				},
				options,
			),
		).rejects.toThrow("Retry me");
		const eventId = `${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
		streamPayClient.getSubscription.mockResolvedValue({
			id: "renewal-audit",
			status: "ACTIVE",
			organization_consumer_id: "consumer",
			items: [{ product_id: plan.productId, quantity: 1 }],
			current_period_end: "2026-04-01T00:00:00Z",
			current_cycle_number: 3,
		});
		const nextPayload = { ...payload, timestamp: "2026-03-01T00:00:00Z" };
		await expect(
			syncWebhookPayload(
				ctx,
				nextPayload,
				streamPayClient,
				plans,
				{
					onSubscriptionRenewed: callback,
				},
				{ ...options, rawBody: JSON.stringify(nextPayload) },
			),
		).rejects.toThrow(/callback .* pending/);
		expect(
			await ctx.context.adapter.findOne({
				model: "subscription",
				where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
			}),
		).toMatchObject({ currentCycleNumber: 2, renewalCallbackEventId: eventId });
		await syncWebhookPayload(
			ctx,
			payload,
			streamPayClient,
			plans,
			{
				onSubscriptionRenewed: callback,
			},
			options,
		);
		expect(callback).toHaveBeenCalledTimes(2);
		expect(callback.mock.calls[1]?.[0].subscription.currentCycleNumber).toBe(2);
		await syncWebhookPayload(
			ctx,
			nextPayload,
			streamPayClient,
			plans,
			{
				onSubscriptionRenewed: callback,
			},
			{ ...options, rawBody: JSON.stringify(nextPayload) },
		);
		expect(callback).toHaveBeenCalledTimes(3);
		expect(callback.mock.calls[2]?.[0].subscription.currentCycleNumber).toBe(3);
		expect(
			await ctx.context.adapter.findOne({
				model: "subscription",
				where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
			}),
		).toMatchObject({ currentCycleNumber: 3, renewalCallbackEventId: null });
	});

	it("clears callback ownership when retryOnCallbackError is explicitly disabled", async () => {
		const { ctx, streamPayClient, payload } = await renewalFixture();
		const callback = vi.fn().mockRejectedValue(new Error("Intentionally acknowledged"));
		await syncWebhookPayload(
			ctx,
			payload,
			streamPayClient,
			plans,
			{
				onSubscriptionRenewed: callback,
			},
			{ retryOnCallbackError: false },
		);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(
			await ctx.context.adapter.findOne({
				model: "subscription",
				where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
			}),
		).toMatchObject({ renewalCallbackEventId: null });
	});

	it.each([
		"lost update response",
		"worker crash",
	])("delivers the renewal callback after %s following a committed cycle update", async (failure) => {
		const { ctx, streamPayClient, payload } = await renewalFixture();
		const callback = vi.fn();
		const interrupted: SyncContext = {
			context: {
				...ctx.context,
				adapter: {
					...ctx.context.adapter,
					update: async <T>(input: Parameters<SyncContext["context"]["adapter"]["update"]>[0]) => {
						// Real database commit, then an uncertain response before callback invocation.
						if (input.model === "subscription") {
							await ctx.context.adapter.update(input);
							throw new Error("Connection lost after committed cycle update");
						}
						// A killed worker also cannot persist its catch/failure handler.
						if (failure === "worker crash") throw new Error("Worker terminated");
						return ctx.context.adapter.update<T, object>(input);
					},
				},
			},
		};
		const options = { rawBody: JSON.stringify(payload), signatureHeader: "verified" };
		await expect(
			syncWebhookPayload(
				interrupted,
				payload,
				streamPayClient,
				plans,
				{
					onSubscriptionRenewed: callback,
				},
				options,
			),
		).rejects.toThrow();
		expect(callback).not.toHaveBeenCalled();
		expect(
			await ctx.context.adapter.findOne({
				model: "subscription",
				where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
			}),
		).toMatchObject({ currentCycleNumber: 2 });
		const eventId = `${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
		await ctx.context.adapter.update({
			model: "streampayWebhookEvent",
			where: [{ field: "eventId", value: eventId }],
			update: { lockedAt: new Date(0) },
		});
		await syncWebhookPayload(
			ctx,
			payload,
			streamPayClient,
			plans,
			{
				onSubscriptionRenewed: callback,
			},
			options,
		);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(
			await ctx.context.adapter.findOne({
				model: "subscription",
				where: [{ field: "streampaySubscriptionId", value: "renewal-audit" }],
			}),
		).toMatchObject({ renewalCallbackEventId: null });
		expect(
			await ctx.context.adapter.findOne<WebhookEventRow>({
				model: "streampayWebhookEvent",
				where: [{ field: "eventId", value: eventId }],
			}),
		).toMatchObject({ status: "completed", rawPayload: null });
	});
});
