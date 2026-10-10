import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import StreamSDK from "@streamsdk/typescript";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import { portal, streampay, subscriptions, webhooks } from "../../dist/index.js";

const directory = fileURLToPath(new URL(".data/", import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
const client = StreamSDK.init(process.env.STREAMPAY_API_KEY, {
	baseUrl: process.env.STREAMPAY_BASE_URL,
	fetchFn: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
});
const me = await client.getMe();
if (!me.organization.sandbox) throw new Error("The demo requires a Stream sandbox organization.");
const product = await client.getProduct(process.env.STREAMPAY_PRODUCT_STARTER);
const plans = [
	{
		name: "starter",
		productId: product.id,
		priceInSmallestUnit: Math.round(Number(product.price) * 100),
		currency: product.currency,
		billingInterval: product.recurring_interval,
		billingIntervalCount: product.recurring_interval_count,
		limits: { projects: 10, teams: true },
	},
];
const database = new DatabaseSync(`${directory}demo.sqlite`);
database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
const consumer = JSON.parse(await readFile(`${directory}consumer.json`, "utf8"));
const options = {
	database,
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL: "http://localhost:3100",
	emailAndPassword: { enabled: true },
	databaseHooks: {
		user: {
			create: { before: async (user) => ({ data: { ...user, streampayConsumerId: consumer.id } }) },
		},
	},
	plugins: [
		streampay({
			client,
			use: [
				portal({
					createSession: async (input) => {
						const response = await fetch(
							`${process.env.STREAMPAY_BASE_URL}/api/v2/consumer_portal/sessions`,
							{
								method: "POST",
								headers: {
									"x-api-key": process.env.STREAMPAY_API_KEY,
									"content-type": "application/json",
								},
								body: JSON.stringify(input),
								signal: AbortSignal.timeout(15000),
							},
						);
						if (!response.ok) throw new Error(`Portal API failed: HTTP ${response.status}`);
						return response.json();
					},
				}),
				subscriptions({ plans }),
				webhooks({
					secret: process.env.STREAMPAY_WEBHOOK_SECRET,
					deduplicate: true,
					onPayload: async (payload) => {
						await writeFile(
							`${directory}last-event.json`,
							JSON.stringify({
								event: payload.event_type,
								entity: payload.entity_type,
								receivedAt: new Date().toISOString(),
							}),
						);
					},
				}),
			],
		}),
	],
};
await (await getMigrations(options)).runMigrations();
const auth = betterAuth(options);
const authHandler = toNodeHandler(auth);
const html = await readFile(new URL("index.html", import.meta.url));
createServer(async (request, response) => {
	try {
		const localHost = /^(localhost|127\.0\.0\.1):3100$/.test(request.headers.host ?? "");
		// Only signed webhook ingress is public; authentication and diagnostics stay local.
		if (!localHost && request.url !== "/api/auth/streampay/webhooks") {
			response.writeHead(404).end();
			return;
		}
		if (request.url?.startsWith("/api/auth/")) {
			await authHandler(request, response);
			return;
		}
		if (request.url === "/diagnostics") {
			const rows = database
				.prepare(
					'SELECT "eventType", "status", "attemptCount" FROM "streampayWebhookEvent" ORDER BY "receivedAt" DESC LIMIT 20',
				)
				.all();
			response
				.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
				.end(JSON.stringify({ sandbox: true, sdk: "1.1.3", events: rows }));
			return;
		}
		if (request.url === "/") {
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
				.end(html);
			return;
		}
		response.writeHead(404).end();
	} catch {
		response.writeHead(500).end("Demo request failed. Check the local server.");
	}
}).listen(3100, "127.0.0.1", () =>
	console.log("Staging demo: http://localhost:3100 (sandbox verified)"),
);
