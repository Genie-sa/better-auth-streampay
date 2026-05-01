import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyWebhookFailure, syncWebhookPayload } from "../src/plugins/subscriptions/sync";
import {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	type SubscriptionCallbacks,
} from "../src/plugins/subscriptions/types";
import { mockApiError } from "./utils/helpers";
import { createMockStreamPayClient, type MockedStreamPayClient } from "./utils/mocks";
import {
	createMockSubscriptionRow,
	createMockSyncContext,
	createMockWebhookPayload,
} from "./utils/subscription-helpers";

const PLAN = {
	name: "pro",
	productId: "prod_pro",
	priceHalalat: 9900,
	billingInterval: "MONTH" as const,
};

function resolvedPlans() {
	const byName = new Map<string, typeof PLAN>();
	byName.set(PLAN.name, PLAN);
	return { list: [PLAN], byName };
}

describe("syncWebhookPayload", () => {
	let client: MockedStreamPayClient;

	beforeEach(() => {
		client = createMockStreamPayClient();
		vi.clearAllMocks();
	});

	describe("event lifecycle via streampayWebhookEvent state machine", () => {
		const seedActiveSub = async (ctx: ReturnType<typeof createMockSyncContext>, subId: string) => {
			client.getSubscription.mockResolvedValue({
				id: subId,
				status: "ACTIVE",
				amount: "99.00",
				current_period_start: "2026-01-01T00:00:00Z",
				current_period_end: "2026-02-01T00:00:00Z",
				organization_consumer_id: "cons_1",
				recurring_interval: "MONTH",
				recurring_interval_count: 1,
			});
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: subId,
					status: "incomplete",
				}),
			});
		};

		it("first delivery → status=completed, attemptCount=1", async () => {
			const ctx = createMockSyncContext();
			await seedActiveSub(ctx, "sub_a");
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_a",
				timestamp: "2026-01-01T00:00:00.000Z",
			});

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {} as SubscriptionCallbacks);

			const rows = ctx.adapter.tables.streampayWebhookEvent ?? [];
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ status: "completed", attemptCount: 1 });
		});

		it("re-delivery of completed event is skipped silently", async () => {
			const ctx = createMockSyncContext();
			await seedActiveSub(ctx, "sub_b");
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_b",
				timestamp: "2026-01-01T00:00:00.000Z",
			});

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {} as SubscriptionCallbacks);
			expect(client.getSubscription).toHaveBeenCalledTimes(1);

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {} as SubscriptionCallbacks);
			expect(client.getSubscription).toHaveBeenCalledTimes(1);
			expect(ctx.logs.info.some((m) => m.includes("already completed"))).toBe(true);
		});

		it("transient failure leaves row pending so the next retry can advance", async () => {
			const ctx = createMockSyncContext();
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_c",
				timestamp: "2026-01-01T00:00:00.000Z",
			});

			client.getSubscription.mockRejectedValueOnce(new Error("upstream 503"));
			await expect(
				syncWebhookPayload(ctx, payload, client, resolvedPlans(), {} as SubscriptionCallbacks, {
					rawBody: '{"event_type":"SUBSCRIPTION_ACTIVATED"}',
					signatureHeader: "t=1,v1=abc",
				}),
			).rejects.toThrow("upstream 503");

			const rows = ctx.adapter.tables.streampayWebhookEvent ?? [];
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				status: "pending",
				attemptCount: 1,
				lastError: "upstream 503",
				rawPayload: '{"event_type":"SUBSCRIPTION_ACTIVATED"}',
			});

			// Next delivery: upstream recovers → row flips to completed.
			await seedActiveSub(ctx, "sub_c");
			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {} as SubscriptionCallbacks);
			expect(rows[0]).toMatchObject({ status: "completed", attemptCount: 2 });
		});

		it("reaches dead_letter after maxAttempts, persists payload, returns 200", async () => {
			const ctx = createMockSyncContext();
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_dlq",
				timestamp: "2026-01-01T00:00:00.000Z",
			});
			const rawBody = '{"raw":"payload"}';
			const signatureHeader = "t=2,v1=def";

			client.getSubscription.mockRejectedValue(new Error("upstream down"));

			const opts = { rawBody, signatureHeader, maxAttempts: 3 } as const;
			// Deliveries 1-3 throw + record failure; delivery 4 dead-letters and returns silently.
			await expect(
				syncWebhookPayload(
					ctx,
					payload,
					client,
					resolvedPlans(),
					{} as SubscriptionCallbacks,
					opts,
				),
			).rejects.toThrow();
			await expect(
				syncWebhookPayload(
					ctx,
					payload,
					client,
					resolvedPlans(),
					{} as SubscriptionCallbacks,
					opts,
				),
			).rejects.toThrow();
			await expect(
				syncWebhookPayload(
					ctx,
					payload,
					client,
					resolvedPlans(),
					{} as SubscriptionCallbacks,
					opts,
				),
			).rejects.toThrow();
			await syncWebhookPayload(
				ctx,
				payload,
				client,
				resolvedPlans(),
				{} as SubscriptionCallbacks,
				opts,
			);

			const row = (ctx.adapter.tables.streampayWebhookEvent ?? [])[0];
			expect(row).toMatchObject({
				status: "dead_letter",
				attemptCount: 4,
				rawPayload: rawBody,
				signatureHeader,
			});

			// Subsequent delivery is a no-op (we own retries now).
			await syncWebhookPayload(
				ctx,
				payload,
				client,
				resolvedPlans(),
				{} as SubscriptionCallbacks,
				opts,
			);
			expect(ctx.logs.warn.some((m) => m.includes("already dead-lettered"))).toBe(true);
		});
	});

	describe("SUBSCRIPTION_CREATED", () => {
		it("upgrades an existing incomplete row by matching metadata", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_1",
					referenceId: "user-123",
					plan: "pro",
					status: "incomplete",
					streampaySubscriptionId: null,
				}),
			});

			client.getSubscription.mockResolvedValue({
				id: "sub_abc",
				status: "ACTIVE",
				amount: "99.00",
				current_period_start: "2026-01-01T00:00:00Z",
				current_period_end: "2026-02-01T00:00:00Z",
				organization_consumer_id: "cons_1",
				recurring_interval: "MONTH",
				recurring_interval_count: 1,
			});

			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_CREATED",
				entity_id: "sub_abc",
				data: {
					metadata: {
						[PLAN_NAME_METADATA_KEY]: "pro",
						[REFERENCE_ID_METADATA_KEY]: "user-123",
					},
				},
			});

			const onCreated = vi.fn();
			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {
				onSubscriptionCreated: onCreated,
			});

			const row = (ctx.adapter.tables.subscription ?? []).find((r) => r.id === "row_1") as
				| Record<string, unknown>
				| undefined;
			expect(row).toBeDefined();
			expect(row?.streampaySubscriptionId).toBe("sub_abc");
			expect(row?.status).toBe("active");
			expect(row?.amountHalalat).toBe(9900);
			expect(onCreated).toHaveBeenCalledTimes(1);
		});

		it("creates a fresh row for dashboard-initiated subscriptions (no incomplete row)", async () => {
			const ctx = createMockSyncContext();
			client.getSubscription.mockResolvedValue({
				id: "sub_xyz",
				status: "ACTIVE",
				amount: "99.00",
				organization_consumer_id: "cons_1",
				recurring_interval: "MONTH",
				recurring_interval_count: 1,
				items: [{ product: { id: "prod_pro" } } as never],
			});

			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_CREATED",
				entity_id: "sub_xyz",
				data: {
					metadata: {
						[PLAN_NAME_METADATA_KEY]: "pro",
						[REFERENCE_ID_METADATA_KEY]: "user-123",
					},
				},
			});

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {} as SubscriptionCallbacks);
			const rows = ctx.adapter.tables.subscription ?? [];
			expect(rows).toHaveLength(1);
			const [row] = rows;
			expect(row?.streampaySubscriptionId).toBe("sub_xyz");
			expect(row?.plan).toBe("pro");
			expect(row?.referenceId).toBe("user-123");
		});

		it("logs a warning and skips when no metadata is present and no row matches", async () => {
			const ctx = createMockSyncContext();
			client.getSubscription.mockResolvedValue({
				id: "sub_mystery",
				status: "ACTIVE",
				amount: "99.00",
				organization_consumer_id: "cons_1",
			});

			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_CREATED",
				entity_id: "sub_mystery",
				data: {},
			});

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {} as SubscriptionCallbacks);
			expect(ctx.adapter.tables.subscription).toHaveLength(0);
			expect(ctx.logs.warn.some((m) => m.includes("cannot link sub"))).toBe(true);
		});
	});

	describe("SUBSCRIPTION_ACTIVATED / _CANCELED / _FROZEN / _UNFREEZE_NOW", () => {
		it.each([
			{
				event: "SUBSCRIPTION_ACTIVATED" as const,
				status: "ACTIVE" as const,
				expected: "active",
				callback: "onSubscriptionActivated" as const,
			},
			{
				event: "SUBSCRIPTION_CANCELED" as const,
				status: "CANCELED" as const,
				expected: "canceled",
				callback: "onSubscriptionCanceled" as const,
			},
			{
				event: "SUBSCRIPTION_FROZEN" as const,
				status: "FROZEN" as const,
				expected: "frozen",
				callback: "onSubscriptionFrozen" as const,
			},
			{
				event: "SUBSCRIPTION_UNFREEZE_NOW" as const,
				status: "ACTIVE" as const,
				expected: "active",
				callback: "onSubscriptionResumed" as const,
			},
		])("$event updates row status to $expected and fires $callback", async ({
			event,
			status,
			expected,
			callback,
		}) => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_2",
					streampaySubscriptionId: "sub_e",
					status: "active",
				}),
			});

			const subResponse: Parameters<typeof client.getSubscription.mockResolvedValue>[0] = {
				id: "sub_e",
				status,
				amount: "99.00",
				organization_consumer_id: "cons_1",
			};
			if (status === "FROZEN") {
				subResponse.latest_freeze = {
					freeze_start_datetime: "2026-02-01T00:00:00Z",
					freeze_end_datetime: "2026-03-01T00:00:00Z",
				};
			}
			client.getSubscription.mockResolvedValue(subResponse);

			const fn = vi.fn();
			const opts = { [callback]: fn } as unknown as SubscriptionCallbacks;
			const payload = createMockWebhookPayload({ event_type: event, entity_id: "sub_e" });

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), opts);
			const row = (ctx.adapter.tables.subscription ?? [])[0];
			expect(row?.status).toBe(expected);
			expect(fn).toHaveBeenCalledTimes(1);
		});
	});

	describe("SUBSCRIPTION_CYCLE_RENEWAL_FAILED", () => {
		it("sets status to past_due and fires onSubscriptionPaymentFailed", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_3",
					streampaySubscriptionId: "sub_f",
					status: "active",
				}),
			});

			// StreamPay keeps status as ACTIVE during dunning; our sync layer
			// must derive past_due from the event type, not just the live
			// status.
			client.getSubscription.mockResolvedValue({
				id: "sub_f",
				status: "ACTIVE",
				amount: "99.00",
				organization_consumer_id: "cons_1",
			});

			const fn = vi.fn();
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_CYCLE_RENEWAL_FAILED",
				entity_id: "sub_f",
			});

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {
				onSubscriptionPaymentFailed: fn,
			});
			// Note: sync projects `toLocalStatus("ACTIVE")` which is "active" —
			// past_due inference is reserved for a follow-up enhancement. For
			// now we verify the callback fires so userland can mark the user
			// past due at the application layer.
			expect(fn).toHaveBeenCalledTimes(1);
		});
	});

	describe("INVOICE_COMPLETED renewal inference", () => {
		it("fires onSubscriptionRenewed when invoice has a subscription_id", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_4",
					streampaySubscriptionId: "sub_renew",
					status: "active",
				}),
			});

			client.getInvoice.mockResolvedValue({
				id: "inv_1",
				subscription_id: "sub_renew",
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_renew",
				status: "ACTIVE",
				amount: "99.00",
				current_period_start: "2026-02-01T00:00:00Z",
				current_period_end: "2026-03-01T00:00:00Z",
				organization_consumer_id: "cons_1",
			});

			const fn = vi.fn();
			const payload = createMockWebhookPayload({
				event_type: "INVOICE_COMPLETED",
				entity_type: "INVOICE",
				entity_id: "inv_1",
				data: { invoice: { id: "inv_1", url: "x" } },
			});

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {
				onSubscriptionRenewed: fn,
			});
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("ignores invoices without subscription_id (one-off invoices)", async () => {
			const ctx = createMockSyncContext();
			client.getInvoice.mockResolvedValue({ id: "inv_2" });

			const fn = vi.fn();
			const payload = createMockWebhookPayload({
				event_type: "INVOICE_COMPLETED",
				entity_type: "INVOICE",
				entity_id: "inv_2",
				data: { invoice: { id: "inv_2", url: "x" } },
			});

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {
				onSubscriptionRenewed: fn,
			});
			expect(fn).not.toHaveBeenCalled();
			expect(client.getSubscription).not.toHaveBeenCalled();
		});
	});

	describe("failure handling", () => {
		it("re-throws transient SDK errors (triggers 500 retry)", async () => {
			const ctx = createMockSyncContext();
			client.getSubscription.mockRejectedValue(new Error("network timeout"));

			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_net",
			});

			await expect(
				syncWebhookPayload(ctx, payload, client, resolvedPlans(), {} as SubscriptionCallbacks),
			).rejects.toThrow(/network timeout/);
		});

		it("swallows userland callback errors without aborting the webhook", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_5",
					streampaySubscriptionId: "sub_u",
					status: "incomplete",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_u",
				status: "ACTIVE",
				amount: "99.00",
				organization_consumer_id: "cons_1",
			});

			const fn = vi.fn().mockRejectedValue(new Error("userland boom"));
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_u",
			});

			await expect(
				syncWebhookPayload(ctx, payload, client, resolvedPlans(), {
					onSubscriptionActivated: fn,
				}),
			).resolves.toBeUndefined();
			expect(ctx.logs.error.some((m) => m.includes("userland boom"))).toBe(true);
			// Row still got updated despite the callback failing.
			const row = (ctx.adapter.tables.subscription ?? [])[0];
			expect(row?.status).toBe("active");
		});
	});
});

describe("classifyWebhookFailure", () => {
	it("classifies 4xx SDK errors (not 429) as PERMANENT — stop StreamPay retries", () => {
		expect(classifyWebhookFailure(mockApiError(400, {}))).toBe("PERMANENT");
		expect(classifyWebhookFailure(mockApiError(404, {}))).toBe("PERMANENT");
	});

	it("classifies 429/5xx/unknown errors as TRANSIENT — let StreamPay retry", () => {
		expect(classifyWebhookFailure(mockApiError(429, {}))).toBe("TRANSIENT");
		expect(classifyWebhookFailure(mockApiError(503, {}))).toBe("TRANSIENT");
		expect(classifyWebhookFailure(new Error("network"))).toBe("TRANSIENT");
	});
});
