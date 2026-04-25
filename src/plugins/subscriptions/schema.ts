/**
 * Tables contributed by `subscriptions()`:
 *   - `subscription` — one row per (referenceId, plan).
 *   - `streampayWebhookEvent` — dedupe table. A successful unique insert
 *     is the gate for processing a webhook; a conflict → 200 so
 *     StreamPay stops retrying.
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
			processedAt: {
				type: "date",
				required: true,
			},
		},
	},
} as const;

export const subscriptionSchema = {
	...subscriptionTable,
	...webhookEventTable,
} as const;

export type SubscriptionSchema = typeof subscriptionSchema;
