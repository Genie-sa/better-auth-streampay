import { describe, expect, it } from "vitest";
import { validatePlansShape } from "../src/plugins/subscriptions/plans";

describe("validatePlansShape", () => {
	const baseline = {
		name: "pro",
		productId: "prod_pro",
		priceInSmallestUnit: 9900,
		billingInterval: "MONTH" as const,
	};

	it("accepts a valid single-plan list", () => {
		expect(() => validatePlansShape([baseline])).not.toThrow();
	});

	it("accepts SDK-supported checkout currencies and rejects unsupported runtime input", () => {
		expect(() => validatePlansShape([{ ...baseline, currency: "QAR" }])).not.toThrow();
		const invalidPlan = { ...baseline, currency: "sar" } as const;
		expect(() => {
			// @ts-expect-error Runtime validation still protects untyped JavaScript callers.
			validatePlansShape([invalidPlan]);
		}).toThrow(/Invalid (option|enum value)/);
	});

	it("accepts a non-empty plan version and rejects an empty version", () => {
		expect(() => validatePlansShape([{ ...baseline, version: "2026-07" }])).not.toThrow();
		expect(() => validatePlansShape([{ ...baseline, version: "" }])).toThrow(/empty `version`/);
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

	it("rejects duplicate product IDs that would make webhook inference ambiguous", () => {
		expect(() => validatePlansShape([baseline, { ...baseline, name: "pro-annual" }])).toThrow(
			/duplicate productId/,
		);
	});

	it("rejects plans with no productId", () => {
		expect(() => validatePlansShape([{ ...baseline, productId: "" }])).toThrow(
			/non-empty `productId`/,
		);
	});

	it("rejects negative, fractional, and unsafe priceInSmallestUnit values", () => {
		for (const priceInSmallestUnit of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => validatePlansShape([{ ...baseline, priceInSmallestUnit }])).toThrow(
				/non-negative safe-integer `priceInSmallestUnit`/,
			);
		}
	});

	it("rejects non-numeric priceInSmallestUnit", () => {
		expect(() => validatePlansShape([{ ...baseline, priceInSmallestUnit: NaN }])).toThrow(
			/non-negative safe-integer `priceInSmallestUnit`/,
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

	it("accepts trial periods from 1 to 365 days and rejects values outside that range", () => {
		expect(() => validatePlansShape([{ ...baseline, trialPeriodDays: 1 }])).not.toThrow();
		expect(() => validatePlansShape([{ ...baseline, trialPeriodDays: 365 }])).not.toThrow();
		for (const trialPeriodDays of [0, 1.5, 366]) {
			expect(() => validatePlansShape([{ ...baseline, trialPeriodDays }])).toThrow(
				/invalid `trialPeriodDays`/,
			);
		}
		expect(() => validatePlansShape([{ ...baseline, group: "" }])).toThrow(/empty `group`/);
	});

	it("accepts fixed and explicitly bounded customer-editable seat billing", () => {
		expect(() =>
			validatePlansShape([{ ...baseline, seatBilling: { default: 3, minimum: 2, maximum: 100 } }]),
		).not.toThrow();
		expect(() =>
			validatePlansShape([
				{
					...baseline,
					seatBilling: {
						default: 3,
						minimum: 1,
						maximum: 100,
						customerEditable: true,
					},
				},
			]),
		).not.toThrow();
	});

	it("rejects unsafe or contradictory seat billing configuration", () => {
		expect(() =>
			validatePlansShape([{ ...baseline, seatBilling: { minimum: 5, maximum: 4 } }]),
		).toThrow(/greater than or equal/);
		expect(() =>
			validatePlansShape([{ ...baseline, seatBilling: { default: 11, minimum: 1, maximum: 10 } }]),
		).toThrow(/within the configured minimum/);
		expect(() =>
			validatePlansShape([{ ...baseline, seatBilling: { customerEditable: true } }]),
		).toThrow(/requires explicit/);
		expect(() =>
			validatePlansShape([
				{
					...baseline,
					priceInSmallestUnit: Number.MAX_SAFE_INTEGER,
					seatBilling: { maximum: 2 },
				},
			]),
		).toThrow(/unsafe total/);
	});
});

describe("hasFeature / checkLimit", () => {
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
			priceInSmallestUnit: 0,
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
			priceInSmallestUnit: 0,
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
			priceInSmallestUnit: 0,
			billingInterval: "MONTH" as const,
			limits: { teams: true },
		};
		expect(hasFeature(sub, plan, "teams")).toBe(true);
	});

	it.each([
		"trialing",
		"past_due",
	] as const)("hasFeature grants access to %s by default", async (status) => {
		const { hasFeature } = await import("../src/plugins/subscriptions/plans");
		const sub = { status } as Parameters<typeof hasFeature>[0];
		const plan = {
			name: "pro",
			productId: "p",
			priceInSmallestUnit: 0,
			billingInterval: "MONTH" as const,
			limits: { teams: true },
		};
		expect(hasFeature(sub, plan, "teams")).toBe(true);
	});

	it("hasFeature honors an explicit access-status policy", async () => {
		const { hasFeature } = await import("../src/plugins/subscriptions/plans");
		const sub = { status: "past_due" } as Parameters<typeof hasFeature>[0];
		const plan = {
			name: "pro",
			productId: "p",
			priceInSmallestUnit: 0,
			billingInterval: "MONTH" as const,
			limits: { teams: true },
		};
		expect(hasFeature(sub, plan, "teams", ["active", "trialing"])).toBe(false);
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
			priceInSmallestUnit: 0,
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
			priceInSmallestUnit: 0,
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
			priceInSmallestUnit: 0,
			billingInterval: "MONTH" as const,
			limits: { seats: 10 },
		};
		const result = checkLimit(sub, plan, "seats", 1);
		expect(result).toEqual({ allowed: false, limit: 0, remaining: 0 });
	});
});
