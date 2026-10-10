import { mkdir, readFile, writeFile } from "node:fs/promises";
import StreamSDK from "@streamsdk/typescript";

const directory = new URL(".data/", import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const client = StreamSDK.init(process.env.STREAMPAY_API_KEY, {
	baseUrl: process.env.STREAMPAY_BASE_URL,
});
if (!(await client.getMe()).organization.sandbox) throw new Error("Sandbox credentials required.");
for (const name of ["STREAMPAY_WEBHOOK_SECRET", "BETTER_AUTH_SECRET"]) {
	if (!process.env[name] || process.env[name].length < 32)
		throw new Error(`${name} must contain at least 32 random characters.`);
}
try {
	await readFile(new URL("consumer.json", directory));
} catch (error) {
	if (error.code !== "ENOENT") throw error;
	const consumer = await client.createConsumer({
		name: `Plugin demo ${Date.now()}`,
		external_id: `plugin-demo-${Date.now()}`,
		communication_methods: [],
	});
	await writeFile(new URL("consumer.json", directory), JSON.stringify({ id: consumer.id }), {
		mode: 0o600,
	});
}
const tunnel = process.argv[2];
if (tunnel) {
	const origin = new URL(tunnel);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("Pass the HTTPS tunnel origin without a path or credentials.");
	const url = `${origin.origin}/api/auth/streampay/webhooks`;
	let previous;
	try {
		previous = JSON.parse(await readFile(new URL("webhook.json", directory), "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const subscriptions = [
		"SUBSCRIPTION_CREATED",
		"SUBSCRIPTION_PLAN_UPDATED",
		"SUBSCRIPTION_PLAN_CHANGED",
		"SUBSCRIPTION_CANCELED",
		"SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
		"INVOICE_CREATED",
		"PAYMENT_SUCCEEDED",
		"PAYMENT_PARTIALLY_REFUNDED",
	];
	const listing = await fetch(`${process.env.STREAMPAY_BASE_URL}/api/v2/webhooks`, {
		headers: { "x-api-key": process.env.STREAMPAY_API_KEY },
		signal: AbortSignal.timeout(15000),
	});
	if (!listing.ok) throw new Error(`Webhook lookup failed: HTTP ${listing.status}`);
	const current = (await listing.json()).data.find((webhook) => webhook.id === previous?.id);
	// Always synchronize the secret too: the API does not return it for comparison.
	const response = await fetch(
		`${process.env.STREAMPAY_BASE_URL}/api/v2/webhooks${current ? `/${encodeURIComponent(current.id)}` : ""}`,
		{
			method: current ? "PUT" : "POST",
			headers: { "x-api-key": process.env.STREAMPAY_API_KEY, "content-type": "application/json" },
			body: JSON.stringify({
				name: "Plugin local demo",
				url,
				enabled: true,
				secret_key: process.env.STREAMPAY_WEBHOOK_SECRET,
				subscriptions,
			}),
			signal: AbortSignal.timeout(15000),
		},
	);
	if (!response.ok) throw new Error(`Webhook configuration failed: HTTP ${response.status}`);
	const webhook = await response.json();
	await writeFile(new URL("webhook.json", directory), JSON.stringify({ id: webhook.id, url }), {
		mode: 0o600,
	});
	console.log(`${current ? "Updated" : "Created"} sandbox webhook ${webhook.id}`);
}
console.log("Dedicated sandbox consumer ready. Credentials remain server-side.");
