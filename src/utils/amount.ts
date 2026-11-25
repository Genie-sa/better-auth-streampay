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

function minorUnitExponent(currency: string | null | undefined): number | null {
	switch (currency) {
		case "BHD":
		case "KWD":
		case "OMR":
			return 3;
		case "SAR":
		case "USD":
		case "EUR":
		case "GBP":
		case "AED":
		case "QAR":
			return 2;
		default:
			return null;
	}
}

export function amountToSmallestUnit(
	value: string | null | undefined,
	currency: string | null | undefined,
): number | null {
	if (!value) return null;
	const exponent = minorUnitExponent(currency);
	if (exponent === null) return null;
	const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
	if (!match) return null;
	const [, sign, integer, fraction = ""] = match;
	if (!integer) return null;
	const excessFraction = fraction.slice(exponent);
	if (excessFraction && !/^0+$/.test(excessFraction)) return null;
	const normalizedFraction = fraction.slice(0, exponent).padEnd(exponent, "0");
	const factor = 10n ** BigInt(exponent);
	const unsigned = BigInt(integer) * factor + BigInt(normalizedFraction || "0");
	const signed = sign === "-" ? -unsigned : unsigned;
	const numeric = Number(signed);
	return Number.isSafeInteger(numeric) ? numeric : null;
}
