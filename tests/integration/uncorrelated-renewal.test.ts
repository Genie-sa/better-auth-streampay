import { describe, expect, it, vi } from "vitest";
import { subscriptions, webhooks } from "../../src";
import { subscriptionSlotKey } from "../../src/plugins/subscriptions/types";
import {
	type Harness,
	harness,
	providerSubscription,
	SECRET,
	subscriptionEvent,
	TEAM,
	TEST_WITH,
} from "../utils/webhook-harness";

const RENEWAL_EVENT = "2026-04-01T00:00:01.000Z";

function invoiceCompleted(invoiceId: string, timestamp = RENEWAL_EVENT) {
	return {
		event_type: "INVOICE_COMPLETED",
		entity_type: "INVOICE",
		entity_id: invoiceId,
		timestamp,
		data: { invoice: { id: invoiceId, url: "" } },
	};
}

/** A checkout whose creation webhooks never arrived; StreamPay bills every cycle through its link. */
async function paidCheckoutWithoutCreationEvents(h: Harness, cycle: number, invoiceId: string) {
	expect((await h.upgrade({ plan: TEAM.name, seats: 1 })).status).toBe(200);
	const linkInput = h.stream.createPaymentLink.mock.calls[0]?.[0];
	h.stream.getPaymentLink.mockResolvedValue({
		id: "pl_1",
		status: "COMPLETED",
		custom_metadata: linkInput?.custom_metadata,
	} as never);
	h.stream.getSubscription.mockResolvedValue(
		providerSubscription("sub_late", "ACTIVE", {
			current_cycle_number: cycle,
			latest_invoice: { id: invoiceId, status: "COMPLETED", payment_link_id: "pl_1" },
		}),
	);
	h.stream.getInvoice.mockResolvedValue({ id: invoiceId, subscription_id: "sub_late" } as never);
}

describe(`renewal evidence for an unlinked subscription (${TEST_WITH})`, () => {
	it("links the checkout and reports the renewal its creation webhooks missed", async () => {
		const onSubscriptionRenewed = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], onSubscriptionRenewed }),
			webhooks({ secret: SECRET }),
		]);
		await paidCheckoutWithoutCreationEvents(h, 3, "inv_3");

		expect((await h.deliver(invoiceCompleted("inv_3"))).status).toBe(200);

		expect(await h.rows("subscription")).toMatchObject([
			{
				streampaySubscriptionId: "sub_late",
				status: "active",
				activeSlotKey: subscriptionSlotKey("user", h.userId, null),
				currentCycleNumber: 3,
				renewedCycleNumber: 3,
			},
		]);
		expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
	});

	it("links on the first invoice without reporting a renewal, and later events still fire", async () => {
		const onSubscriptionRenewed = vi.fn();
		const onSubscriptionActivated = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], onSubscriptionRenewed, onSubscriptionActivated }),
			webhooks({ secret: SECRET }),
		]);
		await paidCheckoutWithoutCreationEvents(h, 1, "inv_1");

		expect((await h.deliver(invoiceCompleted("inv_1"))).status).toBe(200);
		expect(
			(await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_late", RENEWAL_EVENT)))
				.status,
		).toBe(200);

		expect(onSubscriptionRenewed).not.toHaveBeenCalled();
		expect(onSubscriptionActivated).toHaveBeenCalledTimes(1);
		expect(await h.rows("subscription")).toMatchObject([
			{ streampaySubscriptionId: "sub_late", renewedCycleNumber: 1 },
		]);
	});

	it("ignores renewal evidence for a subscription the plugin did not check out", async () => {
		const onSubscriptionRenewed = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], onSubscriptionRenewed }),
			webhooks({ secret: SECRET }),
		]);
		h.stream.getSubscription.mockResolvedValue(
			providerSubscription("sub_foreign", "ACTIVE", {
				current_cycle_number: 4,
				latest_invoice: { id: "inv_foreign", status: "COMPLETED", payment_link_id: "pl_foreign" },
			}),
		);
		h.stream.getInvoice.mockResolvedValue({
			id: "inv_foreign",
			subscription_id: "sub_foreign",
		} as never);

		expect((await h.deliver(invoiceCompleted("inv_foreign"))).status).toBe(200);

		expect(await h.rows("subscription")).toEqual([]);
		expect(h.stream.getPaymentLink).not.toHaveBeenCalled();
		expect(onSubscriptionRenewed).not.toHaveBeenCalled();
	});

	it("still reports the renewal when a creation webhook links the checkout concurrently", async () => {
		const onSubscriptionRenewed = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], onSubscriptionRenewed }),
			webhooks({ secret: SECRET }),
		]);
		await paidCheckoutWithoutCreationEvents(h, 3, "inv_3");
		const [reservation] = await h.rows("subscription");
		h.stream.getSubscription.mockResolvedValue(
			providerSubscription("sub_late", "ACTIVE", {
				current_cycle_number: 3,
				updated_at: "2026-04-01T00:05:00.000Z",
				latest_invoice: { id: "inv_3", status: "COMPLETED", payment_link_id: "pl_1" },
			}),
		);
		const link = await h.stream.getPaymentLink("pl_1");
		h.stream.getPaymentLink.mockImplementationOnce(async () => {
			await h.deliver(
				subscriptionEvent(
					h,
					"SUBSCRIPTION_CREATED",
					"sub_late",
					"2026-04-01T00:05:01.000Z",
					String(reservation?.id),
				),
			);
			return link;
		});

		expect((await h.deliver(invoiceCompleted("inv_3"))).status).toBe(200);

		expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
		expect(await h.rows("subscription")).toMatchObject([
			{ streampaySubscriptionId: "sub_late", renewedCycleNumber: 3 },
		]);
	});

	it("uses the snapshot it linked with when StreamPay changed between reads", async () => {
		const onSubscriptionRenewed = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], onSubscriptionRenewed }),
			webhooks({ secret: SECRET }),
		]);
		await paidCheckoutWithoutCreationEvents(h, 3, "inv_3");
		const renewed = (updatedAt: string) =>
			providerSubscription("sub_late", "ACTIVE", {
				current_cycle_number: 3,
				updated_at: updatedAt,
				latest_invoice: { id: "inv_3", status: "COMPLETED", payment_link_id: "pl_1" },
			});
		h.stream.getSubscription
			.mockResolvedValueOnce(renewed("2026-04-01T00:00:00.000Z"))
			.mockResolvedValue(renewed("2026-04-01T00:00:30.000Z"));

		expect((await h.deliver(invoiceCompleted("inv_3"))).status).toBe(200);

		expect(onSubscriptionRenewed).toHaveBeenCalledTimes(1);
	});

	it("does not report a renewal when an already linked row first learns its cycle", async () => {
		const onSubscriptionRenewed = vi.fn();
		const h = await harness([
			subscriptions({ plans: [TEAM], onSubscriptionRenewed }),
			webhooks({ secret: SECRET }),
		]);
		h.stream.getSubscription.mockResolvedValue(providerSubscription("sub_legacy", "ACTIVE"));
		await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_ACTIVATED", "sub_legacy", RENEWAL_EVENT));
		h.stream.getSubscription.mockResolvedValue(
			providerSubscription("sub_legacy", "ACTIVE", {
				current_cycle_number: 4,
				latest_invoice: { id: "inv_4", status: "COMPLETED" },
			}),
		);
		await h.deliver(subscriptionEvent(h, "SUBSCRIPTION_PLAN_UPDATED", "sub_legacy", RENEWAL_EVENT));

		await h.deliver(
			subscriptionEvent(h, "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY", "sub_legacy", RENEWAL_EVENT),
		);

		expect(onSubscriptionRenewed).not.toHaveBeenCalled();
		expect(await h.rows("subscription")).toMatchObject([{ renewedCycleNumber: 4 }]);
	});
});
