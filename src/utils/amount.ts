/**
 * StreamPay represents money as decimal SAR strings (`"10.50"`). We
 * convert to integer halalat (1 SAR = 100 halalat) at this boundary so
 * the rest of the code is drift-free.
 */
export const StreamPayAmount = {
	toHalalat(sar: string | number): number {
		const asNumber = typeof sar === "string" ? Number(sar) : sar;
		if (!Number.isFinite(asNumber)) {
			throw new RangeError(`StreamPayAmount.toHalalat: invalid SAR value ${String(sar)}`);
		}
		return Math.round(asNumber * 100);
	},

	toSAR(halalat: number): string {
		if (!Number.isFinite(halalat) || !Number.isInteger(halalat)) {
			throw new RangeError(`StreamPayAmount.toSAR: expected integer halalat, got ${halalat}`);
		}
		return (halalat / 100).toFixed(2);
	},
} as const;
