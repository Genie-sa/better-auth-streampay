import { describe, expect, it } from "vitest";
import { validatePlansShape } from "../src/plugins/subscriptions/plans";

describe("validatePlansShape", () => {
	const baseline = {
		name: "pro",
		productId: "prod_pro",
		priceHalalat: 9900,
		billingInterval: "MONTH" as const,
	};

	it("accepts a valid single-plan list", () => {
		expect(() => validatePlansShape([baseline])).not.toThrow();
	});

	it("rejects an empty list", () => {
		expect(() => validatePlansShape([])).toThrow(/at least one plan/);
	});

	it("rejects plans with no name", () => {
		expect(() => validatePlansShape([{ ...baseline, name: "" }])).toThrow(/non-empty `name`/);
	});

	it("rejects duplicate plan names", () => {
		expect(() => validatePlansShape([baseline, baseline])).toThrow(/duplicate plan name/);
	});

	it("rejects plans with no productId", () => {
		expect(() => validatePlansShape([{ ...baseline, productId: "" }])).toThrow(
			/non-empty `productId`/,
		);
	});

	it("rejects negative priceHalalat", () => {
		expect(() => validatePlansShape([{ ...baseline, priceHalalat: -1 }])).toThrow(
			/non-negative numeric `priceHalalat`/,
		);
	});

	it("rejects non-numeric priceHalalat", () => {
		expect(() => validatePlansShape([{ ...baseline, priceHalalat: NaN }])).toThrow(
			/non-negative numeric `priceHalalat`/,
		);
	});

	it("rejects SEMESTER interval (valid for products, invalid for subscriptions)", () => {
		expect(() =>
			validatePlansShape([{ ...baseline, billingInterval: "SEMESTER" as never }]),
		).toThrow(/invalid `billingInterval`/);
	});

	it("accepts WEEK/MONTH/QUARTER/YEAR intervals", () => {
		for (const interval of ["WEEK", "MONTH", "QUARTER", "YEAR"] as const) {
			expect(() =>
				validatePlansShape([{ ...baseline, name: interval, billingInterval: interval }]),
			).not.toThrow();
		}
	});

	it("rejects zero or negative billingIntervalCount", () => {
		expect(() => validatePlansShape([{ ...baseline, billingIntervalCount: 0 }])).toThrow(
			/invalid `billingIntervalCount`/,
		);
		expect(() => validatePlansShape([{ ...baseline, billingIntervalCount: -1 }])).toThrow(
			/invalid `billingIntervalCount`/,
		);
	});

	it("rejects non-integer billingIntervalCount", () => {
		expect(() => validatePlansShape([{ ...baseline, billingIntervalCount: 1.5 }])).toThrow(
			/invalid `billingIntervalCount`/,
		);
	});
});

describe("hasFeature / checkLimit", () => {
	// Import lazily to avoid registering before plan validation tests run.
	it("hasFeature returns false on non-active subscription", async () => {
		const { hasFeature } = await import("../src/plugins/subscriptions/plans");
		const sub = {
			status: "canceled",
			plan: "pro",
			referenceId: "u1",
		} as Parameters<typeof hasFeature>[0];
		const plan = {
			name: "pro",
			productId: "p",
			priceHalalat: 0,
			billingInterval: "MONTH" as const,
			limits: { teams: true },
		};
		expect(hasFeature(sub, plan, "teams")).toBe(false);
	});

	it("hasFeature returns true for truthy feature on active subscription", async () => {
		const { hasFeature } = await import("../src/plugins/subscriptions/plans");
		const sub = {
			status: "active",
			plan: "pro",
			referenceId: "u1",
		} as Parameters<typeof hasFeature>[0];
		const plan = {
			name: "pro",
			productId: "p",
			priceHalalat: 0,
			billingInterval: "MONTH" as const,
			limits: { teams: true, api_calls: 1000 },
		};
		expect(hasFeature(sub, plan, "teams")).toBe(true);
		expect(hasFeature(sub, plan, "api_calls")).toBe(true);
	});

	it("hasFeature respects frozen status", async () => {
		const { hasFeature } = await import("../src/plugins/subscriptions/plans");
		const sub = {
			status: "frozen",
			plan: "pro",
			referenceId: "u1",
		} as Parameters<typeof hasFeature>[0];
		const plan = {
			name: "pro",
			productId: "p",
			priceHalalat: 0,
			billingInterval: "MONTH" as const,
			limits: { teams: true },
		};
		expect(hasFeature(sub, plan, "teams")).toBe(true);
	});

	it("checkLimit returns allowed true when requested <= limit", async () => {
		const { checkLimit } = await import("../src/plugins/subscriptions/plans");
		const sub = {
			status: "active",
			plan: "pro",
			referenceId: "u1",
		} as Parameters<typeof checkLimit>[0];
		const plan = {
			name: "pro",
			productId: "p",
			priceHalalat: 0,
			billingInterval: "MONTH" as const,
			limits: { seats: 10 },
		};
		const result = checkLimit(sub, plan, "seats", 5);
		expect(result).toEqual({ allowed: true, limit: 10, remaining: 5 });
	});

	it("checkLimit returns allowed false when requested > limit", async () => {
		const { checkLimit } = await import("../src/plugins/subscriptions/plans");
		const sub = {
			status: "active",
			plan: "pro",
			referenceId: "u1",
		} as Parameters<typeof checkLimit>[0];
		const plan = {
			name: "pro",
			productId: "p",
			priceHalalat: 0,
			billingInterval: "MONTH" as const,
			limits: { seats: 10 },
		};
		const result = checkLimit(sub, plan, "seats", 12);
		expect(result).toEqual({ allowed: false, limit: 10, remaining: 0 });
	});

	it("checkLimit returns zero-limit for non-active subscriptions", async () => {
		const { checkLimit } = await import("../src/plugins/subscriptions/plans");
		const sub = {
			status: "canceled",
			plan: "pro",
			referenceId: "u1",
		} as Parameters<typeof checkLimit>[0];
		const plan = {
			name: "pro",
			productId: "p",
			priceHalalat: 0,
			billingInterval: "MONTH" as const,
			limits: { seats: 10 },
		};
		const result = checkLimit(sub, plan, "seats", 1);
		expect(result).toEqual({ allowed: false, limit: 0, remaining: 0 });
	});
});
