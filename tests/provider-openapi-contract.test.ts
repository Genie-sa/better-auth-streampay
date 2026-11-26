import StreamSDK from "@streamsdk/typescript";
import { describe, expect, it } from "vitest";
import type { StreamPayClient } from "../src/types";
import { findPaidCheckoutInvoice } from "../src/utils/payment-evidence";
import contract from "./fixtures/streampay-openapi-contract.json";

const linkId = "87832f58-8480-409b-afd0-f349d4be237b";
const paymentId = "86f70d57-fbd5-4ce7-9f3c-db03c1f6cee3";
const subscriptionId = "ccb26acc-a851-4383-8b30-37dc0bf7026e";

function provider(respond: (request: Request) => Response) {
	const requests: Request[] = [];
	const client: StreamPayClient = StreamSDK.init("test-key", {
		baseUrl: "https://stream.example.test",
		fetchFn: async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return respond(request);
		},
	});
	return { client, requests };
}

describe("StreamPay's public OpenAPI contract via the published SDK", () => {
	it("queries the owned checkout and fetches its payment by ID", async () => {
		const { client, requests } = provider((request) => {
			const url = new URL(request.url);
			if (url.pathname === contract.invoices.path) {
				return Response.json({
					data: [
						{
							id: "invoice",
							payment_link_id: linkId,
							organization_consumer_id: "consumer",
							status: "COMPLETED",
							currency: "SAR",
							total_amount: "5.50",
							payments: [{ id: paymentId }],
						},
					],
				});
			}
			expect(url.pathname).toBe(`/api/v2/payments/${paymentId}`);
			return Response.json({
				id: paymentId,
				current_status: "SUCCEEDED",
				currency: "SAR",
				amount_in_smallest_unit: 550,
			});
		});

		expect(await findPaidCheckoutInvoice(client, linkId, "consumer")).toMatchObject({
			status: "paid",
			invoice: { paymentId, total: 550 },
		});
		const invoiceRequest = new URL(requests[0]?.url ?? "");
		const query = Object.fromEntries(invoiceRequest.searchParams);
		expect(Object.keys(contract.invoices.query)).toEqual(
			expect.arrayContaining(Object.keys(query)),
		);
		expect(query).toEqual({
			payment_link_id: linkId,
			include_payments: "true",
			statuses: "COMPLETED",
			limit: "2",
		});
		expect(contract.invoices.statuses).toContain(query.statuses);
		expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
	});

	it("serializes subscription invoice history and consumer product filters", async () => {
		const { client, requests } = provider(() => Response.json({ data: [] }));
		await client.listInvoices({
			subscription_id: subscriptionId,
			limit: 50,
			statuses: ["COMPLETED"],
		});
		await client.listSubscriptions({
			organization_consumer_id: linkId,
			product_ids: [paymentId],
			limit: 10,
		});
		const [invoices, subscriptions] = requests.map((request) => new URL(request.url));
		expect(invoices?.pathname).toBe(contract.invoices.path);
		const invoiceQuery = Object.fromEntries(invoices?.searchParams ?? []);
		expect(Object.keys(contract.invoices.query)).toEqual(
			expect.arrayContaining(Object.keys(invoiceQuery)),
		);
		expect(invoiceQuery).toEqual({
			subscription_id: subscriptionId,
			limit: "50",
			statuses: "COMPLETED",
		});
		expect(contract.invoices.statuses).toContain(invoiceQuery.statuses);
		expect(subscriptions?.pathname).toBe(contract.subscriptions.path);
		const subscriptionQuery = Object.fromEntries(subscriptions?.searchParams ?? []);
		expect(Object.keys(contract.subscriptions.query)).toEqual(
			expect.arrayContaining(Object.keys(subscriptionQuery)),
		);
		expect(subscriptionQuery).toEqual({
			organization_consumer_id: linkId,
			product_ids: paymentId,
			limit: "10",
		});
	});

	it("preserves documented partial refund wire fields and individual refund records", async () => {
		const expectedStatus = "PENDING";
		const refund = {
			id: linkId,
			amount_refunded: "5.50",
			status: expectedStatus,
			refunded_at: null,
			refund_reason: "OTHER",
			refund_note: "refund for order",
		};
		const { client, requests } = provider(() =>
			Response.json({
				id: paymentId,
				currency: "SAR",
				current_status: "SUCCEEDED",
				amount_in_smallest_unit: 1000,
				amount_refunded: "0.00",
				refunds: [refund],
			}),
		);
		const request = {
			amount: "5.50",
			refund_reason: "OTHER",
			refund_note: "refund for order",
			payment_is_part_of_related_set: false,
		} as const;
		const sdkCompatibility = { allow_refund_multiple_related_payments: false };
		const payment = await client.refundPayment(paymentId, { ...request, ...sdkCompatibility });
		expect(payment).toMatchObject({
			amount_refunded: "0.00",
			refunds: [refund],
		});
		expect(Object.keys(payment).sort()).toEqual(Object.keys(contract.refund.payment).sort());
		const [sent] = requests;
		expect(sent?.method).toBe("POST");
		expect(new URL(sent?.url ?? "").pathname).toBe(
			contract.refund.path.replace("{payment_id}", paymentId),
		);
		const body = await sent?.json();
		expect(body).toEqual({ ...request, ...sdkCompatibility });
		const documentedFields = Object.keys(body).filter(
			(field) => !Object.hasOwn(sdkCompatibility, field),
		);
		expect(documentedFields.sort()).toEqual(Object.keys(contract.refund.request).sort());
		expect(documentedFields).toEqual(expect.arrayContaining(contract.refund.required));
		expect(Object.keys(refund).sort()).toEqual(Object.keys(contract.refund.response).sort());
		expect(contract.refund.statuses).toContain(expectedStatus);
		expect(contract.refund.reasons).toContain(request.refund_reason);
	});
});
