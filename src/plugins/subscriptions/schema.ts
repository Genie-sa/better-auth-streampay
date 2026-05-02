/**
 * Tables contributed by `subscriptions()`:
 *   - `subscription` — one row per (referenceId, plan).
 *   - `streampayWebhookEvent` — event lifecycle: `pending` → `completed`
 *     or `pending` → `dead_letter` after `attemptCount` reaches the
 *     configured maximum. Dead-lettered rows preserve `rawPayload` and
 *     `signatureHeader` so an operator can replay them after a fix.
 */
export const subscriptionTable = {
	subscription: {
		fields: {
			referenceId: {
				type: "string",
				required: true,
				input: false,
			},
			streampaySubscriptionId: {
				type: "string",
				required: false,
				input: false,
				unique: true,
			},
			streampayConsumerId: {
				type: "string",
				required: false,
				input: false,
			},
			plan: {
				type: "string",
				required: true,
			},
			group: {
				type: "string",
				required: false,
			},
			amountHalalat: {
				type: "number",
				required: false,
			},
			currency: {
				type: "string",
				required: false,
				defaultValue: "SAR",
			},
			billingInterval: {
				type: "string",
				required: false,
			},
			billingIntervalCount: {
				type: "number",
				required: false,
				defaultValue: 1,
			},
			status: {
				type: "string",
				required: false,
				defaultValue: "incomplete",
			},
			periodStart: {
				type: "date",
				required: false,
			},
			periodEnd: {
				type: "date",
				required: false,
			},
			cancelAtPeriodEnd: {
				type: "boolean",
				required: false,
				defaultValue: false,
			},
			endedAt: {
				type: "date",
				required: false,
			},
			frozenAt: {
				type: "date",
				required: false,
			},
			freezeEndAt: {
				type: "date",
				required: false,
			},
		},
	},
} as const;

export const webhookEventTable = {
	streampayWebhookEvent: {
		fields: {
			eventId: {
				type: "string",
				required: true,
				unique: true,
			},
			eventType: {
				type: "string",
				required: true,
			},
			/** Last activity (insert/retry/completion/dead-letter).
			 *  For `completed` = finished-at; for `pending` = last attempt. */
			processedAt: {
				type: "date",
				required: true,
				index: true,
			},
			/** Defaults to `completed` so pre-state-machine rows still dedupe. */
			status: {
				type: "string",
				required: false,
				defaultValue: "completed",
				index: true,
			},
			attemptCount: {
				type: "number",
				required: false,
				defaultValue: 1,
			},
			firstSeenAt: {
				type: "date",
				required: false,
			},
			rawPayload: {
				type: "string",
				required: false,
			},
			signatureHeader: {
				type: "string",
				required: false,
			},
			lastError: {
				type: "string",
				required: false,
			},
		},
	},
} as const;

export const subscriptionSchema = {
	...subscriptionTable,
	...webhookEventTable,
} as const;

export type SubscriptionSchema = typeof subscriptionSchema;
