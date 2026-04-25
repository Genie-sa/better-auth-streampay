import { createHmac } from "node:crypto";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockAPIError } = vi.hoisted(() => {
	class MockAPIError extends Error {
		public readonly code: string;
		public readonly data: { message?: string } | undefined;
		constructor(code: string, data?: { message?: string }) {
			super(data?.message ?? code);
			this.name = "APIError";
			this.code = code;
			this.data = data;
		}
	}
	return { MockAPIError };
});

vi.mock("better-auth/api", () => ({
	APIError: MockAPIError,
	createAuthEndpoint: vi.fn((path: string, config: unknown, handler: unknown) => ({
		path,
		config,
		handler,
	})),
}));

import { webhooks } from "../src/plugins/webhooks";
import type { WebhookHandler } from "../src/webhooks/dispatcher";
import { unwrapHandler } from "./utils/better-auth-mock";
import { createTestStreamPayOptions } from "./utils/helpers";
import {
	createMockContext,
	createMockStreamPayClient,
	type MockCtx,
	type MockedStreamPayClient,
} from "./utils/mocks";

const SECRET = "whsec_test_secret_from_streampay_dashboard";

function signBody(body: string, ts: number = Math.floor(Date.now() / 1000)): string {
	const hex = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
	return `t=${ts},v1=${hex}`;
}

function makeWebhookRequest(body: string, signature: string | null): Request {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (signature !== null) headers["x-webhook-signature"] = signature;
	return new Request("http://localhost:3000/api/auth/streampay/webhooks", {
		method: "POST",
		headers,
		body,
	});
}

interface WebhookResponse {
	received: boolean;
}

describe("webhooks plugin", () => {
	let mockClient: MockedStreamPayClient;

	beforeEach(() => {
		mockClient = createMockStreamPayClient();
		vi.clearAllMocks();
	});

	describe("webhook endpoint handler", () => {
		let handler: (ctx: MockCtx) => Promise<WebhookResponse>;
		let onPayload: Mock<WebhookHandler>;
		let onPaymentSucceeded: Mock<WebhookHandler>;
		let onInvoiceCompleted: Mock<WebhookHandler>;

		beforeEach(() => {
			onPayload = vi.fn<WebhookHandler>();
			onPaymentSucceeded = vi.fn<WebhookHandler>();
			onInvoiceCompleted = vi.fn<WebhookHandler>();
			const plugin = webhooks({
				secret: SECRET,
				onPayload,
				onPaymentSucceeded,
				onInvoiceCompleted,
			});
			handler = unwrapHandler<WebhookResponse>(
				plugin(createTestStreamPayOptions({ client: mockClient })).endpoints.streampayWebhooks,
			);
		});

		it("accepts a valid signature and dispatches to the specific handler", async () => {
			const body = JSON.stringify({
				event_type: "PAYMENT_SUCCEEDED",
				entity_type: "PAYMENT",
				entity_id: "pay_1",
				entity_url: "https://stream-app-service.streampay.sa/api/v2/payments/pay_1",
				status: "SUCCEEDED",
				data: { payment: { id: "pay_1" } },
				timestamp: new Date().toISOString(),
			});

			const ctx = createMockContext({
				request: makeWebhookRequest(body, signBody(body)),
			});

			const result = await handler(ctx);

			expect(result).toEqual({ received: true });
			expect(onPayload).toHaveBeenCalledTimes(1);
			expect(onPaymentSucceeded).toHaveBeenCalledTimes(1);
			expect(onInvoiceCompleted).not.toHaveBeenCalled();
		});

		it("routes different event types to the right handler", async () => {
			const body = JSON.stringify({
				event_type: "INVOICE_COMPLETED",
				entity_type: "INVOICE",
				entity_id: "inv_1",
				entity_url: "",
				status: "COMPLETED",
				data: {},
				timestamp: new Date().toISOString(),
			});

			const ctx = createMockContext({
				request: makeWebhookRequest(body, signBody(body)),
			});
			await handler(ctx);

			expect(onInvoiceCompleted).toHaveBeenCalledTimes(1);
			expect(onPaymentSucceeded).not.toHaveBeenCalled();
		});

		it("rejects a payload with an invalid signature as UNAUTHORIZED", async () => {
			const body = JSON.stringify({ event_type: "PAYMENT_SUCCEEDED" });
			const ts = Math.floor(Date.now() / 1000);
			const forged = `t=${ts},v1=${createHmac("sha256", "wrong-secret")
				.update(`${ts}.${body}`)
				.digest("hex")}`;

			const ctx = createMockContext({
				request: makeWebhookRequest(body, forged),
			});

			await expect(handler(ctx)).rejects.toThrow(/INVALID_SIGNATURE/);
			expect(onPayload).not.toHaveBeenCalled();
		});

		it("rejects a missing x-webhook-signature header as UNAUTHORIZED", async () => {
			const body = JSON.stringify({ event_type: "PAYMENT_SUCCEEDED" });

			const ctx = createMockContext({
				request: makeWebhookRequest(body, null),
			});

			await expect(handler(ctx)).rejects.toThrow(/MISSING_HEADER/);
			expect(onPayload).not.toHaveBeenCalled();
		});

		it("rejects a body missing event_type as BAD_REQUEST", async () => {
			const body = JSON.stringify({ entity_type: "PAYMENT" });

			const ctx = createMockContext({
				request: makeWebhookRequest(body, signBody(body)),
			});

			await expect(handler(ctx)).rejects.toThrow(/missing `event_type`/);
		});

		it("still calls onPayload for unknown event types without routing", async () => {
			const body = JSON.stringify({
				event_type: "PAYMENT_LINK_SOMETHING_NEW",
				entity_type: "PAYMENT_LINK",
				entity_id: "x",
				entity_url: "",
				status: "",
				data: {},
				timestamp: new Date().toISOString(),
			});

			const ctx = createMockContext({
				request: makeWebhookRequest(body, signBody(body)),
			});

			const result = await handler(ctx);

			expect(result).toEqual({ received: true });
			expect(onPayload).toHaveBeenCalledTimes(1);
			expect(onPaymentSucceeded).not.toHaveBeenCalled();
		});

		it("propagates handler failures as INTERNAL_SERVER_ERROR with a log", async () => {
			onPaymentSucceeded.mockRejectedValue(new Error("database is down"));
			const body = JSON.stringify({
				event_type: "PAYMENT_SUCCEEDED",
				entity_type: "PAYMENT",
				entity_id: "pay_1",
				entity_url: "",
				status: "SUCCEEDED",
				data: {},
				timestamp: new Date().toISOString(),
			});

			const ctx = createMockContext({
				request: makeWebhookRequest(body, signBody(body)),
			});

			await expect(handler(ctx)).rejects.toThrow(/Webhook handler failed/);
			expect(ctx.context.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("database is down"),
			);
		});

		it("refuses to run when the secret is an empty string", async () => {
			const plugin = webhooks({ secret: "" });
			const noSecretHandler = unwrapHandler<WebhookResponse>(
				plugin(createTestStreamPayOptions({ client: mockClient })).endpoints.streampayWebhooks,
			);
			const body = JSON.stringify({ event_type: "PAYMENT_SUCCEEDED" });

			const ctx = createMockContext({
				request: makeWebhookRequest(body, signBody(body)),
			});

			await expect(noSecretHandler(ctx)).rejects.toThrow(/secret is not configured/);
		});
	});

	void MockAPIError;
});
