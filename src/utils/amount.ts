export const StreamPayAmount = {
	toHalalat(sar: string | number): number {
		const asNumber = typeof sar === "string" ? Number(sar) : sar;
		if (!Number.isFinite(asNumber)) {
			throw new RangeError(`StreamPayAmount.toHalalat: invalid SAR value ${String(sar)}`);
		}
		const absoluteHalalat = Math.round(Number(`${Math.abs(asNumber)}e2`));
		const halalat = Math.sign(asNumber) * absoluteHalalat;
		if (!Number.isSafeInteger(halalat)) {
			throw new RangeError(`StreamPayAmount.toHalalat: SAR value is outside the safe range`);
		}
		return halalat;
	},

	toSAR(halalat: number): string {
		if (!Number.isFinite(halalat) || !Number.isInteger(halalat)) {
			throw new RangeError(`StreamPayAmount.toSAR: expected integer halalat, got ${halalat}`);
		}
		return (halalat / 100).toFixed(2);
	},
} as const;
