import { describe, expect, it } from "vitest";
import {
	buildSeatCheckoutItem,
	quotedSeatTotal,
	resolveSeatCount,
} from "../src/plugins/subscriptions/seats";
import type { StreamPayPlan } from "../src/plugins/subscriptions/types";

const PLAN: StreamPayPlan = {
	name: "pro",
	productId: "prod_pro",
	priceInSmallestUnit: 2_900,
	billingInterval: "MONTH",
};

describe("subscription seat primitives", () => {
	it.each([
		[undefined, undefined, 1],
		[{ default: 3 }, undefined, 3],
		[{ minimum: 2 }, undefined, 2],
		[{ default: 3, minimum: 2, maximum: 5 }, 2, 2],
		[{ default: 3, minimum: 2, maximum: 5 }, 5, 5],
	] as const)("resolves config=%j requested=%j to %i", (seatBilling, requested, expected) => {
		expect(resolveSeatCount({ ...PLAN, ...(seatBilling ? { seatBilling } : {}) }, requested)).toBe(
			expected,
		);
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects the invalid requested quantity %s", (requested) => {
		expect(() => resolveSeatCount(PLAN, requested)).toThrow(/safe-integer seat count/);
	});

	it.each([1, 6])("rejects quantity %i outside an inclusive 2–5 range", (requested) => {
		expect(() =>
			resolveSeatCount({ ...PLAN, seatBilling: { minimum: 2, maximum: 5 } }, requested),
		).toThrow(/range 2–5/);
	});

	it("quotes full smallest-unit totals without floating-point money", () => {
		expect(quotedSeatTotal(PLAN, 25)).toBe(72_500);
		expect(() =>
			quotedSeatTotal({ ...PLAN, priceInSmallestUnit: Number.MAX_SAFE_INTEGER }, 2),
		).toThrow(/safe-integer range/);
	});

	it("builds a fixed provider item by default", () => {
		expect(buildSeatCheckoutItem(PLAN, 4)).toEqual({
			product_id: "prod_pro",
			quantity: 4,
			allow_custom_quantity: false,
		});
	});

	it("builds a bounded customer-editable provider item", () => {
		expect(
			buildSeatCheckoutItem(
				{
					...PLAN,
					seatBilling: { minimum: 2, maximum: 25, customerEditable: true },
				},
				4,
			),
		).toEqual({
			product_id: "prod_pro",
			quantity: 4,
			allow_custom_quantity: true,
			min_quantity: 2,
			max_quantity: 25,
		});
	});

	it("fails closed if untyped code bypasses editable-bound config validation", () => {
		expect(() =>
			buildSeatCheckoutItem({ ...PLAN, seatBilling: { minimum: 1, customerEditable: true } }, 3),
		).toThrow(/must configure.*minimum.*maximum/);
	});
});
