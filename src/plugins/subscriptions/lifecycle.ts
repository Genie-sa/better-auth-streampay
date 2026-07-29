import type { SubscriptionDetailed, SubscriptionUpdate } from "@streamsdk/typescript";
import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../../error-codes";
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
	return couponIdsFromMetadata(stream.coupon_calculation_metadata);
}

function couponIdsFromMetadata(
	metadata: SubscriptionDetailed["coupon_calculation_metadata"],
): string[] {
	const coupons: string[] = [];
	for (const coupon of metadata?.coupons ?? []) {
		if (coupon.coupon_id) coupons.push(coupon.coupon_id);
	}
	return coupons;
}

/**
 * StreamPay update calls replace the complete item list. This helper changes exactly one
 * configured plan item while retaining add-ons and all coupon IDs exposed by the provider.
 */
export function subscriptionItemsForUpdate(
	stream: SubscriptionDetailed,
	currentProductId: string,
	targetProductId: string,
	targetSeats: number,
): SubscriptionUpdate["items"] {
	if (!stream.items?.length) {
		throw invalidProviderItems("StreamPay returned a subscription without any items.");
	}
	const subscriptionCoupons = new Set(subscriptionCouponIds(stream));
	let matches = 0;
	const items: SubscriptionUpdate["items"] = stream.items.map((item) => {
		const productId = subscriptionItemProductId(item);
		const quantity = item.quantity ?? 1;
		if (!productId || !Number.isSafeInteger(quantity) || quantity < 1) {
			throw invalidProviderItems("StreamPay returned an invalid subscription item.");
		}
		const isPlanItem = productId === currentProductId;
		if (isPlanItem) matches += 1;
		const itemCoupons = couponIdsFromMetadata(item.coupon_calculation_metadata).filter(
			(couponId) => !subscriptionCoupons.has(couponId),
		);
		return {
			product_id: isPlanItem ? targetProductId : productId,
			quantity: isPlanItem ? targetSeats : quantity,
			...(itemCoupons.length > 0 ? { coupons: itemCoupons } : {}),
		};
	});
	if (matches !== 1) {
		throw invalidProviderItems(
			`Expected exactly one plan item for product "${currentProductId}", received ${matches}.`,
		);
	}
	return items;
}

function invalidProviderItems(message: string): APIError {
	return new APIError("INTERNAL_SERVER_ERROR", {
		code: $ERROR_CODES.SUBSCRIPTION_INVALID_STATE.code,
		message,
	});
}

export function configuredPlanForSubscription(
	subscription: SubscriptionDetailed,
	plans: ResolvedPlans,
): ResolvedPlans["list"][number] | undefined {
	const matches = plans.list.filter((plan) =>
		subscription.items?.some((item) => subscriptionItemProductId(item) === plan.productId),
	);
	if (matches.length > 1) {
		throw invalidProviderItems(
			"StreamPay returned a subscription containing multiple configured plan products.",
		);
	}
	return matches[0];
}
