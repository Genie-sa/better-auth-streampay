import { describe, expect, it, vi } from "vitest";
import { subscriptions, webhooks } from "../../src";
import { subscriptionSlotKey } from "../../src/plugins/subscriptions/types";
import {
	harness,
	providerSubscription,
	SECRET,
	subscriptionEvent,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

// StreamPay stamps an event shortly after the write it reports (about 0.3 to 1.2 seconds in the
// sandbox). An event is stale once a later write reaches the row before the event is processed.
const ACTIVATED_WRITE = "2026-01-01T00:00:00.000Z";
const ACTIVATED_EVENT = "2026-01-01T00:00:01.000Z";
const CANCEL_WRITE = "2026-01-01T00:05:00.000Z";
const CANCEL_EVENT = "2026-01-01T00:05:01.000Z";
const PLAN_WRITE = "2026-01-01T00:10:00.000Z";
const PLAN_EVENT = "2026-01-01T00:10:01.000Z";

function invoiceEvent(invoiceId: string, timestamp: string) {
	return {
		event_type: "INVOICE_COMPLETED",
		entity_type: "INVOICE",
		entity_id: invoiceId,
		timestamp,
		data: { invoice: { id: invoiceId, url: "" } },
	};
}

describe(`stale lifecycle events end-to-end (${TEST_WITH})`, () => {
	describe("callbacks", () => {
		it("delivers a retried activation callback after a newer write reached the row", async () => {
			const onSubscriptionActivated = vi
				.fn()
				.mockRejectedValueOnce(new Error("provisioning unavailable"))
				.mockResolvedValue(undefined);
			const h = await harness([
				subscriptions({ plans: [TEAM], onSubscriptionActivated }),
				webhooks({ secret: SECRET }),
			]);
			const activated = subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_a", ACTIVATED_EVENT);
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_a", "ACTIVE", { updated_at: ACTIVATED_WRITE }),
			);
			expect((await h.deliver(activated)).status).toBe(500);

			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_a", "ACTIVE", {
					cancel_at_period_end: true,
					updated_at: CANCEL_WRITE,
				}),
			);
			expect(
				(
					await h.deliver(
						subscriptionEvent(h, "SUBSCRIPTION_CANCEL_AT_PERIOD_END", "sub_a", CANCEL_EVENT),
					)
				).status,
			).toBe(200);

			expect((await h.deliver(activated)).status).toBe(200);

			expect(onSubscriptionActivated).toHaveBeenCalledTimes(2);
			expect(onSubscriptionActivated.mock.calls[1]?.[0]).toMatchObject({
				subscription: { status: "active", cancelAtPeriodEnd: true },
			});
		});

		it("still suppresses a stale cancellation callback that the provider state contradicts", async () => {
			const onSubscriptionCanceled = vi.fn();
			const h = await harness([
				subscriptions({ plans: [TEAM], onSubscriptionCanceled }),
				webhooks({ secret: SECRET }),
			]);
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_b", "ACTIVE", { updated_at: PLAN_WRITE }),
			);
			await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_b", PLAN_EVENT));

			expect(
				(await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_CANCELED", "sub_b", CANCEL_EVENT)))
					.status,
			).toBe(200);

			expect(onSubscriptionCanceled).not.toHaveBeenCalled();
			expect(await h.rows("subscription")).toMatchObject([{ status: "active", canceledAt: null }]);
		});
	});

	describe("cancellation schedule", () => {
		it("stamps cancelScheduledAt from a late cancel event after another event saw the flag", async () => {
			const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_c", "ACTIVE", { updated_at: ACTIVATED_WRITE }),
			);
			await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_c", ACTIVATED_EVENT));
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_c", "ACTIVE", {
					cancel_at_period_end: true,
					current_period_end: "2026-02-01T00:00:00.000Z",
					updated_at: PLAN_WRITE,
				}),
			);
			await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_PLAN_UPDATED", "sub_c", PLAN_EVENT));

			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_CANCEL_AT_PERIOD_END", "sub_c", CANCEL_EVENT),
			);

			const [row] = await h.rows("subscription");
			expect(row).toMatchObject({ cancelAtPeriodEnd: true, cancelScheduledAt: expect.anything() });
			expect(new Date(String(row?.cancelScheduledAt)).toISOString()).toBe(CANCEL_EVENT);
		});
	});

	describe("renewal recovery", () => {
		async function pastDueSubscription() {
			const onSubscriptionRenewed = vi.fn();
			const h = await harness([
				subscriptions({ plans: [TEAM], onSubscriptionRenewed }),
				webhooks({ secret: SECRET }),
			]);
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_d", "ACTIVE", {
					updated_at: ACTIVATED_WRITE,
					latest_invoice: { id: "inv_2", status: "SENT" },
				}),
			);
			await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_d", ACTIVATED_EVENT));
			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_CYCLE_RENEWAL_FAILED", "sub_d", ACTIVATED_EVENT),
			);
			expect(await h.rows("subscription")).toMatchObject([
				{ status: "past_due", billingStatus: "past_due" },
			]);
			h.stream.getInvoice.mockResolvedValue({ id: "inv_2", subscription_id: "sub_d" } as never);
			return { h, onSubscriptionRenewed };
		}

		it("clears past_due when a late completed invoice is the subscription's latest invoice", async () => {
			const { h } = await pastDueSubscription();
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_d", "ACTIVE", {
					cancel_at_period_end: true,
					updated_at: CANCEL_WRITE,
					latest_invoice: { id: "inv_2", status: "COMPLETED" },
				}),
			);
			await h.deliver(
				subscriptionEvent(h, "SUBSCRIPTION_CANCEL_AT_PERIOD_END", "sub_d", CANCEL_EVENT),
			);

			expect((await h.deliver(invoiceEvent("inv_2", "2026-01-01T00:04:00.000Z"))).status).toBe(200);

			expect(await h.rows("subscription")).toMatchObject([
				{ status: "active", billingStatus: "current" },
			]);
		});

		it("keeps past_due when a late completed invoice is not the latest invoice", async () => {
			const { h } = await pastDueSubscription();
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_d", "ACTIVE", {
					updated_at: CANCEL_WRITE,
					latest_invoice: { id: "inv_2", status: "SENT" },
				}),
			);
			await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_PLAN_UPDATED", "sub_d", CANCEL_EVENT));
			h.stream.getInvoice.mockResolvedValue({ id: "inv_1", subscription_id: "sub_d" } as never);

			expect((await h.deliver(invoiceEvent("inv_1", "2026-01-01T00:04:00.000Z"))).status).toBe(200);

			expect(await h.rows("subscription")).toMatchObject([
				{ status: "past_due", billingStatus: "past_due" },
			]);
		});
	});

	describe("revival through renewal evidence", () => {
		async function inactiveSubscription() {
			const h = await harness([subscriptions({ plans: [TEAM] }), webhooks({ secret: SECRET })]);
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_old", "INACTIVE", { updated_at: ACTIVATED_WRITE }),
			);
			await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_INACTIVATED", "sub_old", ACTIVATED_EVENT));
			expect(await h.rows("subscription")).toMatchObject([
				{ status: "inactive", activeSlotKey: null },
			]);
			h.stream.getInvoice.mockResolvedValue({ id: "inv_old", subscription_id: "sub_old" } as never);
			return h;
		}

		it("reacquires the billing slot when a paid invoice revives a terminal subscription", async () => {
			const h = await inactiveSubscription();
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_old", "ACTIVE", { updated_at: CANCEL_WRITE }),
			);

			expect((await h.deliver(invoiceEvent("inv_old", CANCEL_EVENT))).status).toBe(200);

			expect(await h.rows("subscription")).toMatchObject([
				{ status: "active", activeSlotKey: subscriptionSlotKey("user", h.userId, null) },
			]);
		});

		it("dead-letters the revival instead of writing a second live subscription into the slot", async () => {
			const h = await inactiveSubscription();
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_new", "ACTIVE", { updated_at: CANCEL_WRITE }),
			);
			await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_new", CANCEL_EVENT));
			h.stream.getSubscription.mockResolvedValue(
				providerSubscription("sub_old", "ACTIVE", { updated_at: PLAN_WRITE }),
			);

			expect((await h.deliver(invoiceEvent("inv_old", PLAN_EVENT))).status).toBe(200);

			const rows = await h.rows("subscription");
			expect(rows.find((row) => row.streampaySubscriptionId === "sub_old")).toMatchObject({
				status: "inactive",
				activeSlotKey: null,
			});
			expect(rows.find((row) => row.streampaySubscriptionId === "sub_new")).toMatchObject({
				status: "active",
				activeSlotKey: subscriptionSlotKey("user", h.userId, null),
			});
			expect(
				(await h.rows("streampayWebhookEvent")).find(
					(row) => row.eventType === "INVOICE_COMPLETED",
				),
			).toMatchObject({ status: "dead_letter", lastErrorCode: "SubscriptionCorrelationError" });
		});
	});
});

describe(`renewal callbacks end-to-end (${TEST_WITH})`, () => {
	const CYCLE_1 = { current_cycle_number: 1, current_period_end: "2026-02-01T00:00:00.000Z" };
	const CYCLE_2 = {
		current_cycle_number: 2,
		current_period_end: "2026-03-01T00:00:00.000Z",
		latest_invoice: { id: "inv_renewal", status: "COMPLETED" },
	};

	async function renewedBeforeItsInvoiceEvent(legacyRow: boolean) {
		const onSubscriptionRenewed = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], onSubscriptionRenewed }),
			webhooks({ secret: SECRET }),
		]);
		h.stream.getSubscription.mockResolvedValue(
			providerSubscription("sub_r", "ACTIVE", { ...CYCLE_1, updated_at: ACTIVATED_WRITE }),
		);
		await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_r", ACTIVATED_EVENT));
		if (legacyRow) {
			const [row] = await h.rows("subscription");
			await h.setRow("subscription", String(row?.id), { renewedCycleNumber: null });
		}
		h.stream.getSubscription.mockResolvedValue(
			providerSubscription("sub_r", "ACTIVE", { ...CYCLE_2, updated_at: CANCEL_WRITE }),
		);
		await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_PLAN_CHANGED", "sub_r", CANCEL_EVENT));
		h.stream.getInvoice.mockResolvedValue({ id: "inv_renewal", subscription_id: "sub_r" } as never);
		return { h, onSubscriptionRenewed };
	}

	it("delivers the renewal callback when another event already wrote the new cycle", async () => {
		const { h, onSubscriptionRenewed } = await renewedBeforeItsInvoiceEvent(false);

		expect((await h.deliver(invoiceEvent("inv_renewal", CANCEL_EVENT))).status).toBe(200);
		expect(
			(
				await h.deliver(
					subscriptionEvent(h, "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY", "sub_r", PLAN_EVENT),
				)
			).status,
		).toBe(200);

		expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
		expect(await h.rows("subscription")).toMatchObject([
			{ currentCycleNumber: 2, renewedCycleNumber: 2, renewalCallbackEventId: null },
		]);
	});

	it("keeps the renewal baseline of a row written before the marker existed", async () => {
		const { h, onSubscriptionRenewed } = await renewedBeforeItsInvoiceEvent(true);

		expect((await h.deliver(invoiceEvent("inv_renewal", CANCEL_EVENT))).status).toBe(200);

		expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
	});
});
