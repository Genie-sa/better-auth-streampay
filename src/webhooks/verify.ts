import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * StreamPay signs webhook requests with the `X-Webhook-Signature` header
 * formatted as `t=<unix-timestamp>,v1=<hex-hmac>`, where the HMAC is
 * `HMAC_SHA256(secret, "${timestamp}.${rawBody}")`.
 *
 * Source: https://docs.streampay.sa/webhooks#verifying-webhook-authenticity
 *
 * This module deliberately exports a small, pure function: it takes the raw
 * body (as a string) plus the header values and returns a result object.
 * Keeping it pure means the webhook endpoint can hand it real data from
 * `Request` while the tests drive it directly.
 */

export interface VerifyWebhookInput {
	secret: string;
	rawBody: string;
	signatureHeader: string | null | undefined;
	/**
	 * Maximum allowed age of the signature, in seconds. Defaults to 5
	 * minutes as a conservative replay-protection window.
	 */
	toleranceSeconds?: number;
	/** Hook for tests to freeze the clock. */
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

/**
 * Parse the `t=...,v1=...` header into its two parts. Extra fields (e.g.
 * StreamPay adds a `v2` in the future) are tolerated and ignored.
 */
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

export function verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
	const { secret, rawBody, signatureHeader } = input;
	const toleranceSeconds = input.toleranceSeconds ?? 300;
	const now = input.now ?? (() => Math.floor(Date.now() / 1000));

	if (!signatureHeader) return { ok: false, reason: "MISSING_HEADER" };
	const parsed = parseSignatureHeader(signatureHeader);
	if (!parsed) return { ok: false, reason: "MALFORMED_HEADER" };

	const ts = Number(parsed.timestamp);
	if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) {
		return { ok: false, reason: "INVALID_TIMESTAMP" };
	}

	const delta = Math.abs(now() - ts);
	if (delta > toleranceSeconds) return { ok: false, reason: "EXPIRED" };

	const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${rawBody}`).digest();
	const provided = hexDecode(parsed.signature);
	if (!provided || provided.length !== expected.length) {
		return { ok: false, reason: "INVALID_SIGNATURE" };
	}
	if (!timingSafeEqual(expected, provided)) {
		return { ok: false, reason: "INVALID_SIGNATURE" };
	}

	return { ok: true, timestamp: ts };
}

/**
 * Convenience: `verifyWebhook` but throws on failure so the webhook
 * endpoint can rely on a single try/catch.
 */
export function verifyWebhookOrThrow(input: VerifyWebhookInput): number {
	const result = verifyWebhook(input);
	if (!result.ok) throw new StreamPayWebhookError(result.reason);
	return result.timestamp;
}
