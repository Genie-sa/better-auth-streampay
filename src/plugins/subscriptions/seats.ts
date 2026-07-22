import type { CreatePaymentLinkDto } from "@streamsdk/typescript";
import { APIError } from "better-auth/api";
import { $ERROR_CODES } from "../../error-codes";
import type { StreamPayPlanLike } from "./types";

export function resolveSeatCount(plan: StreamPayPlanLike, requested?: number): number {
	const seats = requested ?? plan.seatBilling?.default ?? plan.seatBilling?.minimum ?? 1;
	const minimum = plan.seatBilling?.minimum ?? 1;
	const maximum = plan.seatBilling?.maximum;
	if (
		!Number.isSafeInteger(seats) ||
		seats < minimum ||
		(maximum !== undefined && seats > maximum)
	) {
		const range = maximum === undefined ? `${minimum} or more` : `${minimum}–${maximum}`;
		throw new APIError("BAD_REQUEST", {
			code: $ERROR_CODES.SUBSCRIPTION_SEAT_COUNT_INVALID.code,
			message: `Plan "${plan.name}" requires a safe-integer seat count in the range ${range}.`,
		});
	}
	return seats;
}

export function quotedSeatTotal(plan: StreamPayPlanLike, seats: number): number {
	const total = plan.priceInSmallestUnit * seats;
	if (!Number.isSafeInteger(total)) {
		throw new APIError("BAD_REQUEST", {
			code: $ERROR_CODES.SUBSCRIPTION_SEAT_COUNT_INVALID.code,
			message: `The quoted total for ${seats} seats exceeds JavaScript's safe-integer range.`,
		});
	}
	return total;
}

export function buildSeatCheckoutItem(
	plan: StreamPayPlanLike,
	seats: number,
): CreatePaymentLinkDto["items"][number] {
	if (!plan.seatBilling?.customerEditable) {
		return {
			product_id: plan.productId,
			quantity: seats,
			allow_custom_quantity: false,
		};
	}

	const minimum = plan.seatBilling.minimum;
	const maximum = plan.seatBilling.maximum;
	if (minimum === undefined || maximum === undefined) {
		throw new TypeError(
			`Plan "${plan.name}" must configure seatBilling.minimum and seatBilling.maximum when customerEditable is true.`,
		);
	}
	return {
		product_id: plan.productId,
		quantity: seats,
		allow_custom_quantity: true,
		min_quantity: minimum,
		max_quantity: maximum,
	};
}
