import { describe, expect, it } from "vitest";
import { StreamPayAmount } from "../src/utils/amount";

describe("StreamPayAmount.toHalalat", () => {
	it("converts a plain SAR string to integer halalat", () => {
		expect(StreamPayAmount.toHalalat("10.50")).toBe(1050);
	});

	it("converts a plain SAR number to integer halalat", () => {
		expect(StreamPayAmount.toHalalat(10.5)).toBe(1050);
	});

	it("handles zero", () => {
		expect(StreamPayAmount.toHalalat(0)).toBe(0);
		expect(StreamPayAmount.toHalalat("0.00")).toBe(0);
	});

	it("rounds away IEEE 754 drift on classic cases", () => {
		expect(StreamPayAmount.toHalalat(0.1 + 0.2)).toBe(30);
	});

	it("rounds half-up at the halalah boundary", () => {
		expect(StreamPayAmount.toHalalat(1.005)).toBe(101);
		expect(StreamPayAmount.toHalalat(10.005)).toBe(1001);
		expect(StreamPayAmount.toHalalat(-1.005)).toBe(-101);
	});

	it("accepts negative values (refunds are negative amounts)", () => {
		expect(StreamPayAmount.toHalalat("-5.25")).toBe(-525);
	});

	it("throws on NaN / Infinity / non-numeric strings", () => {
		expect(() => StreamPayAmount.toHalalat("abc")).toThrow(RangeError);
		expect(() => StreamPayAmount.toHalalat(Number.NaN)).toThrow(RangeError);
		expect(() => StreamPayAmount.toHalalat(Number.POSITIVE_INFINITY)).toThrow(RangeError);
		expect(() => StreamPayAmount.toHalalat(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
	});
});

describe("StreamPayAmount.toSAR", () => {
	it("formats integer halalat to a fixed-2-decimal SAR string", () => {
		expect(StreamPayAmount.toSAR(1050)).toBe("10.50");
		expect(StreamPayAmount.toSAR(100)).toBe("1.00");
		expect(StreamPayAmount.toSAR(0)).toBe("0.00");
		expect(StreamPayAmount.toSAR(-525)).toBe("-5.25");
	});

	it("pads short amounts with a leading zero", () => {
		expect(StreamPayAmount.toSAR(5)).toBe("0.05");
		expect(StreamPayAmount.toSAR(99)).toBe("0.99");
	});

	it("rejects non-integer halalat inputs", () => {
		expect(() => StreamPayAmount.toSAR(1.5)).toThrow(RangeError);
		expect(() => StreamPayAmount.toSAR(Number.NaN)).toThrow(RangeError);
		expect(() => StreamPayAmount.toSAR(Number.POSITIVE_INFINITY)).toThrow(RangeError);
	});

	it("round-trips with toHalalat for SAR strings with 2 decimals", () => {
		for (const sar of ["0.00", "0.05", "1.00", "10.50", "999.99"]) {
			expect(StreamPayAmount.toSAR(StreamPayAmount.toHalalat(sar))).toBe(sar);
		}
	});
});
