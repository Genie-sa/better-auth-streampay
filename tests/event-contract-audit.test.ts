import { describe, expect, it } from "vitest";
import { admin, subscriptions, webhooks } from "../src";
import type { SyncContext, WebhookEventRow } from "../src/plugins/subscriptions/sync";
import { callAuthEndpoint, createStreamPayTestInstance } from "./utils/auth-instance";

const sourceEvent = "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY:subscription:2026-10-10T00:00:00.000Z";
const plan = {
	name: "pro",
	productId: "known",
	priceInSmallestUnit: 100,
	billingInterval: "MONTH" as const,
};

describe.runIf(Number(process.versions.node.split(".")[0]) >= 22)(
	"admin event recovery contract",
	() => {
		it.each([
			false,
			true,
		])("discards encoded callback IDs with subscriptions configured=%s", async (withSubscriptions) => {
			const { auth, client, sessionSetter } = await createStreamPayTestInstance({
				use: [
					...(withSubscriptions ? [subscriptions({ plans: [plan] })] : []),
					webhooks({ secret: "test-only", deduplicate: true }),
					admin({ isAdmin: () => true }),
				],
			});
			const context = (await auth.$context) as SyncContext["context"];
			const eventId = `handlers:${sourceEvent}`;
			if (withSubscriptions) {
				await context.adapter.create({
					model: "subscription",
					data: {
						referenceId: "source-owner",
						plan: "pro",
						status: "active",
						streampaySubscriptionId: "source-owner",
						renewalCallbackEventId: sourceEvent,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				});
			}
			await context.adapter.create({
				model: "streampayWebhookEvent",
				data: {
					eventId,
					eventType: "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
					status: "dead_letter",
					attemptCount: 5,
					receivedAt: new Date(),
					rawPayload: "stored callback payload",
				},
			});
			await client.signUp.email(
				{ name: "Admin", email: "event-admin@example.com", password: "password123" },
				{ throw: true },
			);
			const headers = new Headers();
			await client.signIn.email(
				{ email: "event-admin@example.com", password: "password123" },
				{ throw: true, onSuccess: sessionSetter(headers) },
			);
			const path = `/admin/streampay/webhook-events/${encodeURIComponent(eventId)}`;
			const response = await callAuthEndpoint(auth, path, { method: "DELETE", headers });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ discarded: true, eventId });
			expect(
				await context.adapter.findOne<WebhookEventRow>({
					model: "streampayWebhookEvent",
					where: [{ field: "eventId", value: eventId }],
				}),
			).toMatchObject({ status: "completed", rawPayload: null });
			if (withSubscriptions) {
				expect(
					await context.adapter.findOne({
						model: "subscription",
						where: [{ field: "streampaySubscriptionId", value: "source-owner" }],
					}),
				).toMatchObject({ renewalCallbackEventId: sourceEvent });
			}
		});

		it.each([
			"SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
			"INVOICE_COMPLETED",
		])("discarding %s releases only its matching callback owner", async (eventType) => {
			const eventId = `${eventType}:subscription:2026-10-10T00:00:00.000Z`;
			const { auth, client, sessionSetter } = await createStreamPayTestInstance({
				use: [
					subscriptions({ plans: [plan] }),
					webhooks({ secret: "test-only", deduplicate: true }),
					admin({ isAdmin: () => true }),
				],
			});
			const context = (await auth.$context) as SyncContext["context"];
			await context.adapter.create({
				model: "streampayWebhookEvent",
				data: {
					eventId,
					eventType,
					status: "dead_letter",
					attemptCount: 5,
					receivedAt: new Date(),
					rawPayload: "stored renewal payload",
				},
			});
			for (const [subscriptionId, owner] of [
				["owned", eventId],
				["unrelated", "another-event"],
			]) {
				await context.adapter.create({
					model: "subscription",
					data: {
						referenceId: subscriptionId,
						plan: "pro",
						status: "active",
						streampaySubscriptionId: subscriptionId,
						renewalCallbackEventId: owner,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				});
			}
			await client.signUp.email(
				{ name: "Admin", email: "event-admin@example.com", password: "password123" },
				{ throw: true },
			);
			const headers = new Headers();
			await client.signIn.email(
				{ email: "event-admin@example.com", password: "password123" },
				{ throw: true, onSuccess: sessionSetter(headers) },
			);
			const response = await callAuthEndpoint(
				auth,
				`/admin/streampay/webhook-events/${encodeURIComponent(eventId)}`,
				{ method: "DELETE", headers },
			);
			expect(response.status).toBe(200);
			expect(
				await context.adapter.findOne({
					model: "subscription",
					where: [{ field: "streampaySubscriptionId", value: "owned" }],
				}),
			).toMatchObject({ renewalCallbackEventId: null });
			expect(
				await context.adapter.findOne({
					model: "subscription",
					where: [{ field: "streampaySubscriptionId", value: "unrelated" }],
				}),
			).toMatchObject({ renewalCallbackEventId: "another-event" });
		});
	},
);
