import type { GenericEndpointContext } from "better-auth";
import { describe, expect, it } from "vitest";
import { type StreamPayPluginRegistry, subscriptions } from "../src/plugins/subscriptions";
import type { WebhookEventRow } from "../src/plugins/subscriptions/sync";
import { webhooks } from "../src/plugins/webhooks";
import { createTestStreamPayOptions, mockApiError } from "./utils/helpers";
import { createMockStreamPayClient } from "./utils/mocks";
import { createMockSyncContext, createMockWebhookPayload } from "./utils/subscription-helpers";

const PLAN = {
	name: "pro",
	productId: "prod_pro",
	priceInSmallestUnit: 9900,
	billingInterval: "MONTH" as const,
};

describe("webhook inbox replay", () => {
	async function replayAfterTransientFailure(status: WebhookEventRow["status"]) {
		const client = createMockStreamPayClient();
		client.getSubscription.mockRejectedValue(mockApiError(503, { message: "unavailable" }, "GET"));
		const registry: StreamPayPluginRegistry = {};
		subscriptions({ plans: [PLAN] })(createTestStreamPayOptions({ client }), registry);
		const ctx = createMockSyncContext();
		const payload = createMockWebhookPayload({ event_type: "SUBSCRIPTION_ACTIVATED" });
		const eventId = `${payload.event_type}:${payload.entity_id}:${payload.timestamp}`;
		await ctx.adapter.create<WebhookEventRow>({
			model: "streampayWebhookEvent",
			data: {
				eventId,
				eventType: payload.event_type,
				status,
				attemptCount: 1,
				receivedAt: new Date(),
				lockedAt: null,
				lockedBy: null,
				rawPayload: JSON.stringify(payload),
			},
		});

		await expect(
			registry.replayWebhookEvent?.(ctx as unknown as GenericEndpointContext, eventId),
		).rejects.toThrow();
		return ctx.adapter.tables.streampayWebhookEvent?.[0];
	}

	it("keeps a pending event retryable when a manual replay hits a transient failure", async () => {
		expect(await replayAfterTransientFailure("pending")).toMatchObject({
			status: "pending",
			attemptCount: 2,
			lockedBy: null,
			deadLetteredAt: null,
		});
	});

	it("keeps a pending callback event retryable when its manual replay fails", async () => {
		const registry: StreamPayPluginRegistry = {};
		webhooks({
			secret: "test-only-secret",
			deduplicate: true,
			onPayload: () => {
				throw new Error("callback unavailable");
			},
		})(createTestStreamPayOptions(), registry);
		const ctx = createMockSyncContext();
		const payload = createMockWebhookPayload();
		await ctx.adapter.create<WebhookEventRow>({
			model: "streampayWebhookEvent",
			data: {
				eventId: "handlers:event",
				eventType: payload.event_type,
				status: "pending",
				attemptCount: 1,
				receivedAt: new Date(),
				lockedAt: null,
				lockedBy: null,
				rawPayload: JSON.stringify(payload),
			},
		});

		await expect(
			registry.replayWebhookHandler?.(ctx as unknown as GenericEndpointContext, "handlers:event"),
		).rejects.toThrow("callback unavailable");
		expect(ctx.adapter.tables.streampayWebhookEvent?.[0]).toMatchObject({
			status: "pending",
			attemptCount: 2,
		});
	});

	it("keeps a dead-lettered event in manual review when its replay fails", async () => {
		expect(await replayAfterTransientFailure("dead_letter")).toMatchObject({
			status: "dead_letter",
			attemptCount: 2,
			lockedBy: null,
		});
	});
});
