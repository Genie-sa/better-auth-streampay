import { readFile, unlink } from "node:fs/promises";
import StreamSDK from "@streamsdk/typescript";

const directory = new URL(".data/", import.meta.url);
const client = StreamSDK.init(process.env.STREAMPAY_API_KEY, {
	baseUrl: process.env.STREAMPAY_BASE_URL,
});
if (!(await client.getMe()).organization.sandbox) throw new Error("Sandbox credentials required.");
const consumer = JSON.parse(await readFile(new URL("consumer.json", directory), "utf8"));
for (const filename of ["subscription.json", "paid-subscription.json"]) {
	try {
		const file = new URL(filename, directory);
		const saved = JSON.parse(await readFile(file, "utf8"));
		let subscription = await client.getSubscription(saved.id);
		if (subscription.organization_consumer_id !== consumer.id)
			throw new Error("Saved subscription is not owned by this demo.");
		if (subscription.status !== "CANCELED" && !subscription.cancel_at_period_end)
			subscription = await client.cancelSubscription(saved.id, { cancel_related_invoices: true });
		if (subscription.status === "CANCELED") await unlink(file);
		else
			console.log(
				`Subscription ${saved.id} will cancel at period end; its state file is retained.`,
			);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
try {
	const file = new URL("webhook.json", directory);
	const webhook = JSON.parse(await readFile(file, "utf8"));
	const response = await fetch(
		`${process.env.STREAMPAY_BASE_URL}/api/v2/webhooks/${encodeURIComponent(webhook.id)}`,
		{
			method: "DELETE",
			headers: { "x-api-key": process.env.STREAMPAY_API_KEY },
			signal: AbortSignal.timeout(15000),
		},
	);
	if (!response.ok && response.status !== 404)
		throw new Error(`Webhook cleanup failed: HTTP ${response.status}`);
	await unlink(file);
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
console.log(
	"Demo subscription cancellation requested and webhook removed. The dedicated consumer and local database are retained.",
);
