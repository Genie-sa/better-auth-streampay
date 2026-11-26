import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const source = "https://stream-app-service.streampay.sa/openapi.json";
const fixture = new URL("../tests/fixtures/streampay-openapi-contract.json", import.meta.url);
const { values } = parseArgs({
	options: { from: { type: "string" }, update: { type: "boolean" } },
});

const openapi = values.from
	? JSON.parse(await readFile(values.from, "utf8"))
	: await fetch(source, { signal: AbortSignal.timeout(15_000) }).then((response) => {
			if (!response.ok) throw new Error(`StreamPay OpenAPI returned HTTP ${response.status}`);
			return response.json();
		});

const pick = (object, keys) =>
	Object.fromEntries(
		keys.map((key) => {
			assert.ok(Object.hasOwn(object, key), `Missing documented field ${key}`);
			const { description, title, ...schema } = object[key];
			return [key, schema];
		}),
	);

function query(path, names) {
	const parameters = openapi.paths[path].get.parameters;
	return pick(
		Object.fromEntries(
			parameters
				.filter(({ in: location }) => location === "query")
				.map(({ name, schema }) => [name, schema]),
		),
		names,
	);
}

const schemas = openapi.components.schemas;
const refundPath = "/api/v2/payments/{payment_id}/refund";
const refund = openapi.paths[refundPath].post;
const refundRequest = refund.requestBody.content["application/json"].schema.$ref;
const refundResponse = refund.responses["200"].content["application/json"].schema.$ref;
assert.equal(refundRequest, "#/components/schemas/PaymentRefundRequest");
assert.equal(refundResponse, "#/components/schemas/PaymentResponse");

const actual = {
	source,
	invoices: {
		path: "/api/v2/invoices",
		query: query("/api/v2/invoices", [
			"payment_link_id",
			"organization_consumer_id",
			"subscription_id",
			"include_payments",
			"statuses",
			"page",
			"limit",
			"sort_field",
			"sort_direction",
		]),
	},
	subscriptions: {
		path: "/api/v2/subscriptions",
		query: query("/api/v2/subscriptions", ["organization_consumer_id", "product_ids", "limit"]),
	},
	refund: {
		path: refundPath,
		required: schemas.PaymentRefundRequest.required,
		request: pick(schemas.PaymentRefundRequest.properties, [
			"amount",
			"refund_reason",
			"refund_note",
			"payment_is_part_of_related_set",
		]),
		statuses: schemas.PaymentRefundStatus.enum,
		response: pick(schemas.PaymentRefundResponse.properties, [
			"id",
			"status",
			"amount_refunded",
			"refund_reason",
			"refund_note",
			"refunded_at",
		]),
	},
};

if (values.update) {
	await writeFile(fixture, `${JSON.stringify(actual, null, 2)}\n`);
} else {
	const expected = JSON.parse(await readFile(fixture, "utf8"));
	assert.deepEqual(actual, expected, "StreamPay's public API contract has changed");
	console.log("StreamPay OpenAPI matches the offline contract fixture.");
}
