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

const MAX_SIGNATURE_HEADER_LENGTH = 1024;
const MAX_SIGNATURE_HEADER_FIELDS = 16;

function parseSignatureHeader(header: string): { timestamp: string; signatures: Buffer[] } | null {
	if (header.length > MAX_SIGNATURE_HEADER_LENGTH) return null;
	const parts = header.split(",");
	if (parts.length > MAX_SIGNATURE_HEADER_FIELDS) return null;

	let timestamp: string | undefined;
	let hasSignature = false;
	const signatures: Buffer[] = [];
	for (const part of parts) {
		const [key, ...rest] = part.trim().split("=");
		const value = rest.join("=");
		if (key === "t") {
			if (timestamp !== undefined) return null;
			timestamp = value;
		}
		if (key === "v1" && value) {
			hasSignature = true;
			if (/^[0-9a-fA-F]{64}$/.test(value)) signatures.push(Buffer.from(value, "hex"));
		}
	}
	if (!timestamp || !hasSignature) return null;
	return { timestamp, signatures };
}

export function verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
	const { rawBody, signatureHeader } = input;
	const toleranceSeconds = input.toleranceSeconds ?? 300;
	const now = input.now ?? (() => Math.floor(Date.now() / 1000));
	const secrets = (typeof input.secret === "string" ? [input.secret] : input.secret).filter(
		(secret) => secret.length > 0,
	);

	if (!signatureHeader) return { ok: false, reason: "MISSING_HEADER" };
	const parsed = parseSignatureHeader(signatureHeader);
	if (!parsed) return { ok: false, reason: "MALFORMED_HEADER" };

	const ts = Number(parsed.timestamp);
	if (!/^[0-9]+$/.test(parsed.timestamp) || !Number.isSafeInteger(ts) || ts <= 0) {
		return { ok: false, reason: "INVALID_TIMESTAMP" };
	}

	const delta = Math.abs(now() - ts);
	if (delta > toleranceSeconds) return { ok: false, reason: "EXPIRED" };

	if (parsed.signatures.length === 0) return { ok: false, reason: "INVALID_SIGNATURE" };

	for (const secret of secrets) {
		const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${rawBody}`).digest();
		if (parsed.signatures.some((provided) => timingSafeEqual(expected, provided))) {
			return { ok: true, timestamp: ts };
		}
	}

	return { ok: false, reason: "INVALID_SIGNATURE" };
}

export function verifyWebhookOrThrow(input: VerifyWebhookInput): number {
	const result = verifyWebhook(input);
	if (!result.ok) throw new StreamPayWebhookError(result.reason);
	return result.timestamp;
}
