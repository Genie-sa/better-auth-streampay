import { describe, expect, it } from "vitest";
import {
	deleteReservedSubscription,
	resumeOrReserveCheckoutSlot,
} from "../src/plugins/subscriptions/checkout-reservation";
import { syncWebhookPayload } from "../src/plugins/subscriptions/sync";
import {
	PLAN_NAME_METADATA_KEY,
	REFERENCE_ID_METADATA_KEY,
	REFERENCE_TYPE_METADATA_KEY,
	SUBSCRIPTION_ROW_ID_METADATA_KEY,
} from "../src/plugins/subscriptions/types";
import { mockApiError } from "./utils/helpers";
import { createMockStreamPayClient } from "./utils/mocks";
import {
	createMockSubscriptionRow,
	createMockSyncContext,
	createMockWebhookPayload,
} from "./utils/subscription-helpers";

const plan = {
	name: "pro",
	productId: "prod_pro",
	priceInSmallestUnit: 9900,
	billingInterval: "MONTH" as const,
};
const plans = { list: [plan], byName: new Map([[plan.name, plan]]) };

describe("billing correlation audit", () => {
	it.each([
		{ field: "streampaySubscriptionId", value: "sub_confirmed_elsewhere" },
		{ field: "streampayConsumerId", value: "cons_confirmed_elsewhere" },
	])("does not overwrite a concurrent $field binding during first confirmation", async ({
		field,
		value,
	}) => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({ id: "binding_checkout" }),
		});
		const client = createMockStreamPayClient();
		// SDK detailed fields are optional. An incomplete projection must still preserve ownership.
		client.getSubscription.mockResolvedValue({
			id: "sub_initial_binding",
			organization_consumer_id: "cons_mocked",
		});
		const update = ctx.adapter.update;
		let bindingChanged = false;
		ctx.adapter.update = async (input) => {
			if (input.model === "subscription" && !bindingChanged) {
				bindingChanged = true;
				await update({
					model: "subscription",
					where: [{ field: "id", value: "binding_checkout" }],
					update: { [field]: value },
				});
			}
			return update(input);
		};
		await expect(
			syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					entity_id: "sub_initial_binding",
					data: {
						metadata: {
							[PLAN_NAME_METADATA_KEY]: "pro",
							[REFERENCE_ID_METADATA_KEY]: "user-123",
							[REFERENCE_TYPE_METADATA_KEY]: "user",
							[SUBSCRIPTION_ROW_ID_METADATA_KEY]: "binding_checkout",
						},
					},
				}),
				client,
				plans,
				{},
			),
		).rejects.toThrow(/state changed during reconciliation/);
		expect(ctx.adapter.tables.subscription?.[0]?.[field]).toBe(value);
	});
	it("keeps a webhook retryable when Stream returns a snapshot older than stored provider state", async () => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				streampaySubscriptionId: "sub_stale_snapshot",
				status: "canceled",
				providerUpdatedAt: new Date("2026-03-01T00:00:00Z"),
			}),
		});
		const client = createMockStreamPayClient();
		client.getSubscription.mockResolvedValue({
			id: "sub_stale_snapshot",
			status: "ACTIVE",
			updated_at: "2026-02-01T00:00:00Z",
			items: [{ product_id: plan.productId, quantity: 1 }],
		});
		await expect(
			syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_ACTIVATED",
					entity_id: "sub_stale_snapshot",
					timestamp: "2026-03-02T00:00:00Z",
				}),
				client,
				plans,
				{},
			),
		).rejects.toThrow(/stale subscription state/);
		expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
			status: "canceled",
			providerUpdatedAt: new Date("2026-03-01T00:00:00Z"),
		});
		expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
			status: "pending",
			lockedBy: null,
		});
	});
	it("preserves cancellation when an older first-checkout confirmation finishes last", async () => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "ordered_subscription",
				streampaySubscriptionId: null,
				status: "incomplete",
				providerUpdatedAt: new Date("2026-01-01T00:00:00Z"),
			}),
		});
		const client = createMockStreamPayClient();
		client.getSubscription
			.mockResolvedValueOnce({
				id: "sub_ordered",
				status: "ACTIVE",
				organization_consumer_id: "cons_mocked",
				updated_at: "2026-02-01T00:00:00Z",
				items: [{ product_id: plan.productId, quantity: 1 }],
			})
			.mockResolvedValueOnce({
				id: "sub_ordered",
				status: "CANCELED",
				organization_consumer_id: "cons_mocked",
				updated_at: "2026-03-01T00:00:00Z",
				items: [{ product_id: plan.productId, quantity: 1 }],
			});
		let releaseActivation: () => void = () => undefined;
		let announceActivation: () => void = () => undefined;
		const activationBlocked = new Promise<void>((resolve) => {
			announceActivation = resolve;
		});
		const activationRelease = new Promise<void>((resolve) => {
			releaseActivation = resolve;
		});
		const update = ctx.adapter.update;
		ctx.adapter.update = async (args) => {
			if (
				args.model === "subscription" &&
				"status" in args.update &&
				args.update.status === "active"
			) {
				announceActivation();
				await activationRelease;
			}
			return update(args);
		};
		const activation = syncWebhookPayload(
			ctx,
			createMockWebhookPayload({
				event_type: "SUBSCRIPTION_ACTIVATED",
				entity_id: "sub_ordered",
				timestamp: "2026-02-01T00:00:00Z",
				data: {
					metadata: {
						[PLAN_NAME_METADATA_KEY]: "pro",
						[REFERENCE_ID_METADATA_KEY]: "user-123",
						[REFERENCE_TYPE_METADATA_KEY]: "user",
						[SUBSCRIPTION_ROW_ID_METADATA_KEY]: "ordered_subscription",
					},
				},
			}),
			client,
			plans,
			{},
		);
		await activationBlocked;
		try {
			await syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CANCELED",
					entity_id: "sub_ordered",
					timestamp: "2026-03-01T00:00:00Z",
					data: {
						metadata: {
							[PLAN_NAME_METADATA_KEY]: "pro",
							[REFERENCE_ID_METADATA_KEY]: "user-123",
							[REFERENCE_TYPE_METADATA_KEY]: "user",
							[SUBSCRIPTION_ROW_ID_METADATA_KEY]: "ordered_subscription",
						},
					},
				}),
				client,
				plans,
				{},
			);
		} finally {
			releaseActivation();
		}
		await expect(activation).rejects.toThrow(/state changed during reconciliation/);
		expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
			status: "canceled",
			activeSlotKey: null,
			providerUpdatedAt: new Date("2026-03-01T00:00:00Z"),
		});
		expect(
			ctx.adapter.tables.streampayWebhookEvent?.find(
				(row) => row.eventType === "SUBSCRIPTION_ACTIVATED",
			),
		).toMatchObject({
			status: "pending",
			lockedBy: null,
		});
	});
	it("retains a checkout confirmed by webhook before the provider request reports a timeout", async () => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "confirmed_before_timeout",
				status: "active",
				streampaySubscriptionId: "sub_paid",
			}),
		});
		await deleteReservedSubscription(
			ctx.adapter,
			"confirmed_before_timeout",
			{
				error: () => undefined,
			},
			"provider timeout",
		);
		expect(ctx.adapter.tables.subscription).toHaveLength(1);
		expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
			status: "active",
			streampaySubscriptionId: "sub_paid",
		});
	});
	it("does not expire a reservation that becomes active while its payment link is being checked", async () => {
		const ctx = createMockSyncContext();
		const row = createMockSubscriptionRow({
			id: "checkout_activating",
			activeSlotKey: "unique-slot",
			streampayPaymentLinkId: "pl_pending",
		});
		await ctx.adapter.create({ model: "subscription", data: row });
		const client = createMockStreamPayClient();
		client.getPaymentLink.mockImplementation(async () => {
			await ctx.adapter.update({
				model: "subscription",
				where: [{ field: "id", value: row.id }],
				update: { status: "active", streampaySubscriptionId: "sub_confirmed" },
			});
			throw mockApiError(404, "payment link disappeared");
		});
		await resumeOrReserveCheckoutSlot({
			client,
			adapter: ctx.adapter,
			candidates: [row],
			createReservation: async () => ({
				consumerId: "cons_mocked",
				data: createMockSubscriptionRow({ id: "new_checkout", activeSlotKey: "unique-slot" }),
			}),
			activeSlotKey: "unique-slot",
			planName: "pro",
			seats: 1,
			now: Date.now(),
			log: ctx.context.logger,
		}).catch(() => undefined);
		expect(ctx.adapter.tables.subscription?.find((stored) => stored.id === row.id)).toMatchObject({
			status: "active",
			activeSlotKey: "unique-slot",
			streampaySubscriptionId: "sub_confirmed",
		});
		expect(ctx.adapter.tables.subscription).toHaveLength(1);
	});

	it("does not confirm a different checkout when a signed event names another payment link", async () => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "reserved_other_checkout",
				streampayPaymentLinkId: "pl_other",
			}),
		});
		const client = createMockStreamPayClient();
		client.getSubscription.mockResolvedValue({
			id: "sub_paid_external",
			status: "ACTIVE",
			organization_consumer_id: "cons_mocked",
			items: [{ product_id: "prod_pro", quantity: 1 }],
			latest_invoice: { payment_link_id: "pl_paid_external", currency: "SAR" },
		});
		await syncWebhookPayload(
			ctx,
			createMockWebhookPayload({
				entity_id: "sub_paid_external",
				data: {
					metadata: {
						[PLAN_NAME_METADATA_KEY]: "pro",
						[REFERENCE_ID_METADATA_KEY]: "user-123",
						[REFERENCE_TYPE_METADATA_KEY]: "user",
					},
				},
			}),
			client,
			plans,
			{},
		);
		expect(
			ctx.adapter.tables.subscription?.find((row) => row.id === "reserved_other_checkout"),
		).toMatchObject({ status: "incomplete", streampaySubscriptionId: null });
	});

	it("rejects an explicit reservation whose consumer differs from the provider subscription", async () => {
		const ctx = createMockSyncContext();
		await ctx.adapter.create({
			model: "subscription",
			data: createMockSubscriptionRow({
				id: "reserved_owned_consumer",
				streampayConsumerId: "cons_expected",
				streampayPaymentLinkId: "pl_same",
			}),
		});
		const client = createMockStreamPayClient();
		client.getSubscription.mockResolvedValue({
			id: "sub_other_consumer",
			status: "ACTIVE",
			organization_consumer_id: "cons_other",
			items: [{ product_id: "prod_pro", quantity: 1 }],
			latest_invoice: { payment_link_id: "pl_same", currency: "SAR" },
		});
		await expect(
			syncWebhookPayload(
				ctx,
				createMockWebhookPayload({
					entity_id: "sub_other_consumer",
					data: {
						metadata: {
							[PLAN_NAME_METADATA_KEY]: "pro",
							[REFERENCE_ID_METADATA_KEY]: "user-123",
							[REFERENCE_TYPE_METADATA_KEY]: "user",
							[SUBSCRIPTION_ROW_ID_METADATA_KEY]: "reserved_owned_consumer",
						},
					},
				}),
				client,
				plans,
				{},
			),
		).rejects.toThrow(/correlation/i);
		expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
			status: "incomplete",
			streampayConsumerId: "cons_expected",
			streampaySubscriptionId: null,
		});
	});
});
