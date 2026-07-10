import type { SubscriptionDetailed, SubscriptionUpdate } from "@streamsdk/typescript";
import { readEnvelope, readSdkErrorFields } from "../../utils/error-envelope";
import type { ResolvedPlans } from "./plans";
import { subscriptionItemProductId } from "./reconcile";

export function isAlreadyCanceledFreezeError(err: unknown): boolean {
	const sdkError = readSdkErrorFields(err);
	const envelope = readEnvelope(sdkError.body);
	return (
		sdkError.status === 403 &&
		envelope?.code === "STREAM_ERROR" &&
		envelope.additionalInfo === "Cannot delete non-latest freeze entry."
	);
}

export function subscriptionCouponIds(
	stream: SubscriptionDetailed,
): NonNullable<SubscriptionUpdate["coupons"]> {
	const coupons: SubscriptionUpdate["coupons"] = [];
	for (const coupon of stream.coupon_calculation_metadata?.coupons ?? []) {
		if (coupon.coupon_id) coupons.push(coupon.coupon_id);
	}
	return coupons;
}

export function configuredPlanForSubscription(
	subscription: SubscriptionDetailed,
	plans: ResolvedPlans,
): ResolvedPlans["list"][number] | undefined {
	return plans.list.find((plan) =>
		subscription.items?.some((item) => subscriptionItemProductId(item) === plan.productId),
	);
}
