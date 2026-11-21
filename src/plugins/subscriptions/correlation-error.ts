/**
 * A StreamPay event cannot be matched to local billing state without overwriting another live
 * subscription. Retrying cannot fix it, so the inbox dead-letters it for manual review.
 */
export class SubscriptionCorrelationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubscriptionCorrelationError";
	}
}
