import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyWebhookInput {
	secret: string | readonly string[];
	rawBody: string;
	signatureHeader: string | null | undefined;
	toleranceSeconds?: number;
	now?: () => number;
}

export type VerifyWebhookResult =
	| { ok: true; timestamp: number }
	| { ok: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
	| "MISSING_HEADER"
	| "MALFORMED_HEADER"
	| "INVALID_TIMESTAMP"
	| "EXPIRED"
	| "INVALID_SIGNATURE";

export class StreamPayWebhookError extends Error {
	public readonly reason: VerifyFailureReason;
	constructor(reason: VerifyFailureReason, message?: string) {
		super(message ?? reason);
		this.name = "StreamPayWebhookError";
		this.reason = reason;
	}
}

function parseSignatureHeader(header: string): { timestamp: string; signature: string } | null {
	const parts = header.split(",");
	let timestamp: string | undefined;
	let signature: string | undefined;
	for (const part of parts) {
		const [key, ...rest] = part.trim().split("=");
		const value = rest.join("=");
		if (key === "t") timestamp = value;
		else if (key === "v1") signature = value;
	}
	if (!timestamp || !signature) return null;
	return { timestamp, signature };
}

function hexDecode(hex: string): Buffer | null {
	if (hex.length === 0 || hex.length % 2 !== 0) return null;
	if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
	return Buffer.from(hex, "hex");
}

/** Verify a StreamPay webhook signature against the raw body. Returns a result object; never throws. */
export function verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
	const { rawBody, signatureHeader } = input;
	const toleranceSeconds = input.toleranceSeconds ?? 300;
	const now = input.now ?? (() => Math.floor(Date.now() / 1000));
	const secrets = typeof input.secret === "string" ? [input.secret] : input.secret;

	if (!signatureHeader) return { ok: false, reason: "MISSING_HEADER" };
	const parsed = parseSignatureHeader(signatureHeader);
	if (!parsed) return { ok: false, reason: "MALFORMED_HEADER" };

	const ts = Number(parsed.timestamp);
	if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) {
		return { ok: false, reason: "INVALID_TIMESTAMP" };
	}

	const delta = Math.abs(now() - ts);
	if (delta > toleranceSeconds) return { ok: false, reason: "EXPIRED" };

	const provided = hexDecode(parsed.signature);
	if (!provided) return { ok: false, reason: "INVALID_SIGNATURE" };

	for (const secret of secrets) {
		const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${rawBody}`).digest();
		if (provided.length !== expected.length) continue;
		if (timingSafeEqual(expected, provided)) return { ok: true, timestamp: ts };
	}

	return { ok: false, reason: "INVALID_SIGNATURE" };
}

/** Like `verifyWebhook` but throws `StreamPayWebhookError` on failure; returns the signed timestamp on success. */
export function verifyWebhookOrThrow(input: VerifyWebhookInput): number {
	const result = verifyWebhook(input);
	if (!result.ok) throw new StreamPayWebhookError(result.reason);
	return result.timestamp;
}
