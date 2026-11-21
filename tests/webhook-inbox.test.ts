import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import { type StreamPayPluginRegistry, subscriptions } from "../src/plugins/subscriptions";
import { syncWebhookPayload } from "../src/plugins/subscriptions/sync";
import { webhooks } from "../src/plugins/webhooks";
import type { StreamPayWebhookEnvelope } from "../src/webhooks/events";
import {
	createWebhookInbox,
	deliverWebhookEvent,
	findDueWebhookEvents,
	WEBHOOK_PROCESSING_LEASE_MS,
	type WebhookEventRow,
	type WebhookInboxScope,
} from "../src/webhooks/inbox";
import { createTestStreamPayOptions } from "./utils/helpers";
import { createMockStreamPayClient } from "./utils/mocks";
import {
	createMockSubscriptionRow,
	createMockSyncContext,
	createMockWebhookPayload,
} from "./utils/subscription-helpers";

const PLAN = {
	name: "pro",
	productId: "prod_pro",
	priceInSmallestUnit: 9900,
	billingInterval: "MONTH" as const,
};

const newMockSyncContext = () => createMockSyncContext();
type MockSyncContext = ReturnType<typeof newMockSyncContext>;

function eventRows(ctx: MockSyncContext): WebhookEventRow[] {
	return (ctx.adapter.tables.streampayWebhookEvent ?? []) as unknown as WebhookEventRow[];
}

async function seedEvent(ctx: MockSyncContext, row: Partial<WebhookEventRow>): Promise<void> {
	await ctx.adapter.create({
		model: "streampayWebhookEvent",
		data: {
			eventType: "PAYMENT_SUCCEEDED",
			status: "pending",
			attemptCount: 1,
			receivedAt: new Date(),
			lockedAt: null,
			lockedBy: null,
			nextAttemptAt: null,
			rawPayload: null,
			lastError: null,
			lastErrorCode: null,
			...row,
		},
	});
}

function scope(overrides: Partial<WebhookInboxScope> = {}): WebhookInboxScope {
	return {
		eventIdPrefix: "handlers",
		maxAttempts: 5,
		isPermanentFailure: () => false,
		prepare: () => async () => {},
		...overrides,
	};
}

function asEndpointContext(ctx: MockSyncContext): GenericEndpointContext {
	return ctx as unknown as GenericEndpointContext;
}

describe("webhook inbox", () => {
	describe("replay routing", () => {
		it("never replays a handlers: event through subscription sync when generic dedupe is off", async () => {
			const client = createMockStreamPayClient();
			const onSubscriptionActivated = vi.fn();
			const registry: StreamPayPluginRegistry = {};
			const options = createTestStreamPayOptions({ client });
			subscriptions({ plans: [PLAN], onSubscriptionActivated })(options, registry);
			webhooks({ secret: "test-only-secret", onPayload: vi.fn() })(options, registry);
			const ctx = createMockSyncContext();
			const payload = createMockWebhookPayload({ event_type: "SUBSCRIPTION_ACTIVATED" });
			await seedEvent(ctx, {
				eventId: "handlers:left-over",
				eventType: payload.event_type,
				rawPayload: JSON.stringify(payload),
			});

			await expect(
				registry.replayWebhookEvent?.(asEndpointContext(ctx), "handlers:left-over"),
			).rejects.toMatchObject({ status: "BAD_REQUEST" });

			expect(client.getSubscription).not.toHaveBeenCalled();
			expect(onSubscriptionActivated).not.toHaveBeenCalled();
			expect(eventRows(ctx)[0]).toMatchObject({
				status: "pending",
				rawPayload: JSON.stringify(payload),
				lastErrorCode: "WEBHOOK_INBOX_SCOPE_DISABLED",
			});
		});

		it("routes replay to the scope that owns the prefix regardless of plugin order", async () => {
			const onPayload = vi.fn();
			const registry: StreamPayPluginRegistry = {};
			const options = createTestStreamPayOptions();
			webhooks({ secret: "test-only-secret", deduplicate: true, onPayload })(options, registry);
			subscriptions({ plans: [PLAN] })(options, registry);
			const ctx = createMockSyncContext();
			const payload = createMockWebhookPayload({ event_type: "PAYMENT_SUCCEEDED" });
			await seedEvent(ctx, { eventId: "handlers:payment", rawPayload: JSON.stringify(payload) });

			await expect(
				registry.replayWebhookEvent?.(asEndpointContext(ctx), "handlers:payment"),
			).resolves.toEqual({ replayed: true, eventId: "handlers:payment" });

			expect(onPayload).toHaveBeenCalledWith(payload);
			expect(eventRows(ctx)[0]).toMatchObject({ status: "completed", rawPayload: null });
		});
	});

	describe("delivery", () => {
		it("dead-letters a generic handler event after its configured attempt budget", async () => {
			const ctx = createMockSyncContext();
			const handlers = scope({
				maxAttempts: 2,
				prepare: () => async () => {
					throw new Error("handler down");
				},
			});
			const payload = createMockWebhookPayload({ event_type: "PAYMENT_SUCCEEDED" });
			const request = { rawBody: JSON.stringify(payload), signatureHeader: "sig" };

			await expect(deliverWebhookEvent(ctx, handlers, payload, request)).rejects.toThrow();
			expect(eventRows(ctx)[0]).toMatchObject({ status: "pending", attemptCount: 1 });
			await expect(deliverWebhookEvent(ctx, handlers, payload, request)).rejects.toThrow();

			expect(eventRows(ctx)[0]).toMatchObject({ status: "dead_letter", attemptCount: 2 });
		});

		it("rejects a non-positive or fractional webhooks({ maxWebhookAttempts })", () => {
			expect(() => webhooks({ secret: "s", maxWebhookAttempts: 0 })).toThrow(/maxWebhookAttempts/);
			expect(() => webhooks({ secret: "s", maxWebhookAttempts: 1.5 })).toThrow(
				/maxWebhookAttempts/,
			);
		});

		it("does not create an inbox row for an event the scope does not handle", async () => {
			const ctx = createMockSyncContext();

			const outcome = await deliverWebhookEvent(
				ctx,
				scope({ prepare: () => null }),
				createMockWebhookPayload(),
				{ rawBody: "{}", signatureHeader: null },
			);

			expect(outcome).toBe("ignored");
			expect(eventRows(ctx)).toHaveLength(0);
		});

		it("fences a generic handler worker whose lease was taken over by a redelivery", async () => {
			const ctx = createMockSyncContext();
			const payload = createMockWebhookPayload({ event_type: "PAYMENT_SUCCEEDED" });
			const request = { rawBody: JSON.stringify(payload), signatureHeader: null };
			let releaseFirst: () => void = () => {};
			const firstRunning = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			let secondLock: string | null = null;
			let runs = 0;
			const handlers = scope({
				prepare: () => async () => {
					runs += 1;
					if (runs === 1) {
						await firstRunning;
						return;
					}
					secondLock = eventRows(ctx)[0]?.lockedBy ?? null;
					await new Promise<never>(() => {});
				},
			});

			const first = deliverWebhookEvent(ctx, handlers, payload, request);
			await vi.waitFor(() => expect(runs).toBe(1));
			const row = eventRows(ctx)[0];
			if (!row) throw new Error("expected an inbox row");
			row.lockedAt = new Date(Date.now() - WEBHOOK_PROCESSING_LEASE_MS - 1);
			void deliverWebhookEvent(ctx, handlers, payload, request);
			await vi.waitFor(() => expect(runs).toBe(2));
			releaseFirst();
			await first;

			expect(eventRows(ctx)[0]).toMatchObject({ status: "pending", lockedBy: secondLock });
		});
	});

	describe("completion", () => {
		it("schedules a retry when the completion write fails after the work succeeded", async () => {
			const ctx = createMockSyncContext();
			const payload = createMockWebhookPayload({ event_type: "PAYMENT_SUCCEEDED" });
			const update = ctx.adapter.update.bind(ctx.adapter);
			let failCompletion = true;
			ctx.adapter.update = async (args) => {
				const completing = (args.update as { status?: string }).status === "completed";
				if (completing && failCompletion) {
					failCompletion = false;
					throw new Error("database connection reset");
				}
				return update(args);
			};

			await expect(
				deliverWebhookEvent(ctx, scope(), payload, {
					rawBody: JSON.stringify(payload),
					signatureHeader: null,
				}),
			).rejects.toThrow("database connection reset");

			const [row] = eventRows(ctx);
			expect(row).toMatchObject({ status: "pending", lockedBy: null });
			expect(row?.nextAttemptAt).toBeInstanceOf(Date);
		});
	});

	describe("registration", () => {
		it("rejects a scope prefix that replay could not route", () => {
			expect(() => createWebhookInbox().register(scope({ eventIdPrefix: "billing" }))).toThrow(
				TypeError,
			);
		});
	});

	describe("due selection", () => {
		it("selects retry-due events and abandoned leases but not future retries or live leases", async () => {
			const ctx = createMockSyncContext();
			const now = new Date("2026-06-01T12:00:00.000Z");
			const minute = 60 * 1000;
			await seedEvent(ctx, { eventId: "due", nextAttemptAt: new Date(now.getTime() - minute) });
			await seedEvent(ctx, { eventId: "future", nextAttemptAt: new Date(now.getTime() + minute) });
			await seedEvent(ctx, {
				eventId: "abandoned",
				lockedAt: new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS - minute),
				lockedBy: "crashed-worker",
			});
			await seedEvent(ctx, { eventId: "leased", lockedAt: now, lockedBy: "live-worker" });
			await seedEvent(ctx, {
				eventId: "done",
				status: "completed",
				nextAttemptAt: new Date(now.getTime() - minute),
			});

			const due = await findDueWebhookEvents(ctx, now, 10);

			expect(due.map((row) => row.eventId).sort()).toEqual(["abandoned", "due"]);
		});

		it("parks unreplayable due events so they stop filling every batch", async () => {
			const ctx = createMockSyncContext();
			const inbox = createWebhookInbox();
			const run = vi.fn();
			inbox.register(scope({ prepare: () => run }));
			const past = new Date(Date.now() - 60 * 1000);
			const payload = createMockWebhookPayload({ event_type: "PAYMENT_SUCCEEDED" });
			await seedEvent(ctx, { eventId: "handlers:empty", nextAttemptAt: past });
			await seedEvent(ctx, { eventId: "handlers:bad-json", nextAttemptAt: past, rawPayload: "{" });
			await seedEvent(ctx, {
				eventId: "handlers:ok",
				nextAttemptAt: past,
				rawPayload: JSON.stringify(payload),
			});

			const first = await inbox.processDue(ctx, 2);
			const second = await inbox.processDue(ctx, 2);

			expect(first.failed.map((failure) => failure.eventId).sort()).toEqual([
				"handlers:bad-json",
				"handlers:empty",
			]);
			expect(second).toEqual({ succeeded: ["handlers:ok"], failed: [] });
			expect(run).toHaveBeenCalledTimes(1);
			for (const parked of eventRows(ctx).filter((row) => row.eventId !== "handlers:ok")) {
				expect(parked).toMatchObject({
					status: "pending",
					nextAttemptAt: null,
					lockedBy: null,
					lastErrorCode: "UNREPLAYABLE_PAYLOAD",
				});
			}
		});

		it("keeps the retry a redelivery scheduled while the event was being inspected", async () => {
			const ctx = createMockSyncContext();
			const inbox = createWebhookInbox();
			inbox.register(scope());
			const past = new Date(Date.now() - 60 * 1000);
			await seedEvent(ctx, { eventId: "handlers:raced", nextAttemptAt: past });
			const redeliveredRetry = new Date(Date.now() + 60 * 60 * 1000);
			const findMany = ctx.adapter.findMany.bind(ctx.adapter);
			ctx.adapter.findMany = async <T>(args: Parameters<typeof findMany>[0]) => {
				const due = await findMany<T>(args);
				const stored = eventRows(ctx)[0];
				if (stored && stored.attemptCount === 1) {
					due.splice(0, due.length, { ...stored } as T);
					Object.assign(stored, {
						attemptCount: 2,
						rawPayload: JSON.stringify(createMockWebhookPayload()),
						nextAttemptAt: redeliveredRetry,
						lastErrorCode: "HTTP_503",
					});
				}
				return due;
			};

			await inbox.processDue(ctx, 10);

			expect(eventRows(ctx)[0]).toMatchObject({
				attemptCount: 2,
				nextAttemptAt: redeliveredRetry,
				lastErrorCode: "HTTP_503",
			});
		});

		it("lets a StreamPay redelivery complete a parked event", async () => {
			const ctx = createMockSyncContext();
			const run = vi.fn();
			const handlers = scope({ prepare: () => run });
			const inbox = createWebhookInbox();
			inbox.register(handlers);
			const payload = createMockWebhookPayload({ event_type: "PAYMENT_SUCCEEDED" });
			const eventId = `handlers:${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
			await seedEvent(ctx, { eventId, nextAttemptAt: new Date(Date.now() - 1000) });
			await inbox.processDue(ctx, 10);
			expect(eventRows(ctx)[0]).toMatchObject({ lastErrorCode: "UNREPLAYABLE_PAYLOAD" });

			const outcome = await deliverWebhookEvent(ctx, handlers, payload, {
				rawBody: JSON.stringify(payload),
				signatureHeader: "sig",
			});

			expect(outcome).toBe("processed");
			expect(run).toHaveBeenCalledTimes(1);
			expect(eventRows(ctx)[0]).toMatchObject({ status: "completed", attemptCount: 2 });
		});

		it("skips a selected event that a redelivery completed or another run parked meanwhile", async () => {
			const ctx = createMockSyncContext();
			const inbox = createWebhookInbox();
			const run = vi.fn();
			inbox.register(scope({ prepare: () => run }));
			const past = new Date(Date.now() - 60 * 1000);
			await seedEvent(ctx, { eventId: "handlers:redelivered", nextAttemptAt: past });
			await seedEvent(ctx, {
				eventId: "handlers:parked-elsewhere",
				nextAttemptAt: past,
				rawPayload: JSON.stringify(createMockWebhookPayload()),
			});
			const findMany = ctx.adapter.findMany.bind(ctx.adapter);
			ctx.adapter.findMany = async <T>(args: Parameters<typeof findMany>[0]) => {
				const selected = (await findMany<T>(args)).map((row) => ({ ...row }));
				const [redelivered, parked] = eventRows(ctx);
				if (redelivered) Object.assign(redelivered, { status: "completed", nextAttemptAt: null });
				if (parked) Object.assign(parked, { nextAttemptAt: null });
				return selected;
			};

			expect(await inbox.processDue(ctx, 10)).toEqual({ succeeded: [], failed: [] });

			expect(run).not.toHaveBeenCalled();
			expect(eventRows(ctx)[0]).toMatchObject({ status: "completed", lastErrorCode: null });
		});

		it("keeps processing the batch when parking one event fails", async () => {
			const ctx = createMockSyncContext();
			const inbox = createWebhookInbox();
			const run = vi.fn();
			inbox.register(scope({ prepare: () => run }));
			const past = new Date(Date.now() - 60 * 1000);
			await seedEvent(ctx, { eventId: "handlers:empty", nextAttemptAt: past });
			await seedEvent(ctx, {
				eventId: "handlers:ok",
				nextAttemptAt: new Date(past.getTime() + 1000),
				rawPayload: JSON.stringify(createMockWebhookPayload()),
			});
			const update = ctx.adapter.update.bind(ctx.adapter);
			ctx.adapter.update = async (args) => {
				if ((args.update as { lastErrorCode?: string }).lastErrorCode === "UNREPLAYABLE_PAYLOAD") {
					throw new Error("database unavailable");
				}
				return update(args);
			};

			const result = await inbox.processDue(ctx, 10);

			expect(result).toEqual({
				succeeded: ["handlers:ok"],
				failed: [{ eventId: "handlers:empty", error: "database unavailable" }],
			});
			expect(run).toHaveBeenCalledTimes(1);
		});

		it("never parks a dead-lettered event or one with a live lease", async () => {
			const ctx = createMockSyncContext();
			const inbox = createWebhookInbox();
			inbox.register(scope());
			await seedEvent(ctx, { eventId: "handlers:dead", status: "dead_letter" });
			await seedEvent(ctx, {
				eventId: "handlers:leased",
				lockedAt: new Date(),
				lockedBy: "live-worker",
			});

			await expect(inbox.replay(ctx, "handlers:dead")).rejects.toBeInstanceOf(APIError);
			await expect(inbox.replay(ctx, "handlers:leased")).rejects.toBeInstanceOf(APIError);

			expect(eventRows(ctx)).toMatchObject([
				{ eventId: "handlers:dead", status: "dead_letter", lastErrorCode: null },
				{ eventId: "handlers:leased", lockedBy: "live-worker", lastErrorCode: null },
			]);
		});
	});

	describe("discard", () => {
		it("releases the renewal callback owner held by a discarded subscription event", async () => {
			const registry: StreamPayPluginRegistry = {};
			subscriptions({ plans: [PLAN] })(createTestStreamPayOptions(), registry);
			const ctx = createMockSyncContext();
			const eventId = "INVOICE_COMPLETED:inv_1:2026-01-01T00:00:00.000Z";
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({ id: "sub_row", renewalCallbackEventId: eventId }),
			});
			await seedEvent(ctx, { eventId, eventType: "INVOICE_COMPLETED", status: "dead_letter" });

			await registry.webhookInbox?.discard(ctx, eventId);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({ renewalCallbackEventId: null });
			expect(eventRows(ctx)[0]).toMatchObject({ status: "completed", rawPayload: null });
		});

		it("still releases the renewal owner after subscription deduplication is turned off", async () => {
			const registry: StreamPayPluginRegistry = {};
			const options = createTestStreamPayOptions();
			subscriptions({ plans: [PLAN], enableWebhookEventTable: false })(options, registry);
			webhooks({ secret: "test-only-secret", deduplicate: true })(options, registry);
			const ctx = createMockSyncContext();
			const eventId = "INVOICE_COMPLETED:inv_2:2026-01-01T00:00:00.000Z";
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({ renewalCallbackEventId: eventId }),
			});
			await seedEvent(ctx, { eventId, eventType: "INVOICE_COMPLETED", status: "dead_letter" });

			await registry.webhookInbox?.discard(ctx, eventId);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({ renewalCallbackEventId: null });
			await expect(registry.webhookInbox?.replay(ctx, eventId)).rejects.toMatchObject({
				status: "BAD_REQUEST",
			});
		});

		it("completes a leftover event even when no scope is registered", async () => {
			const ctx = createMockSyncContext();
			await seedEvent(ctx, { eventId: "handlers:orphan", status: "dead_letter" });

			await expect(createWebhookInbox().discard(ctx, "handlers:orphan")).resolves.toEqual({
				discarded: true,
				eventId: "handlers:orphan",
			});

			expect(eventRows(ctx)[0]).toMatchObject({ status: "completed" });
		});

		it("leaves subscription state alone when a generic handler event is discarded", async () => {
			const registry: StreamPayPluginRegistry = {};
			const options = createTestStreamPayOptions();
			subscriptions({ plans: [PLAN] })(options, registry);
			webhooks({ secret: "test-only-secret", deduplicate: true })(options, registry);
			const ctx = createMockSyncContext();
			const sourceEventId = "INVOICE_COMPLETED:inv_1:2026-01-01T00:00:00.000Z";
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({ renewalCallbackEventId: sourceEventId }),
			});
			await seedEvent(ctx, {
				eventId: `handlers:${sourceEventId}`,
				eventType: "INVOICE_COMPLETED",
			});

			await registry.webhookInbox?.discard(ctx, `handlers:${sourceEventId}`);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				renewalCallbackEventId: sourceEventId,
			});
		});
	});

	describe("renewal callback retries", () => {
		function renewalFixture() {
			const client = createMockStreamPayClient();
			client.getInvoice.mockResolvedValue({
				id: "inv_r",
				subscription_id: "sub_r",
				currency: "SAR",
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_r",
				status: "ACTIVE",
				current_period_end: "2026-03-01T00:00:00Z",
				current_cycle_number: 2,
				organization_consumer_id: "cons_1",
			});
			const payload: StreamPayWebhookEnvelope = createMockWebhookPayload({
				event_type: "INVOICE_COMPLETED",
				entity_type: "INVOICE",
				entity_id: "inv_r",
				data: { invoice: { id: "inv_r", url: "x" } },
			});
			return { client, payload };
		}

		it("records a stable failure code when the renewal callback fails", async () => {
			const { client, payload } = renewalFixture();
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_r",
					status: "active",
					periodEnd: new Date("2026-02-01T00:00:00Z"),
					currentCycleNumber: 1,
				}),
			});

			await expect(
				syncWebhookPayload(
					ctx,
					payload as never,
					client,
					{ list: [], byName: new Map() } as never,
					{ onSubscriptionRenewed: vi.fn().mockRejectedValue(new Error("crm down")) },
				),
			).rejects.toThrow(/crm down/);

			expect(eventRows(ctx)[0]).toMatchObject({
				status: "pending",
				lastErrorCode: "SUBSCRIPTION_RENEWAL_CALLBACK_FAILED",
			});
		});

		it("still recognizes a renewal callback failure recorded before the failure code existed", async () => {
			const { client, payload } = renewalFixture();
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_r",
					status: "active",
					periodEnd: new Date("2026-03-01T00:00:00Z"),
					currentCycleNumber: 2,
				}),
			});
			const eventId = `${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
			await seedEvent(ctx, {
				eventId,
				eventType: payload.event_type,
				rawPayload: JSON.stringify(payload),
				lastError: "Subscription callback onSubscriptionRenewed failed: crm down",
				lastErrorCode: "SubscriptionCallbackDeliveryError",
			});
			const onSubscriptionRenewed = vi.fn();
			const registry: StreamPayPluginRegistry = {};
			subscriptions({ plans: [PLAN], onSubscriptionRenewed })(
				createTestStreamPayOptions({ client }),
				registry,
			);

			await registry.webhookInbox?.replay(ctx, eventId);

			expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
		});
	});

	describe("public replay contract", () => {
		it("refuses a registry replay whose dueAttemptCount is no longer the pending attempt", async () => {
			const onPayload = vi.fn();
			const registry: StreamPayPluginRegistry = {};
			webhooks({ secret: "test-only-secret", deduplicate: true, onPayload })(
				createTestStreamPayOptions(),
				registry,
			);
			const ctx = createMockSyncContext();
			const payload = createMockWebhookPayload({ event_type: "PAYMENT_SUCCEEDED" });
			await seedEvent(ctx, {
				eventId: "handlers:advanced",
				attemptCount: 2,
				nextAttemptAt: new Date(Date.now() - 1000),
				rawPayload: JSON.stringify(payload),
			});

			await expect(
				registry.replayWebhookEvent?.(asEndpointContext(ctx), "handlers:advanced", {
					dueAttemptCount: 1,
				}),
			).rejects.toMatchObject({ status: "CONFLICT" });
			await expect(
				registry.replayWebhookEvent?.(asEndpointContext(ctx), "handlers:advanced", {
					dueAttemptCount: 2,
				}),
			).resolves.toEqual({ replayed: true, eventId: "handlers:advanced" });

			expect(onPayload).toHaveBeenCalledTimes(1);
		});

		it("releases a completed renewal lock only when syncWebhookPayload is told the inbox exists", async () => {
			const client = createMockStreamPayClient();
			client.getSubscription.mockResolvedValue({
				id: "sub_locked",
				status: "ACTIVE",
				current_cycle_number: 2,
				organization_consumer_id: "cons_1",
			});
			const lockEventId = "INVOICE_COMPLETED:inv_old:2026-01-01T00:00:00.000Z";
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
				entity_type: "SUBSCRIPTION",
				entity_id: "sub_locked",
			});
			const plans = { list: [], byName: new Map() };
			const locked = async () => {
				const ctx = createMockSyncContext();
				await ctx.adapter.create({
					model: "subscription",
					data: createMockSubscriptionRow({
						streampaySubscriptionId: "sub_locked",
						status: "active",
						currentCycleNumber: 1,
						renewedCycleNumber: 1,
						renewalCallbackEventId: lockEventId,
					}),
				});
				await seedEvent(ctx, { eventId: lockEventId, status: "completed" });
				return ctx;
			};

			const withoutInbox = await locked();
			await expect(
				syncWebhookPayload(
					withoutInbox,
					payload as never,
					client,
					plans as never,
					{},
					{
						dedupe: false,
					},
				),
			).rejects.toThrow(/pending; retry delivery/);
			const dedupedWithoutInbox = await locked();
			await expect(
				syncWebhookPayload(
					dedupedWithoutInbox,
					payload as never,
					client,
					plans as never,
					{},
					{
						inboxEnabled: false,
					},
				),
			).rejects.toThrow(/pending; retry delivery/);
			const withInbox = await locked();
			await syncWebhookPayload(
				withInbox,
				payload as never,
				client,
				plans as never,
				{},
				{
					dedupe: false,
					inboxEnabled: true,
				},
			);

			expect(withoutInbox.adapter.tables.subscription?.[0]).toMatchObject({
				renewalCallbackEventId: lockEventId,
			});
			expect(dedupedWithoutInbox.adapter.tables.subscription?.[0]).toMatchObject({
				renewalCallbackEventId: lockEventId,
			});
			expect(withInbox.adapter.tables.subscription?.[0]).toMatchObject({
				renewalCallbackEventId: null,
			});
		});
	});
});
