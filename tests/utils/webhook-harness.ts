/** Real Better Auth instance with signed StreamPay webhooks; only the StreamPay HTTP client is mocked. */
import { createHmac } from "node:crypto";
import type { StreamPayPlugins } from "../../src/types";
import {
	callAuthEndpoint,
	createStreamPayTestInstance,
	type StreamPayTestInstance,
} from "./auth-instance";
import type { MockedStreamPayClient } from "./mocks";

export const SECRET = "test-only-secret";
export const TEST_WITH = process.env.STREAMPAY_E2E_DB === "postgres" ? "postgres" : "sqlite";
export const TEAM = {
	name: "team",
	productId: "prod_team",
	priceInSmallestUnit: 100,
	billingInterval: "MONTH" as const,
	seatBilling: { minimum: 1, maximum: 10 },
};

export type Row = Record<string, unknown>;

export interface Harness {
	auth: StreamPayTestInstance["auth"];
	stream: MockedStreamPayClient;
	headers: Headers;
	userId: string;
	rows: (model: string) => Promise<Row[]>;
	setRow: (model: string, id: string, update: Row) => Promise<void>;
	deliver: (event: Row) => Response | Promise<Response>;
	upgrade: (body: Row) => Promise<Response>;
}

export async function harness(use: StreamPayPlugins): Promise<Harness> {
	const instance = await createStreamPayTestInstance({ use, testWith: TEST_WITH });
	const { auth, client, sessionSetter, streamPayClient: stream } = instance;
	const email = `state-${Math.random().toString(36).slice(2)}@example.com`;
	const account = await client.signUp.email(
		{ name: "State", email, password: "password123" },
		{ throw: true },
	);
	const headers = new Headers();
	await client.signIn.email(
		{ email, password: "password123" },
		{ throw: true, onSuccess: sessionSetter(headers) },
	);
	stream.listConsumers.mockResolvedValue({ data: [], pagination: { has_next_page: false } });
	stream.createConsumer.mockResolvedValue({ id: "cons_1" });
	let linkNumber = 0;
	stream.createPaymentLink.mockImplementation(async () => ({ id: `pl_${++linkNumber}` }));
	stream.getPaymentUrl.mockImplementation((link) => `https://pay.example.test/${link.id}`);
	stream.updatePaymentLinkStatus.mockImplementation(async (id) => ({ id }));
	const adapter = (await auth.$context).adapter as unknown as {
		findMany: (input: { model: string }) => Promise<Row[]>;
		update: (input: {
			model: string;
			update: Row;
			where: Array<{ field: string; value: unknown }>;
		}) => Promise<unknown>;
	};
	return {
		auth,
		stream,
		headers,
		userId: account.user.id,
		rows: (model) => adapter.findMany({ model }),
		setRow: async (model, id, update) => {
			await adapter.update({ model, update, where: [{ field: "id", value: id }] });
		},
		deliver: (event) => {
			const body = JSON.stringify({ entity_url: "", status: "OK", data: {}, ...event });
			const t = Math.floor(Date.now() / 1000);
			const signature = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
			return auth.handler(
				new Request("http://localhost:3000/api/auth/streampay/webhooks", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-webhook-signature": `t=${t},v1=${signature}`,
					},
					body,
				}),
			);
		},
		upgrade: (body) =>
			callAuthEndpoint(auth, "/subscription/upgrade", { method: "POST", body, headers }),
	};
}

export function subscriptionEvent(
	h: Harness,
	eventType: string,
	subscriptionId: string,
	timestamp: string,
	rowId?: string,
): Row {
	return {
		event_type: eventType,
		entity_type: "SUBSCRIPTION",
		entity_id: subscriptionId,
		timestamp,
		data: {
			metadata: {
				streampay_plugin_plan_name: TEAM.name,
				streampay_plugin_reference_id: h.userId,
				streampay_plugin_reference_type: "user",
				...(rowId ? { streampay_plugin_subscription_row_id: rowId } : {}),
			},
		},
	};
}

export function providerSubscription(id: string, status: string, extra: Row = {}) {
	return {
		id,
		status,
		organization_consumer_id: "cons_1",
		items: [{ product_id: TEAM.productId, quantity: 1 }],
		...extra,
	} as never;
}

export async function currentPlan(h: Harness): Promise<unknown> {
	const response = await callAuthEndpoint(h.auth, "/subscription/current", { headers: h.headers });
	return response.json();
}

export function replayWebhookEvent(h: Harness, eventId: string): Promise<Response> {
	return callAuthEndpoint(
		h.auth,
		`/admin/streampay/webhook-events/${encodeURIComponent(eventId)}/replay`,
		{ method: "POST", headers: h.headers },
	);
}
