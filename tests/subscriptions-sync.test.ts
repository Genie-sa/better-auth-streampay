import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDate, projectPlanFields } from "../src/plugins/subscriptions/reconcile";
import {
	claimOrAdvanceWebhookEvent,
	claimWebhookEventForReplay,
	classifyWebhookFailure,
	markWebhookEventCompleted,
	syncWebhookPayload,
	type WebhookEventRow,
} from "../src/plugins/subscriptions/sync";
import {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	REFERENCE_TYPE_METADATA_KEY,
	SUBSCRIPTION_ROW_ID_METADATA_KEY,
	type SubscriptionCallbacks,
	subscriptionSlotKey,
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
	priceInSmallestUnit: 9900,
	billingInterval: "MONTH" as const,
};
const PLAN_PLUS = {
	name: "pro_plus",
	productId: "prod_pro_plus",
	priceInSmallestUnit: 19900,
	billingInterval: "MONTH" as const,
};

function resolvedPlans() {
	const byName = new Map<string, typeof PLAN>();
	byName.set(PLAN.name, PLAN);
	return { list: [PLAN], byName };
}

function resolvedPlansWithUpgrade() {
	const list = [PLAN, PLAN_PLUS] as const;
	return { list, byName: new Map(list.map((plan) => [plan.name, plan])) };
}

describe("syncWebhookPayload", () => {
	let client: MockedStreamPayClient;

	beforeEach(() => {
		client = createMockStreamPayClient();
		vi.clearAllMocks();
	});

	it("treats timezone-less StreamPay timestamps as UTC", () => {
		expect(parseDate("2026-07-22T14:06:06.213425")?.toISOString()).toBe("2026-07-22T14:06:06.213Z");
		expect(parseDate("2026-07-22T17:06:06.213+03:00")?.toISOString()).toBe(
			"2026-07-22T14:06:06.213Z",
		);
	});

	it("rejects ambiguous provider state with multiple configured plan products", () => {
		expect(() =>
			projectPlanFields(
				{
					id: "sub_ambiguous",
					items: [
						{ product_id: "prod_pro", quantity: 2 },
						{ product_id: "prod_pro_plus", quantity: 2 },
					],
				},
				resolvedPlansWithUpgrade(),
			),
		).toThrow(/multiple configured plan products/);
	});

	describe("event lifecycle via streampayWebhookEvent state machine", () => {
		it("claims a dead-letter replay once and rejects a concurrent replay", async () => {
			const ctx = createMockSyncContext();
			const row = await ctx.adapter.create<WebhookEventRow>({
				model: "streampayWebhookEvent",
				data: {
					eventId: "SUBSCRIPTION_ACTIVATED:sub_replay:2026-01-01T00:00:00.000Z",
					eventType: "SUBSCRIPTION_ACTIVATED",
					status: "dead_letter",
					attemptCount: 3,
					receivedAt: new Date("2026-01-01T00:00:00.000Z"),
					lastAttemptAt: new Date("2026-01-01T00:15:00.000Z"),
					nextAttemptAt: null,
					completedAt: null,
					deadLetteredAt: new Date("2026-01-01T00:15:00.000Z"),
					lockedAt: null,
					lockedBy: null,
					rawPayload: "{}",
					signatureHeader: "t=1,v1=abc",
					lastError: "upstream failed",
					lastErrorCode: "HTTP_503",
				},
			});

			const claimed = await claimWebhookEventForReplay(ctx, row);
			expect(claimed).toMatchObject({
				status: "pending",
				attemptCount: 4,
				deadLetteredAt: null,
			});
			expect(claimed?.lockedBy).toEqual(expect.any(String));
			if (!claimed) throw new Error("expected replay lease");

			await expect(claimWebhookEventForReplay(ctx, claimed)).resolves.toBeNull();
		});

		it("fences a stale worker from completing a lease claimed by a newer worker", async () => {
			const ctx = createMockSyncContext();
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_fenced",
				timestamp: "2026-01-01T00:00:00.000Z",
			});
			const first = await claimOrAdvanceWebhookEvent(ctx, payload, null, null, 5);
			expect(first.action).toBe("process");
			if (first.action !== "process" || !first.row?.lockedBy) {
				throw new Error("expected first tracked webhook lease");
			}
			const firstLockId = first.row.lockedBy;
			const eventRow = ctx.adapter.tables.streampayWebhookEvent?.[0];
			if (!eventRow) throw new Error("expected webhook row");
			eventRow.lockedAt = new Date(Date.now() - 3 * 60 * 1000);

			const second = await claimOrAdvanceWebhookEvent(ctx, payload, null, null, 5);
			expect(second.action).toBe("process");
			if (second.action !== "process" || !second.row?.lockedBy) {
				throw new Error("expected replacement webhook lease");
			}
			expect(second.row.lockedBy).not.toBe(firstLockId);

			await markWebhookEventCompleted(ctx, first.row.id, firstLockId);
			expect(eventRow).toMatchObject({
				status: "pending",
				lockedBy: second.row.lockedBy,
			});

			await markWebhookEventCompleted(ctx, second.row.id, second.row.lockedBy);
			expect(eventRow).toMatchObject({ status: "completed", lockedBy: null });
		});

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

		it("skips a concurrent delivery while the first attempt holds the processing lease", async () => {
			const ctx = createMockSyncContext();
			const timestamp = "2026-01-01T00:00:00.000Z";
			await ctx.adapter.create({
				model: "streampayWebhookEvent",
				data: {
					eventId: `SUBSCRIPTION_ACTIVATED:sub_concurrent:${timestamp}`,
					eventType: "SUBSCRIPTION_ACTIVATED",
					status: "pending",
					attemptCount: 1,
					receivedAt: new Date(),
					lastAttemptAt: new Date(),
					lockedAt: new Date(),
					lockedBy: "worker-a",
				},
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_ACTIVATED",
					entity_id: "sub_concurrent",
					timestamp,
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(client.getSubscription).not.toHaveBeenCalled();
			expect(ctx.logs.info.some((message) => message.includes("already being processed"))).toBe(
				true,
			);
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

			await seedActiveSub(ctx, "sub_c");
			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {} as SubscriptionCallbacks);
			expect(rows[0]).toMatchObject({ status: "completed", attemptCount: 2 });
		});

		it("dead-letters permanent provider failures immediately", async () => {
			const ctx = createMockSyncContext();
			client.getSubscription.mockRejectedValue(
				mockApiError(400, { code: "SUBSCRIPTION_INVALID_STATE" }),
			);
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_permanent",
			});

			await expect(
				syncWebhookPayload(
					ctx,
					payload,
					client,
					resolvedPlans(),
					{},
					{
						rawBody: '{"event_type":"SUBSCRIPTION_ACTIVATED"}',
					},
				),
			).rejects.toThrow();
			expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
				status: "dead_letter",
				lockedAt: null,
				lockedBy: null,
			});
			expect(ctx.adapter.tables.streampayWebhookEvent?.[0]?.deadLetteredAt).toBeInstanceOf(Date);
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
			const row = (ctx.adapter.tables.streampayWebhookEvent ?? [])[0];
			expect(row).toMatchObject({
				status: "dead_letter",
				attemptCount: 3,
				rawPayload: rawBody,
				signatureHeader,
				lockedAt: null,
				lockedBy: null,
			});
			expect(row?.deadLetteredAt).toBeInstanceOf(Date);

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
					streampayConsumerId: "cons_1",
					streampaySubscriptionId: null,
				}),
			});

			client.getSubscription.mockResolvedValue({
				id: "sub_abc",
				status: "ACTIVE",
				amount: "99.00",
				currency: "SAR",
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
			expect(row?.amountInSmallestUnit).toBe(9900);
			expect(onCreated).toHaveBeenCalledTimes(1);
		});

		it("links by payment link when multiple incomplete attempts exist for one plan", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_exact_checkout",
					referenceId: "user-123",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_1",
					streampaySubscriptionId: null,
					streampayPaymentLinkId: "pl_exact",
					createdAt: new Date("2026-01-01T00:00:00Z"),
				}),
			});
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_newer_other_checkout",
					referenceId: "user-123",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_1",
					streampaySubscriptionId: null,
					streampayPaymentLinkId: "pl_other",
					createdAt: new Date("2026-01-02T00:00:00Z"),
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_exact_checkout",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				latest_invoice: { payment_link_id: "pl_exact", currency: "SAR" },
			});
			const payload = createMockWebhookPayload({
				event_type: "SUBSCRIPTION_CREATED",
				entity_id: "sub_exact_checkout",
				data: {
					metadata: {
						[PLAN_NAME_METADATA_KEY]: "pro",
						[REFERENCE_ID_METADATA_KEY]: "user-123",
					},
					payment_link: { id: "pl_exact", url: "https://example.test/pl_exact" },
				},
			});

			await syncWebhookPayload(ctx, payload, client, resolvedPlans(), {});

			expect(
				ctx.adapter.tables.subscription?.find((row) => row.id === "row_exact_checkout"),
			).toMatchObject({ streampaySubscriptionId: "sub_exact_checkout", status: "active" });
			expect(
				ctx.adapter.tables.subscription?.find((row) => row.id === "row_newer_other_checkout"),
			).toMatchObject({ streampaySubscriptionId: null, status: "incomplete" });
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
			expect(row?.referenceType).toBe("custom");
			expect(row?.activeSlotKey).toBe(subscriptionSlotKey("custom", "user-123", null));
		});

		it("does not reserve an active slot for a terminal subscription first seen by webhook", async () => {
			const ctx = createMockSyncContext();
			client.getSubscription.mockResolvedValue({
				id: "sub_external_canceled",
				status: "CANCELED",
				organization_consumer_id: "cons_1",
				items: [{ product_id: "prod_pro", quantity: 1 }],
				latest_invoice: { payment_link_id: "pl_external", currency: "SAR" },
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CANCELED",
					entity_id: "sub_external_canceled",
					data: {
						metadata: {
							[PLAN_NAME_METADATA_KEY]: "pro",
							[REFERENCE_ID_METADATA_KEY]: "external-ref",
							[REFERENCE_TYPE_METADATA_KEY]: "custom",
						},
					},
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "canceled",
				activeSlotKey: null,
				streampayPaymentLinkId: "pl_external",
			});
		});

		it("does not resolve a Better Auth user for a custom reference with the same id", async () => {
			const ctx = createMockSyncContext();
			const findUserById = vi.fn().mockResolvedValue({ id: "shared-id" });
			ctx.context.internalAdapter = { findUserById };
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					referenceId: "shared-id",
					referenceType: "custom",
					streampaySubscriptionId: "sub_custom_ref",
					status: "incomplete",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_custom_ref",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
			});
			const callback = vi.fn<NonNullable<SubscriptionCallbacks["onSubscriptionActivated"]>>();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_ACTIVATED",
					entity_id: "sub_custom_ref",
				}),
				client,
				resolvedPlans(),
				{ onSubscriptionActivated: callback },
			);

			expect(findUserById).not.toHaveBeenCalled();
			expect(callback).toHaveBeenCalledWith(expect.objectContaining({ user: null }));
		});

		it("does not correlate protected row metadata across reference namespaces", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_org",
					referenceId: "shared-id",
					referenceType: "organization",
					status: "incomplete",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_custom",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				items: [{ product_id: "prod_pro", quantity: 1 }],
			});

			await expect(
				syncWebhookPayload(
					ctx,
					createMockWebhookPayload({
						event_type: "SUBSCRIPTION_CREATED",
						entity_id: "sub_custom",
						data: {
							metadata: {
								[PLAN_NAME_METADATA_KEY]: "pro",
								[REFERENCE_ID_METADATA_KEY]: "shared-id",
								[REFERENCE_TYPE_METADATA_KEY]: "custom",
								[SUBSCRIPTION_ROW_ID_METADATA_KEY]: "row_org",
							},
						},
					}),
					client,
					resolvedPlans(),
					{},
				),
			).rejects.toThrow(/protected subscription correlation/);

			expect(ctx.adapter.tables.subscription).toHaveLength(1);
			expect(ctx.adapter.tables.subscription?.find((row) => row.id === "row_org")).toMatchObject({
				streampaySubscriptionId: null,
				referenceType: "organization",
			});
			expect(ctx.logs.warn.some((message) => message.includes("ignored unsafe"))).toBe(true);
			expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
				status: "dead_letter",
			});
		});

		it("dead-letters a protected row correlation when the provider consumer does not match", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_victim",
					referenceId: "user-123",
					referenceType: "user",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_expected",
					streampaySubscriptionId: null,
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_attacker",
				status: "ACTIVE",
				organization_consumer_id: "cons_attacker",
				items: [{ product_id: "prod_pro", quantity: 1 }],
			});

			await expect(
				syncWebhookPayload(
					ctx,
					createMockWebhookPayload({
						event_type: "SUBSCRIPTION_CREATED",
						entity_id: "sub_attacker",
						data: {
							metadata: {
								[PLAN_NAME_METADATA_KEY]: "pro",
								[REFERENCE_ID_METADATA_KEY]: "user-123",
								[REFERENCE_TYPE_METADATA_KEY]: "user",
								[SUBSCRIPTION_ROW_ID_METADATA_KEY]: "row_victim",
							},
						},
					}),
					client,
					resolvedPlans(),
					{},
				),
			).rejects.toThrow(/protected subscription correlation/);

			expect(ctx.adapter.tables.subscription?.find((row) => row.id === "row_victim")).toMatchObject(
				{
					streampaySubscriptionId: null,
					streampayConsumerId: "cons_expected",
				},
			);
			expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
				status: "dead_letter",
			});
		});

		it("never adopts an incomplete row billed to a different consumer in fallback matching", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "row_reserved",
					referenceId: "user-123",
					referenceType: "user",
					plan: "pro",
					status: "incomplete",
					streampayConsumerId: "cons_expected",
					streampaySubscriptionId: null,
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_other_payer",
				status: "ACTIVE",
				organization_consumer_id: "cons_attacker",
				items: [{ product_id: "prod_pro", quantity: 1 }],
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CREATED",
					entity_id: "sub_other_payer",
					data: {
						metadata: {
							[PLAN_NAME_METADATA_KEY]: "pro",
							[REFERENCE_ID_METADATA_KEY]: "user-123",
							[REFERENCE_TYPE_METADATA_KEY]: "user",
						},
					},
				}),
				client,
				resolvedPlans(),
				{},
			).catch(() => undefined);

			expect(
				ctx.adapter.tables.subscription?.find((row) => row.id === "row_reserved"),
			).toMatchObject({
				streampaySubscriptionId: null,
				streampayConsumerId: "cons_expected",
			});
		});

		it("rebuilds a missing checkout row from signed provider metadata", async () => {
			const ctx = createMockSyncContext();
			client.getSubscription.mockResolvedValue({
				id: "sub_rebuilt",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				items: [{ product_id: "prod_pro", quantity: 1 }],
				latest_invoice: { payment_link_id: "pl_rebuilt", currency: "SAR" },
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CREATED",
					entity_id: "sub_rebuilt",
					data: {
						metadata: {
							[PLAN_NAME_METADATA_KEY]: "pro",
							[REFERENCE_ID_METADATA_KEY]: "rebuilt-ref",
							[REFERENCE_TYPE_METADATA_KEY]: "custom",
							[SUBSCRIPTION_ROW_ID_METADATA_KEY]: "missing-row",
						},
					},
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				referenceId: "rebuilt-ref",
				referenceType: "custom",
				streampaySubscriptionId: "sub_rebuilt",
				streampayPaymentLinkId: "pl_rebuilt",
			});
			expect(ctx.logs.warn.some((message) => message.includes("rebuilding"))).toBe(true);
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

		it("releases the unique active slot when the provider reaches a terminal status", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_terminal",
					status: "active",
					activeSlotKey: subscriptionSlotKey("user", "user-123", null),
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_terminal",
				status: "CANCELED",
				organization_consumer_id: "cons_1",
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CANCELED",
					entity_id: "sub_terminal",
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "canceled",
				activeSlotKey: null,
			});
			expect(ctx.adapter.tables.subscription?.[0]?.canceledAt).toBeInstanceOf(Date);
		});

		it("does not let a late cancellation event overwrite newer active provider state", async () => {
			const ctx = createMockSyncContext();
			const activeSlotKey = subscriptionSlotKey("user", "user-123", null);
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_restored",
					status: "active",
					providerStatus: "ACTIVE",
					providerUpdatedAt: new Date("2026-02-01T00:00:00.000Z"),
					activeSlotKey,
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_restored",
				status: "ACTIVE",
				updated_at: "2026-02-01T00:00:00.000Z",
				organization_consumer_id: "cons_1",
				cancel_at_period_end: false,
			});
			const callback = vi.fn<NonNullable<SubscriptionCallbacks["onSubscriptionCanceled"]>>();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CANCELED",
					entity_id: "sub_restored",
					timestamp: "2026-01-01T00:00:00.000Z",
				}),
				client,
				resolvedPlans(),
				{ onSubscriptionCanceled: callback },
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "active",
				providerStatus: "ACTIVE",
				activeSlotKey,
				cancelAtPeriodEnd: false,
				canceledAt: null,
			});
			expect(callback).not.toHaveBeenCalled();
			expect(ctx.logs.info.some((message) => message.includes("stale lifecycle callback"))).toBe(
				true,
			);
		});

		it("projects a period-end cancellation from the provider event timestamp", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_cancel_scheduled",
					status: "active",
					cancelAtPeriodEnd: false,
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_cancel_scheduled",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				cancel_at_period_end: true,
				current_period_end: "2026-03-01T00:00:00.000Z",
			});
			const callback = vi.fn<NonNullable<SubscriptionCallbacks["onSubscriptionCancelScheduled"]>>();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CANCEL_AT_PERIOD_END",
					entity_id: "sub_cancel_scheduled",
					timestamp: "2026-02-01T12:00:00.000Z",
				}),
				client,
				resolvedPlans(),
				{ onSubscriptionCancelScheduled: callback },
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "active",
				cancelAtPeriodEnd: true,
				cancelScheduledAt: new Date("2026-02-01T12:00:00.000Z"),
				cancelAt: new Date("2026-03-01T00:00:00.000Z"),
			});
			expect(callback).toHaveBeenCalledOnce();
		});

		it("ignores a period-end cancellation event older than provider state", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_cancel_restored",
					status: "active",
					cancelAtPeriodEnd: false,
					providerUpdatedAt: new Date("2026-03-01T00:00:00.000Z"),
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_cancel_restored",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				cancel_at_period_end: false,
				updated_at: "2026-03-01T00:00:00.000Z",
			});
			const callback = vi.fn<NonNullable<SubscriptionCallbacks["onSubscriptionCancelScheduled"]>>();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CANCEL_AT_PERIOD_END",
					entity_id: "sub_cancel_restored",
					timestamp: "2026-02-01T00:00:00.000Z",
				}),
				client,
				resolvedPlans(),
				{ onSubscriptionCancelScheduled: callback },
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "active",
				cancelAtPeriodEnd: false,
				cancelScheduledAt: null,
			});
			expect(callback).not.toHaveBeenCalled();
		});

		it("releases the active slot when StreamPay inactivates a subscription", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_inactivated",
					status: "active",
					activeSlotKey: subscriptionSlotKey("user", "user-123", null),
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_inactivated",
				status: "INACTIVE",
				organization_consumer_id: "cons_1",
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_INACTIVATED",
					entity_id: "sub_inactivated",
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "inactive",
				activeSlotKey: null,
			});
		});

		it("backfills a missing active slot while reconciling a legacy live row", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_legacy",
					status: "active",
					activeSlotKey: null,
					group: "tier",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_legacy",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_ACTIVATED",
					entity_id: "sub_legacy",
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(ctx.adapter.tables.subscription?.[0]?.activeSlotKey).toBe(
				subscriptionSlotKey("user", "user-123", "tier"),
			);
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
			const row = (ctx.adapter.tables.subscription ?? [])[0];
			expect(row?.status).toBe("past_due");
			expect(row).toMatchObject({ providerStatus: "ACTIVE", billingStatus: "past_due" });
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("ignores a renewal failure older than the stored provider state", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_paid_later",
					status: "active",
					billingStatus: "current",
					providerUpdatedAt: new Date("2026-02-01T00:00:00.000Z"),
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_paid_later",
				status: "ACTIVE",
				updated_at: "2026-02-01T00:00:00.000Z",
				organization_consumer_id: "cons_1",
			});
			const callback = vi.fn<NonNullable<SubscriptionCallbacks["onSubscriptionPaymentFailed"]>>();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CYCLE_RENEWAL_FAILED",
					entity_id: "sub_paid_later",
					timestamp: "2026-01-01T00:00:00.000Z",
				}),
				client,
				resolvedPlans(),
				{ onSubscriptionPaymentFailed: callback },
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "active",
				billingStatus: "current",
			});
			expect(callback).not.toHaveBeenCalled();
		});

		it("preserves past-due billing health until a completed invoice confirms recovery", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_health",
					status: "past_due",
					providerStatus: "ACTIVE",
					billingStatus: "past_due",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_health",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				items: [{ product_id: "prod_pro", quantity: 1 }],
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_PLAN_UPDATED",
					entity_id: "sub_health",
				}),
				client,
				resolvedPlans(),
				{},
			);
			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "past_due",
				providerStatus: "ACTIVE",
				billingStatus: "past_due",
			});

			client.getInvoice.mockResolvedValue({
				id: "inv_recovered",
				subscription_id: "sub_health",
				currency: "SAR",
			});
			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "INVOICE_COMPLETED",
					entity_type: "INVOICE",
					entity_id: "inv_recovered",
					data: { invoice: { id: "inv_recovered", url: "x" } },
				}),
				client,
				resolvedPlans(),
				{},
			);
			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "active",
				providerStatus: "ACTIVE",
				billingStatus: "current",
			});
		});
	});

	describe("trials and native plan-change events", () => {
		it("uses provider smallest-unit amounts and correctly falls back for three-decimal currencies", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_kwd",
					status: "active",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_kwd",
				status: "ACTIVE",
				currency: "KWD",
				amount: "10.123",
				original_amount: "12.500",
				organization_consumer_id: "cons_1",
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_ACTIVATED",
					entity_id: "sub_kwd",
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				amountInSmallestUnit: 10123,
				originalAmountInSmallestUnit: 12500,
				currency: "KWD",
			});
		});

		it("projects TRIALING with its trial end", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_trial",
					status: "incomplete",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_trial",
				status: "TRIALING",
				trial_end: "2026-06-01T00:00:00Z",
				organization_consumer_id: "cons_1",
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_ACTIVATED",
					entity_id: "sub_trial",
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "trialing",
				trialEnd: new Date("2026-06-01T00:00:00Z"),
			});
		});

		it("projects and announces a scheduled plan change without changing current plan", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_change",
					plan: "pro",
					status: "active",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_change",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				items: [{ product_id: "prod_pro", quantity: 1 }],
				pending_change: {
					id: "pending_1",
					effective_at: "2026-06-01T00:00:00Z",
					target_items: [{ product_id: "prod_pro_plus", quantity: 1 }],
				},
			});
			const callback = vi.fn();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_PLAN_CHANGE_SCHEDULED",
					entity_id: "sub_change",
				}),
				client,
				resolvedPlansWithUpgrade(),
				{ onSubscriptionPlanChangeScheduled: callback },
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				plan: "pro",
				pendingPlan: "pro_plus",
				pendingPlanEffectiveAt: new Date("2026-06-01T00:00:00Z"),
			});
			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("projects a quantity-only pending change as seats without inventing a plan change", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_seat_change",
					plan: "pro",
					seats: 3,
					status: "active",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_seat_change",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				items: [{ product_id: "prod_pro", quantity: 3 }],
				pending_change: {
					id: "pending_seats",
					effective_at: "2026-06-01T00:00:00Z",
					target_items: [{ product_id: "prod_pro", quantity: 9 }],
				},
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_PLAN_CHANGE_SCHEDULED",
					entity_id: "sub_seat_change",
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				plan: "pro",
				seats: 3,
				pendingPlan: null,
				pendingProductId: null,
				pendingSeats: 9,
				pendingSeatsEffectiveAt: new Date("2026-06-01T00:00:00Z"),
			});
		});

		it("applies the new plan when a scheduled change takes effect", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_changed",
					plan: "pro",
					pendingPlan: "pro_plus",
					status: "active",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_changed",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				items: [{ product_id: "prod_pro_plus", quantity: 1 }],
			});
			const callback = vi.fn();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_PLAN_CHANGED",
					entity_id: "sub_changed",
				}),
				client,
				resolvedPlansWithUpgrade(),
				{ onSubscriptionPlanChanged: callback },
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				plan: "pro_plus",
				pendingPlan: null,
				pendingPlanEffectiveAt: null,
			});
			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("applies the authoritative seat quantity and clears pending seats", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_seats_applied",
					plan: "pro",
					seats: 3,
					pendingSeats: 9,
					pendingSeatsEffectiveAt: new Date("2026-06-01T00:00:00Z"),
					status: "active",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_seats_applied",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				items: [{ product_id: "prod_pro", quantity: 9 }],
			});

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_PLAN_UPDATED",
					entity_id: "sub_seats_applied",
				}),
				client,
				resolvedPlans(),
				{},
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				plan: "pro",
				seats: 9,
				pendingSeats: null,
				pendingSeatsEffectiveAt: null,
			});
		});

		it.each([
			{
				event: "SUBSCRIPTION_UNFREEZE_FUTURE" as const,
				callback: "onSubscriptionUnfreezeScheduled" as const,
				status: "FROZEN" as const,
			},
			{
				event: "SUBSCRIPTION_FREEZE_CANCEL" as const,
				callback: "onSubscriptionFreezeCanceled" as const,
				status: "ACTIVE" as const,
			},
			{
				event: "SUBSCRIPTION_PLAN_CHANGE_INVOICE_REISSUED" as const,
				callback: "onSubscriptionPlanChangeInvoiceReissued" as const,
				status: "ACTIVE" as const,
			},
			{
				event: "SUBSCRIPTION_PLAN_UPDATED" as const,
				callback: "onSubscriptionPlanUpdated" as const,
				status: "ACTIVE" as const,
			},
		])("dispatches $event to the exact $callback callback", async ({ event, callback, status }) => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_exact_callback",
					status: status === "FROZEN" ? "frozen" : "active",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_exact_callback",
				status,
				organization_consumer_id: "cons_1",
			});
			const fn = vi.fn();
			const callbacks: SubscriptionCallbacks = {};
			callbacks[callback] = fn;

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({ event_type: event, entity_id: "sub_exact_callback" }),
				client,
				resolvedPlans(),
				callbacks,
			);

			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("clears pending state when a scheduled plan change is canceled", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_change",
					plan: "pro",
					pendingPlan: "pro_plus",
					pendingPlanEffectiveAt: new Date("2026-06-01T00:00:00Z"),
					status: "active",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_change",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
				items: [{ product_id: "prod_pro", quantity: 1 }],
			});
			const callback = vi.fn();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_PLAN_CHANGE_CANCELED",
					entity_id: "sub_change",
				}),
				client,
				resolvedPlansWithUpgrade(),
				{ onSubscriptionPlanChangeCanceled: callback },
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				plan: "pro",
				pendingPlan: null,
				pendingPlanEffectiveAt: null,
			});
			expect(callback).toHaveBeenCalledTimes(1);
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
					periodEnd: new Date("2026-02-01T00:00:00Z"),
					currentCycleNumber: 1,
				}),
			});

			client.getInvoice.mockResolvedValue({
				id: "inv_1",
				subscription_id: "sub_renew",
				currency: "SAR",
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_renew",
				status: "ACTIVE",
				amount: "99.00",
				current_period_start: "2026-02-01T00:00:00Z",
				current_period_end: "2026-03-01T00:00:00Z",
				current_cycle_number: 2,
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

		it("does not let an old completed invoice clear newer past-due state", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_newer_failure",
					status: "past_due",
					providerStatus: "ACTIVE",
					billingStatus: "past_due",
					providerUpdatedAt: new Date("2026-03-01T00:00:00.000Z"),
					periodEnd: new Date("2026-03-01T00:00:00.000Z"),
					currentCycleNumber: 2,
				}),
			});
			client.getInvoice.mockResolvedValue({
				id: "inv_old_success",
				subscription_id: "sub_newer_failure",
				currency: "SAR",
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_newer_failure",
				status: "ACTIVE",
				updated_at: "2026-03-01T00:00:00.000Z",
				current_period_end: "2026-04-01T00:00:00.000Z",
				current_cycle_number: 3,
				organization_consumer_id: "cons_1",
			});
			const callback = vi.fn<NonNullable<SubscriptionCallbacks["onSubscriptionRenewed"]>>();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "INVOICE_COMPLETED",
					entity_type: "INVOICE",
					entity_id: "inv_old_success",
					timestamp: "2026-02-01T00:00:00.000Z",
					data: { invoice: { id: "inv_old_success", url: "x" } },
				}),
				client,
				resolvedPlans(),
				{ onSubscriptionRenewed: callback },
			);

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "past_due",
				billingStatus: "past_due",
				providerStatus: "ACTIVE",
			});
			expect(callback).not.toHaveBeenCalled();
		});

		it("ignores invoices without subscription_id (one-off invoices)", async () => {
			const ctx = createMockSyncContext();
			client.getInvoice.mockResolvedValue({ id: "inv_2", currency: "SAR" });

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

		it("does not report the initial completed invoice as a renewal", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_initial",
					status: "incomplete",
					periodEnd: null,
					currentCycleNumber: null,
				}),
			});
			client.getInvoice.mockResolvedValue({
				id: "inv_initial",
				subscription_id: "sub_initial",
				currency: "SAR",
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_initial",
				status: "ACTIVE",
				current_period_end: "2026-03-01T00:00:00Z",
				current_cycle_number: 1,
				organization_consumer_id: "cons_1",
			});
			const callback = vi.fn();

			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "INVOICE_COMPLETED",
					entity_type: "INVOICE",
					entity_id: "inv_initial",
					data: { invoice: { id: "inv_initial", url: "x" } },
				}),
				client,
				resolvedPlans(),
				{ onSubscriptionRenewed: callback },
			);

			expect(callback).not.toHaveBeenCalled();
		});

		it("retries a failed renewal callback after the local period was projected", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_retry_renewal",
					status: "active",
					periodEnd: new Date("2026-02-01T00:00:00Z"),
					currentCycleNumber: 1,
				}),
			});
			client.getInvoice.mockResolvedValue({
				id: "inv_retry_renewal",
				subscription_id: "sub_retry_renewal",
				currency: "SAR",
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_retry_renewal",
				status: "ACTIVE",
				current_period_end: "2026-03-01T00:00:00Z",
				current_cycle_number: 2,
				organization_consumer_id: "cons_1",
			});
			const callback = vi
				.fn()
				.mockRejectedValueOnce(new Error("renewal callback unavailable"))
				.mockResolvedValueOnce(undefined);
			const payload = createMockWebhookPayload({
				event_type: "INVOICE_COMPLETED",
				entity_type: "INVOICE",
				entity_id: "inv_retry_renewal",
				data: { invoice: { id: "inv_retry_renewal", url: "x" } },
			});

			await expect(
				syncWebhookPayload(ctx, payload, client, resolvedPlans(), {
					onSubscriptionRenewed: callback,
				}),
			).rejects.toThrow(/renewal callback unavailable/);
			expect(ctx.adapter.tables.subscription?.[0]?.currentCycleNumber).toBe(2);

			await expect(
				syncWebhookPayload(ctx, payload, client, resolvedPlans(), {
					onSubscriptionRenewed: callback,
				}),
			).resolves.toBeUndefined();
			expect(callback).toHaveBeenCalledTimes(2);
			expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
				status: "completed",
				lastError: null,
			});
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

		it("retries userland callback errors by default", async () => {
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
			).rejects.toThrow("userland boom");
			expect(ctx.logs.error.some((m) => m.includes("userland boom"))).toBe(true);
			expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
				status: "pending",
				lastError: "Subscription callback onSubscriptionActivated failed: userland boom",
				lockedAt: null,
				lockedBy: null,
			});
			expect(ctx.adapter.tables.streampayWebhookEvent?.[0]?.nextAttemptAt).toBeInstanceOf(Date);

			const row = (ctx.adapter.tables.subscription ?? [])[0];
			expect(row?.status).toBe("active");
		});

		it("can log callback errors without retrying when explicitly configured", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					streampaySubscriptionId: "sub_log_only",
					status: "incomplete",
				}),
			});
			client.getSubscription.mockResolvedValue({
				id: "sub_log_only",
				status: "ACTIVE",
				organization_consumer_id: "cons_1",
			});
			const callback = vi.fn().mockRejectedValue(new Error("log-only boom"));

			await expect(
				syncWebhookPayload(
					ctx,
					createMockWebhookPayload({
						event_type: "SUBSCRIPTION_ACTIVATED",
						entity_id: "sub_log_only",
					}),
					client,
					resolvedPlans(),
					{ onSubscriptionActivated: callback },
					{ retryOnCallbackError: false },
				),
			).resolves.toBeUndefined();
			expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
				status: "completed",
			});
		});
	});
});

describe("classifyWebhookFailure", () => {
	it("classifies 4xx SDK errors (not 404/429) as PERMANENT — stop StreamPay retries", () => {
		expect(classifyWebhookFailure(mockApiError(400, {}))).toBe("PERMANENT");
		expect(classifyWebhookFailure(mockApiError(403, {}))).toBe("PERMANENT");
	});

	it("classifies 404 as TRANSIENT — read-after-write races ride the retry budget", () => {
		expect(classifyWebhookFailure(mockApiError(404, {}))).toBe("TRANSIENT");
	});

	it("classifies 429/5xx/unknown errors as TRANSIENT — let StreamPay retry", () => {
		expect(classifyWebhookFailure(mockApiError(429, {}))).toBe("TRANSIENT");
		expect(classifyWebhookFailure(mockApiError(503, {}))).toBe("TRANSIENT");
		expect(classifyWebhookFailure(new Error("network"))).toBe("TRANSIENT");
	});
});
