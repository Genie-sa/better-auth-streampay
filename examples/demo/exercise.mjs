import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import StreamSDK from "@streamsdk/typescript";

const directory = new URL(".data/", import.meta.url);
const consumer = JSON.parse(await readFile(new URL("consumer.json", directory), "utf8"));
const webhook = JSON.parse(await readFile(new URL("webhook.json", directory), "utf8"));
const client = StreamSDK.init(process.env.STREAMPAY_API_KEY, {
	baseUrl: process.env.STREAMPAY_BASE_URL,
});
if (!(await client.getMe()).organization.sandbox) throw new Error("Sandbox credentials required.");
const database = new DatabaseSync(new URL("demo.sqlite", directory), { readOnly: true });
const user = database
	.prepare('SELECT id FROM user WHERE "streampayConsumerId" = ?')
	.get(consumer.id);
if (!user) throw new Error("Create the local demo account first.");
let subscription;
try {
	subscription = JSON.parse(await readFile(new URL("subscription.json", directory), "utf8"));
} catch (error) {
	if (error.code !== "ENOENT") throw error;
	subscription = await client.createSubscription({
		organization_consumer_id: consumer.id,
		items: [{ product_id: process.env.STREAMPAY_PRODUCT_STARTER, quantity: 1 }],
		period_start: new Date(Date.now() + 3 * 86400000).toISOString(),
		trial: true,
		until_cycle_number: 1,
		notify_consumer: false,
		description: "Plugin demo validation trial",
	});
	await writeFile(
		new URL("subscription.json", directory),
		JSON.stringify({ id: subscription.id }),
		{ mode: 0o600 },
	);
}
const remote = await client.getSubscription(subscription.id);
if (remote.organization_consumer_id !== consumer.id)
	throw new Error("The saved subscription does not belong to this demo.");
// API-created subscriptions lack checkout metadata. This explicitly synthetic
// signed delivery correlates only the dedicated fixture to the local account.
const body = JSON.stringify({
	event_type: "SUBSCRIPTION_PLAN_UPDATED",
	entity_type: "SUBSCRIPTION",
	entity_id: subscription.id,
	entity_url: "",
	status: remote.status,
	timestamp: new Date().toISOString(),
	data: {
		metadata: {
			streampay_plugin_plan_name: "starter",
			streampay_plugin_reference_id: user.id,
			streampay_plugin_reference_type: "user",
		},
	},
});
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac("sha256", process.env.STREAMPAY_WEBHOOK_SECRET)
	.update(`${timestamp}.${body}`)
	.digest("hex");
for (let delivery = 0; delivery < 2; delivery++) {
	const response = await fetch(webhook.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-webhook-signature": `t=${timestamp},v1=${signature}`,
		},
		body,
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) throw new Error(`Synthetic delivery failed: HTTP ${response.status}`);
}
const row = database
	.prepare(
		'SELECT status, "catalogMapped", "productId" FROM subscription WHERE "streampaySubscriptionId" = ?',
	)
	.get(subscription.id);
if (!row) throw new Error("Delivery did not reconcile the dedicated subscription.");
const events = database
	.prepare('SELECT "attemptCount",status FROM "streampayWebhookEvent" WHERE "eventId" IN (?,?)')
	.all(
		`SUBSCRIPTION_PLAN_UPDATED:${subscription.id}:${JSON.parse(body).timestamp}`,
		`handlers:SUBSCRIPTION_PLAN_UPDATED:${subscription.id}:${JSON.parse(body).timestamp}`,
	);
if (
	events.length !== 2 ||
	events.some((event) => event.status !== "completed" || event.attemptCount !== 1)
)
	throw new Error("Duplicate delivery changed inbox processing.");
console.log(
	JSON.stringify({
		syntheticDelivery: "accepted twice, processed once per inbox scope",
		subscription: row,
	}),
);
database.close();
