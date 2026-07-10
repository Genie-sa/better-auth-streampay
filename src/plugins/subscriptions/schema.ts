export const subscriptionTable = {
	subscription: {
		fields: {
			referenceId: {
				type: "string",
				required: true,
				input: false,
				index: true,
			},
			referenceType: {
				type: "string",
				required: false,
				defaultValue: "user",
				input: false,
			},
			activeSlotKey: {
				type: "string",
				required: false,
				unique: true,
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
				index: true,
			},
			streampayPaymentLinkId: {
				type: "string",
				required: false,
				unique: true,
				input: false,
			},
			plan: {
				type: "string",
				required: true,
			},
			planVersion: {
				type: "string",
				required: false,
			},
			productId: {
				type: "string",
				required: false,
				index: true,
			},
			group: {
				type: "string",
				required: false,
				index: true,
			},
			amountInSmallestUnit: {
				type: "number",
				required: false,
			},
			originalAmountInSmallestUnit: {
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
				index: true,
			},
			providerStatus: {
				type: "string",
				required: false,
			},
			billingStatus: {
				type: "string",
				required: false,
				defaultValue: "current",
				index: true,
			},
			periodStart: {
				type: "date",
				required: false,
			},
			periodEnd: {
				type: "date",
				required: false,
			},
			currentCycleNumber: {
				type: "number",
				required: false,
			},
			trialStart: {
				type: "date",
				required: false,
			},
			trialEnd: {
				type: "date",
				required: false,
			},
			cancelAtPeriodEnd: {
				type: "boolean",
				required: false,
				defaultValue: false,
			},
			cancelAt: {
				type: "date",
				required: false,
			},
			cancelScheduledAt: {
				type: "date",
				required: false,
			},
			canceledAt: {
				type: "date",
				required: false,
			},
			pendingPlan: {
				type: "string",
				required: false,
			},
			pendingProductId: {
				type: "string",
				required: false,
				index: true,
			},
			pendingPlanEffectiveAt: {
				type: "date",
				required: false,
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
			providerUpdatedAt: {
				type: "date",
				required: false,
			},
			syncedAt: {
				type: "date",
				required: false,
				index: true,
			},
			createdAt: {
				type: "date",
				required: false,
				input: false,
			},
			updatedAt: {
				type: "date",
				required: false,
				input: false,
				index: true,
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
			receivedAt: {
				type: "date",
				required: true,
				index: true,
			},
			lastAttemptAt: {
				type: "date",
				required: false,
				index: true,
			},
			nextAttemptAt: {
				type: "date",
				required: false,
				index: true,
			},
			completedAt: {
				type: "date",
				required: false,
				index: true,
			},
			deadLetteredAt: {
				type: "date",
				required: false,
				index: true,
			},
			lockedAt: {
				type: "date",
				required: false,
				index: true,
			},
			lockedBy: {
				type: "string",
				required: false,
			},
			status: {
				type: "string",
				required: false,
				defaultValue: "pending",
				index: true,
			},
			attemptCount: {
				type: "number",
				required: false,
				defaultValue: 1,
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
			lastErrorCode: {
				type: "string",
				required: false,
				index: true,
			},
		},
	},
} as const;

export const subscriptionSchema = {
	...subscriptionTable,
	...webhookEventTable,
} as const;

export type SubscriptionSchema = typeof subscriptionSchema;
