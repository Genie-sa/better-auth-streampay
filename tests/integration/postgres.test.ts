import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { streampay, subscriptions, webhooks } from "../../src";
import {
	claimOrAdvanceWebhookEvent,
	claimWebhookEventForReplay,
	markWebhookEventCompleted,
	recordWebhookEventFailure,
	type SyncContext,
	syncWebhookPayload,
	type WebhookEventRow,
} from "../../src/plugins/subscriptions/sync";
import { createMockStreamPayClient } from "../utils/mocks";
import { createMockWebhookPayload } from "../utils/subscription-helpers";

const plans = [
	{ name: "pro", productId: "known", priceInSmallestUnit: 100, billingInterval: "MONTH" as const },
];
const connectionString = process.env.STREAMPAY_TEST_DATABASE_URL;

describe.runIf(connectionString)("PostgreSQL webhook persistence", () => {
	const schema = `streampay_test_${randomUUID().replaceAll("-", "_")}`;
	let pool: Pool;
	let context: SyncContext;

	beforeAll(async () => {
		pool = new Pool({ connectionString, options: `-c search_path=${schema},public`, max: 10 });
		await pool.query(`CREATE SCHEMA "${schema}"`);
		const options = {
			database: pool,
			baseURL: "http://localhost:3000",
			secret: "postgres-test-secret-at-least-32-characters",
			plugins: [
				streampay({
					client: createMockStreamPayClient(),
					use: [subscriptions({ plans }), webhooks({ secret: "test", deduplicate: true })],
				}),
			],
		};
		await (await getMigrations(options)).runMigrations();
		context = { context: (await betterAuth(options).$context) as SyncContext["context"] };
	});

	afterAll(async () => {
		if (!pool) return;
		try {
			await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		} finally {
			await pool.end();
		}
	});

	it("gives one of eight concurrent deliveries the durable claim", async () => {
		const payload = createMockWebhookPayload({ entity_id: randomUUID() });
		const claims = await Promise.all(
			Array.from({ length: 8 }, () =>
				claimOrAdvanceWebhookEvent(
					context,
					payload,
					JSON.stringify(payload),
					"verified",
					5,
					"handlers",
				),
			),
		);
		expect(claims.filter((claim) => claim.action === "process")).toHaveLength(1);
		expect(claims.filter((claim) => claim.action === "skip")).toHaveLength(7);
		// Query the actual public event key, rather than any callback's process-local state.
		const stored = await pool.query('SELECT * FROM "streampayWebhookEvent" WHERE "eventId" = $1', [
			`handlers:${payload.event_type}:${payload.entity_id}:${payload.timestamp}`,
		]);
		expect(stored.rows).toHaveLength(1);
		expect(stored.rows[0]).toMatchObject({
			status: "pending",
			attemptCount: 1,
			rawPayload: JSON.stringify(payload),
		});
	});

	it("recovers a persisted crash payload with one replay winner and fences the old lease", async () => {
		const payload = createMockWebhookPayload({ entity_id: randomUUID() });
		const first = await claimOrAdvanceWebhookEvent(
			context,
			payload,
			JSON.stringify(payload),
			"verified",
			5,
		);
		if (first.action !== "process" || !first.row) throw new Error("Expected an initial claim.");
		await pool.query('UPDATE "streampayWebhookEvent" SET "lockedAt" = $1 WHERE id = $2', [
			new Date(0),
			first.row.id,
		]);
		const row = await context.context.adapter.findOne<WebhookEventRow>({
			model: "streampayWebhookEvent",
			where: [{ field: "id", value: first.row.id }],
		});
		if (!row) throw new Error("Crash payload was lost.");
		expect(row.rawPayload).toBe(JSON.stringify(payload));
		expect(row.lockedAt).toBeInstanceOf(Date);
		const replays = await Promise.all(
			Array.from({ length: 8 }, () => claimWebhookEventForReplay(context, row)),
		);
		const winners = replays.filter((replay) => replay !== null);
		expect(winners).toHaveLength(1);
		const winner = winners[0];
		if (!winner?.lockedBy || !first.row.lockedBy) throw new Error("Replay lease is missing.");
		await markWebhookEventCompleted(context, first.row.id, first.row.lockedBy);
		await recordWebhookEventFailure(
			context,
			first.row.id,
			"stale payload",
			"stale signature",
			new Error("old worker"),
			first.row.lockedBy,
		);
		const fenced = await pool.query('SELECT * FROM "streampayWebhookEvent" WHERE id = $1', [
			first.row.id,
		]);
		expect(fenced.rows[0]).toMatchObject({
			status: "pending",
			lockedBy: winner.lockedBy,
			rawPayload: JSON.stringify(payload),
			attemptCount: 2,
		});
		await markWebhookEventCompleted(context, winner.id, winner.lockedBy);
		const completed = await pool.query('SELECT * FROM "streampayWebhookEvent" WHERE id = $1', [
			winner.id,
		]);
		expect(completed.rows[0]).toMatchObject({
			status: "completed",
			lockedBy: null,
			rawPayload: null,
			signatureHeader: null,
		});
	});

	it("emits one renewal when invoice and subscription events race for the same cycle", async () => {
		const subscriptionId = randomUUID();
		await context.context.adapter.create({
			model: "subscription",
			data: {
				referenceId: "owner",
				plan: "pro",
				status: "active",
				streampaySubscriptionId: subscriptionId,
				periodEnd: new Date("2026-02-01T00:00:00Z"),
				currentCycleNumber: 1,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const client = createMockStreamPayClient();
		client.getSubscription.mockResolvedValue({
			id: subscriptionId,
			status: "ACTIVE",
			organization_consumer_id: "consumer",
			items: [{ product_id: "known", quantity: 1 }],
			current_period_end: "2026-03-01T00:00:00Z",
			current_cycle_number: 2,
		});
		client.getInvoice.mockResolvedValue({
			id: "invoice",
			subscription_id: subscriptionId,
			currency: "SAR",
		});
		let release = () => {};
		let readers = 0;
		const bothRead = new Promise<void>((resolve) => {
			release = resolve;
		});
		const racingContext: SyncContext = {
			context: {
				...context.context,
				adapter: {
					...context.context.adapter,
					findOne: async <T>(
						input: Parameters<SyncContext["context"]["adapter"]["findOne"]>[0],
					) => {
						const row = await context.context.adapter.findOne(input);
						if (input.model === "subscription" && ++readers <= 2) {
							if (readers === 2) release();
							await bothRead;
						}
						return row as T | null;
					},
				},
			},
		};
		const renewed = vi.fn();
		const resolvedPlans = { list: plans, byName: new Map(plans.map((plan) => [plan.name, plan])) };
		await Promise.all([
			syncWebhookPayload(
				racingContext,
				createMockWebhookPayload({
					event_type: "SUBSCRIPTION_CYCLE_RENEWED_SUCCESSFULLY",
					entity_id: subscriptionId,
				}),
				client,
				resolvedPlans,
				{ onSubscriptionRenewed: renewed },
			),
			syncWebhookPayload(
				racingContext,
				createMockWebhookPayload({
					event_type: "INVOICE_COMPLETED",
					entity_type: "INVOICE",
					entity_id: "invoice",
				}),
				client,
				resolvedPlans,
				{ onSubscriptionRenewed: renewed },
			),
		]);
		expect(renewed).toHaveBeenCalledTimes(1);
		const result = await pool.query(
			'SELECT "currentCycleNumber", "periodEnd" FROM subscription WHERE "streampaySubscriptionId" = $1',
			[subscriptionId],
		);
		expect(result.rows[0]).toEqual({
			currentCycleNumber: 2,
			periodEnd: new Date("2026-03-01T00:00:00Z"),
		});
	});

	it("migrates existing subscriptions with a true catalog default without losing their identity", async () => {
		await pool.query('ALTER TABLE subscription DROP COLUMN "catalogMapped"');
		await pool.query(
			'INSERT INTO subscription (id, "referenceId", plan, status) VALUES ($1, $2, $3, $4)',
			["legacy", "owner", "pro", "active"],
		);
		const options = betterAuth({
			database: pool,
			baseURL: "http://localhost:3000",
			secret: "postgres-test-secret-at-least-32-characters",
			plugins: [
				streampay({ client: createMockStreamPayClient(), use: [subscriptions({ plans })] }),
			],
		}).options;
		await (await getMigrations(options)).runMigrations();
		// Older supported migration generators omit static defaults; deploy the documented backfill.
		await pool.query('ALTER TABLE subscription ALTER COLUMN "catalogMapped" SET DEFAULT true');
		await pool.query(
			'UPDATE subscription SET "catalogMapped" = true WHERE "catalogMapped" IS NULL',
		);
		const result = await pool.query(
			'SELECT id, plan, status, "catalogMapped" FROM subscription WHERE id = $1',
			["legacy"],
		);
		expect(result.rows).toEqual([
			{ id: "legacy", plan: "pro", status: "active", catalogMapped: true },
		]);
	});
});
