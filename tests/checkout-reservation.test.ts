import { describe, expect, it } from "vitest";
import {
	attachCheckoutLink,
	resumeOrReserveCheckoutSlot,
	yieldReservationToPaidSubscription,
} from "../src/plugins/subscriptions/checkout-reservation";
import { UPGRADE_IDEMPOTENCY_WINDOW_MS } from "../src/plugins/subscriptions/types";
import { mockApiError } from "./utils/helpers";
import { createMockStreamPayClient } from "./utils/mocks";
import { createMockSubscriptionRow, createMockSyncContext } from "./utils/subscription-helpers";

const SLOT = "user:user-123:default";

function staleReservation(overrides: Parameters<typeof createMockSubscriptionRow>[0] = {}) {
	return createMockSubscriptionRow({
		id: "stale_checkout",
		activeSlotKey: SLOT,
		status: "incomplete",
		plan: "starter",
		createdAt: new Date(Date.now() - UPGRADE_IDEMPOTENCY_WINDOW_MS - 1000),
		...overrides,
	});
}

function reserve(
	ctx: ReturnType<typeof createMockSyncContext>,
	client = createMockStreamPayClient(),
) {
	return resumeOrReserveCheckoutSlot({
		client,
		adapter: ctx.adapter,
		candidates: [],
		createReservation: async () => ({
			consumerId: "cons_mocked",
			data: createMockSubscriptionRow({ id: "new_checkout", activeSlotKey: SLOT }),
		}),
		activeSlotKey: SLOT,
		planName: "pro",
		seats: 1,
		now: Date.now(),
		log: ctx.context.logger,
	});
}

describe("checkout reservation", () => {
	describe("replacing a stale reservation", () => {
		it("deactivates the stale link before releasing its slot to the new checkout", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: staleReservation({ streampayPaymentLinkId: "pl_stale" }),
			});
			const client = createMockStreamPayClient();

			const result = await reserve(ctx, client);

			expect(result.kind).toBe("reserved");
			expect(client.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_stale", {
				status: "INACTIVE",
			});
			expect(ctx.adapter.tables.subscription).toMatchObject([
				{ id: "stale_checkout", status: "incomplete_expired", activeSlotKey: null },
				{ id: "new_checkout", activeSlotKey: SLOT },
			]);
		});

		it("keeps the stale reservation when its link cannot be deactivated", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: staleReservation({ streampayPaymentLinkId: "pl_stale" }),
			});
			const client = createMockStreamPayClient();
			client.updatePaymentLinkStatus.mockRejectedValue(mockApiError(503, "unavailable"));

			await expect(reserve(ctx, client)).rejects.toThrow(
				"Unable to replace the previous subscription checkout.",
			);

			expect(ctx.adapter.tables.subscription).toMatchObject([
				{ id: "stale_checkout", status: "incomplete", activeSlotKey: SLOT },
			]);
		});

		it("loses the release when a payment link was attached after the reservation was read", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({ model: "subscription", data: staleReservation() });
			const update = ctx.adapter.update.bind(ctx.adapter);
			ctx.adapter.update = async (args) => {
				const releasing = args.where.some(
					(clause) => clause.field === "activeSlotKey" && clause.value === SLOT,
				);
				const stored = ctx.adapter.tables.subscription?.[0];
				if (releasing && stored && !stored.streampayPaymentLinkId) {
					stored.streampayPaymentLinkId = "pl_attached_concurrently";
				}
				return update(args);
			};

			await expect(reserve(ctx)).rejects.toMatchObject({
				body: { code: "SUBSCRIPTION_CHECKOUT_IN_PROGRESS" },
			});

			expect(ctx.adapter.tables.subscription).toMatchObject([
				{
					id: "stale_checkout",
					status: "incomplete",
					activeSlotKey: SLOT,
					streampayPaymentLinkId: "pl_attached_concurrently",
				},
			]);
		});
	});

	describe("attaching the payment link", () => {
		it("deactivates the new link and fails when the reservation was released meanwhile", async () => {
			const ctx = createMockSyncContext();
			const reservation = createMockSubscriptionRow({
				id: "released_meanwhile",
				status: "incomplete_expired",
				activeSlotKey: null,
			});
			await ctx.adapter.create({ model: "subscription", data: reservation });
			const client = createMockStreamPayClient();

			await expect(
				attachCheckoutLink({
					client,
					adapter: ctx.adapter,
					reservation,
					consumerId: "cons_mocked",
					link: { id: "pl_new", url: "https://pay.example.test/pl_new" },
					log: ctx.context.logger,
				}),
			).rejects.toMatchObject({ body: { code: "SUBSCRIPTION_CHECKOUT_IN_PROGRESS" } });

			expect(client.updatePaymentLinkStatus).toHaveBeenCalledWith("pl_new", { status: "INACTIVE" });
		});

		it("records an unusable link on the released reservation", async () => {
			const ctx = createMockSyncContext();
			const reservation = createMockSubscriptionRow({ id: "no_url", activeSlotKey: SLOT });
			await ctx.adapter.create({ model: "subscription", data: reservation });

			await expect(
				attachCheckoutLink({
					client: createMockStreamPayClient(),
					adapter: ctx.adapter,
					reservation,
					consumerId: "cons_mocked",
					link: { id: "pl_no_url", url: null },
					log: ctx.context.logger,
				}),
			).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR" });

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "incomplete_expired",
				activeSlotKey: null,
				streampayPaymentLinkId: "pl_no_url",
			});
		});
	});

	describe("yielding to a paid subscription", () => {
		it("releases an unpaid reservation even when its link cannot be deactivated", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: staleReservation({ streampayPaymentLinkId: "pl_unpaid" }),
			});
			const client = createMockStreamPayClient();
			client.updatePaymentLinkStatus.mockRejectedValue(mockApiError(503, "unavailable"));

			await yieldReservationToPaidSubscription({
				client,
				adapter: ctx.adapter,
				slotKey: SLOT,
				ownerRowId: "paid_row",
				streampaySubscriptionId: "sub_paid",
				log: ctx.context.logger,
			});

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({
				status: "incomplete_expired",
				activeSlotKey: null,
			});
			expect(ctx.logs.error.some((line) => line.includes("deactivate it manually"))).toBe(true);
		});

		it("refuses to take the slot from a live subscription", async () => {
			const ctx = createMockSyncContext();
			await ctx.adapter.create({
				model: "subscription",
				data: createMockSubscriptionRow({
					id: "live_row",
					status: "active",
					activeSlotKey: SLOT,
					streampaySubscriptionId: "sub_live",
				}),
			});

			await expect(
				yieldReservationToPaidSubscription({
					client: createMockStreamPayClient(),
					adapter: ctx.adapter,
					slotKey: SLOT,
					ownerRowId: "paid_row",
					streampaySubscriptionId: "sub_paid",
					log: ctx.context.logger,
				}),
			).rejects.toMatchObject({ name: "SubscriptionCorrelationError" });

			expect(ctx.adapter.tables.subscription?.[0]).toMatchObject({ activeSlotKey: SLOT });
		});
	});
});
